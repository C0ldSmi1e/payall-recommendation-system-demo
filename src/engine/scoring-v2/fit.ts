/**
 * scoring-v2 · Fit 层（用户 × 卡）
 *
 * 维度映射（见 README "二、十个维度 · 用户个性化层"）：
 *   - RCU · Realized Cashback                   → computeRealizedCashback
 *   - MonetaryUplift normalize (log1p)          → normalizeMonetaryUpliftLog  (G6)
 *   - FF  · Feature Fit                         → computeFeatureFit
 *   - CO  · Complementarity                     → computeComplementarity
 *   - LCF · Location / Compliance Fit           → computeLocationFit
 *   - PF  · Personal Friction                   → computePersonalFriction
 *   - ABR_user · user-conditional approval prob → computeApprovalProbForUser
 *
 * 全部 pure functions，显式依赖通过参数传入。
 */

import type { Card, User } from "../../types";
import type { V2Context, V2Fit } from "./types";
import { assertRange01, clamp01 } from "./invariants";

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

interface CashbackRule { name?: string; maxRate?: number; minRate?: number; assets?: string[] }
interface FeeEntry { type?: string; value?: number }
interface FeesStruct {
  annualFee?: FeeEntry; monthlyFee?: FeeEntry;
  fxFee?: FeeEntry; atmFee?: FeeEntry; topupFee?: FeeEntry;
}

// ---- RCU · Realized Cashback ----
//
// 设计点: README §二 → RCU （当前系统最大缺失）
//
// 根据用户真实 transaction_history 的 MCC 分布，逐条套用卡的分级返现，
// 乘以该类目占比 × monthly_spend_usd，再按 monthly cap 截断。
//
// 如果用户没有 transaction_history，退回 `cashback_max × monthly_spend × 0.6`
// （0.6 是"headline vs effective rate"经验折扣，来自 payall 行业常识）。
//
// 返回 USD/月
export function computeRealizedCashback(card: Card, user: User): number {
  const rules = parseJson<CashbackRule[]>(card.cashback, []);
  const headlineMax = parseFloat(card.cashback_max || "0") || 0;
  const monthlySpend = user.monthly_spend_usd;

  // 无 txn 历史：用 headline 打 6 折
  if (!user.transaction_history || user.transaction_history.length === 0) {
    return Math.max(0, monthlySpend * (headlineMax / 100) * 0.6);
  }

  // 按类目聚合近 90 天 txn（此处简化为全部）
  const catTotals: Record<string, number> = {};
  let grandTotal = 0;
  for (const t of user.transaction_history) {
    catTotals[t.category] = (catTotals[t.category] ?? 0) + t.amount_usd;
    grandTotal += t.amount_usd;
  }
  if (grandTotal <= 0) {
    return Math.max(0, monthlySpend * (headlineMax / 100) * 0.6);
  }

  // 把每个类目占比 × monthly_spend，套到最匹配的 rule 上
  let cashback = 0;
  for (const [cat, amt] of Object.entries(catTotals)) {
    const share = amt / grandTotal;
    const userSpendInCat = monthlySpend * share;
    const rate = matchCategoryRate(cat, rules, headlineMax);
    cashback += userSpendInCat * (rate / 100);
  }

  // cap 截断：从 card.limits 里提取 "$N/month" 数字
  const cap = extractMonthlyCap(card);
  if (cap !== null && cashback > cap) cashback = cap;

  return Math.max(0, cashback);
}

/**
 * 把用户类目（如 "dining"/"online_shopping"）匹配到 cashback rule。
 * 简单关键词匹配，未命中则给 "all other" / headlineMin / 1%。
 */
function matchCategoryRate(category: string, rules: CashbackRule[], fallback: number): number {
  const c = category.toLowerCase();
  // 常见映射关键词
  const aliases: Record<string, string[]> = {
    dining: ["dining", "restaurant", "food"],
    groceries: ["grocer", "supermarket"],
    travel: ["travel", "hotel", "airline", "transit", "rideshare", "taxi", "gas", "ev"],
    online_shopping: ["online", "ecommerce", "shopping"],
    subscription: ["subscription", "streaming"],
    atm: ["atm", "withdrawal"],
  };

  for (const rule of rules) {
    if (!rule.name) continue;
    const name = rule.name.toLowerCase();
    const keywords = aliases[c] ?? [c];
    if (keywords.some(k => name.includes(k))) {
      return (rule.minRate ?? rule.maxRate ?? 0);
    }
  }

  // 找 "all other purchases" 之类
  const fallbackRule = rules.find(r => /other|all\s|base/.test(r.name?.toLowerCase() ?? ""));
  if (fallbackRule) return (fallbackRule.minRate ?? fallbackRule.maxRate ?? 0);

  // 没匹配到，用 cashback_max 的 50%（保守）
  return fallback * 0.5;
}

/** 从 card.limits 提取 monthly cap（如 "$300/month" → 300）。返回 null 表示无 cap。 */
function extractMonthlyCap(card: Card): number | null {
  const text = (card.limits || "").replace(/,/g, "");
  const m = text.match(/\$?(\d{2,5})\s*(?:\/|per)\s*month/i);
  if (m) return parseFloat(m[1]);
  return null;
}

// ---- MonetaryUplift normalize · G6 ----
//
// 设计点: README §七 → G6 log1p 归一（不再用 SAVINGS_CEILING_USD = 50 的硬上限）
//
// 公式: log1p(max(0, netUplift)) / log1p(REF)
// 其中 netUplift = RCU - current_best_cashback_of_user - annualized_fee_burden_per_month
export function normalizeMonetaryUpliftLog(
  RCU_usd: number,
  currentBestCashbackUsd: number,
  feeBurdenPerMonth: number,
  referenceUpliftUsd: number,
): number {
  const net = Math.max(0, RCU_usd - currentBestCashbackUsd - feeBurdenPerMonth);
  const norm = Math.log1p(net) / Math.log1p(Math.max(1, referenceUpliftUsd));
  return assertRange01("MonetaryUplift", clamp01(norm));
}

// ---- FF · Feature Fit ----
//
// 设计点: README §二 → FF；修复 v1 里的"priorities 双算"bug
// 与 v1 不同：priorities **不进** FF 分母，只通过 FACTOR_MAP 影响维度权重。
// 返回 [0, 1]
export function computeFeatureFit(card: Card, user: User): number {
  let needs = 0;
  let met = 0;

  // 硬需求：支付方式
  const mark = (needed: boolean, cardHas: boolean) => {
    if (!needed) return;
    needs++;
    if (cardHas) met++;
  };

  mark(user.needs_apple_pay, card.apple_wallet_support === 1);
  mark(user.needs_google_pay, card.google_pay_support === 1);
  mark(user.needs_wechat_pay, card.wechat_pay_support === 1);
  mark(user.needs_alipay, card.alipay_support === 1);

  // 卡形态
  mark(user.wants_physical_card, card.has_physical_card === 1);
  mark(user.wants_virtual_card, card.has_virtual_card === 1);

  // ATM
  mark(user.primary_use?.includes("atm_withdrawal") ?? false, card.atm_withdrawal_support === 1);

  // Crypto topup
  if (user.preferred_topup_crypto) {
    needs++;
    const cryptos = parseJson<string[]>(card.based_crypto, []);
    if (cryptos.some(c => c.toUpperCase().includes(user.preferred_topup_crypto!.toUpperCase()))) met++;
  }

  // 法币匹配
  if (user.preferred_currency) {
    needs++;
    const currencies = parseJson<string[]>(card.based_currency, []);
    if (currencies.includes(user.preferred_currency)) met++;
  }

  if (needs === 0) return assertRange01("FF", 0.5); // 中性
  return assertRange01("FF", met / needs);
}

// ---- CO · Complementarity ----
//
// 设计点: README §二 → CO；修复 v1 的 "0.3 floor" 太高、"0.8 for new user" 太粗
// 返回 [0, 1]
export function computeComplementarity(card: Card, user: User, ownedCards: Card[]): number {
  if (ownedCards.length === 0) {
    // 新用户：给 0.7（比 v1 的 0.8 稍低；给 RCU/FF 留出差异空间）
    return assertRange01("CO", 0.7);
  }

  // 计算 gap 填补率。列出可能的 gap：payment methods、atm、MCC（近似用 cashback rule 名）
  const gapTypes: Array<{ userNeeds: boolean; ownedHas: boolean; cardHas: boolean }> = [];

  const anyOwnedHas = (pred: (c: Card) => boolean) => ownedCards.some(pred);

  gapTypes.push({
    userNeeds: user.needs_apple_pay,
    ownedHas: anyOwnedHas(c => c.apple_wallet_support === 1),
    cardHas: card.apple_wallet_support === 1,
  });
  gapTypes.push({
    userNeeds: user.needs_google_pay,
    ownedHas: anyOwnedHas(c => c.google_pay_support === 1),
    cardHas: card.google_pay_support === 1,
  });
  gapTypes.push({
    userNeeds: user.needs_wechat_pay,
    ownedHas: anyOwnedHas(c => c.wechat_pay_support === 1),
    cardHas: card.wechat_pay_support === 1,
  });
  gapTypes.push({
    userNeeds: user.needs_alipay,
    ownedHas: anyOwnedHas(c => c.alipay_support === 1),
    cardHas: card.alipay_support === 1,
  });
  gapTypes.push({
    userNeeds: user.primary_use?.includes("atm_withdrawal") ?? false,
    ownedHas: anyOwnedHas(c => c.atm_withdrawal_support === 1),
    cardHas: card.atm_withdrawal_support === 1,
  });

  // Cashback upgrade
  const ownedBestCb = Math.max(0, ...ownedCards.map(c => parseFloat(c.cashback_max || "0") || 0));
  const thisCb = parseFloat(card.cashback_max || "0") || 0;
  gapTypes.push({
    userNeeds: true, // cashback 永远是 need-ish
    ownedHas: ownedBestCb >= thisCb,
    cardHas: thisCb > ownedBestCb,
  });

  let gapsFilled = 0;
  let totalGaps = 0;
  for (const g of gapTypes) {
    if (!g.userNeeds) continue;
    totalGaps++;
    if (!g.ownedHas && g.cardHas) gapsFilled++;
  }

  if (totalGaps === 0) return assertRange01("CO", 0.5);
  // 完全重复 → 0.1（不再是 0.3）；完全互补 → 1.0
  const ratio = gapsFilled / totalGaps;
  return assertRange01("CO", clamp01(0.1 + 0.9 * ratio));
}

// ---- LCF · Location × Compliance Fit ----
//
// 设计点: README §二 → LCF（不是二元，把"可申请但通过率低"也纳入）
// 返回 [0, 1]
//
// 硬不合规（disallowed）应该已被 G1 过滤；这里再做一次 defense + 把 ABR_user 作为 soft 信号。
export function computeLocationFit(card: Card, user: User, inferredCountry: string, ABR_user: number): number {
  const disallowed = parseJson<string[]>(card.disallowed_countries, []).map(c => c.toUpperCase());

  const userCountries = [user.country?.toUpperCase(), user.current_location?.toUpperCase(), inferredCountry?.toUpperCase()]
    .filter(Boolean) as string[];

  // defense：如果已经有 user country 在 disallowed，给 0（理论上不该到这里）
  if (userCountries.some(c => disallowed.includes(c))) return assertRange01("LCF", 0);

  // 基础分 0.75，用 ABR_user 调节
  const base = 0.5 + 0.5 * ABR_user;
  return assertRange01("LCF", base);
}

// ---- PF · Personal Friction ----
//
// 设计点: README §二 → PF（替代 v1 里被硬编码到 activation 的 KYC penalty）
// 返回 [0, 1]，越高越费劲
export function computePersonalFriction(card: Card, user: User): number {
  let friction = 0;

  // KYC
  if (card.kyc_required === 1) {
    if (user.kyc_verified) friction += 0.15; // 已 verified，仍需要为该卡补材料
    else friction += 0.55; // 从头做
  }

  // 无 virtual card → 必须等实体卡
  if (card.has_virtual_card === 0 && user.wants_virtual_card) friction += 0.15;

  // can_apply = 0 → 现在申请不了
  if (card.can_apply === 0) friction += 0.10;

  // topup 路径不匹配
  if (user.preferred_topup_crypto) {
    const cryptos = parseJson<string[]>(card.based_crypto, []);
    if (!cryptos.some(c => c.toUpperCase().includes(user.preferred_topup_crypto!.toUpperCase()))) {
      friction += 0.10;
    }
  }

  // friction_budget 是用户声称的容忍度（也可以反向映射，但这里只记录事实 PF，用户侧的"容忍度"走权重）
  return assertRange01("PF", clamp01(friction));
}

// ---- ABR_user · approval prob for this (card, country, kyc) ----
//
// 设计点: README §六 → Bayesian ABR from feedback
// 返回 [0, 1]
export function computeApprovalProbForUser(card: Card, user: User, ctx: V2Context): number {
  const country = (user.country || user.current_location || "").toUpperCase();
  const kycBucket = user.kyc_verified ? "v" : "u";
  const key = `${card.id}|${country}|${kycBucket}`;
  const stats = ctx.approvalStats[key];
  const prior = { alpha: 2, beta: 2 }; // Beta(2,2) = neutral 0.5

  if (stats) {
    return assertRange01("ABR_user",
      (stats.alpha + prior.alpha) / (stats.alpha + stats.beta + prior.alpha + prior.beta),
    );
  }
  // 退回到 issuer/card 级 + kyc 先验调整
  const base = ctx.issuerTrust[(card.vendor || "").toLowerCase()] ?? 0.7;
  const kycAdj = card.kyc_required === 1 && !user.kyc_verified ? 0.85 : 1.0;
  return assertRange01("ABR_user", clamp01(base * kycAdj));
}

// ---- 把 fee 转成每月等效美元（给 normalizeMonetaryUpliftLog 用） ----
export function estimateMonthlyFeeBurdenUsd(card: Card, ctx: V2Context): number {
  const fees = parseJson<FeesStruct>(card.fees, {});
  const monthlySpend = ctx.referenceMonthlySpendUsd;
  const annual = (fees.annualFee?.value || 0);
  const monthly = (fees.monthlyFee?.value || 0) * 12;
  const topupRate = (fees.topupFee?.type === "percentage" ? (fees.topupFee.value || 0) : 0) / 100;
  const topup = monthlySpend * 12 * topupRate;
  const fxRate = (fees.fxFee?.type === "percentage" ? (fees.fxFee.value || 0) : 0) / 100;
  const fx = monthlySpend * 12 * 0.15 * fxRate;
  return Math.max(0, (annual + monthly + topup + fx) / 12);
}

// ---- Build fit object ----
export function buildFit(card: Card, user: User, inferredCountry: string, ownedCards: Card[], ctx: V2Context): V2Fit {
  const RCU_usd = computeRealizedCashback(card, user);
  const currentBest = Math.max(0, ...ownedCards.map(c => {
    const max = parseFloat(c.cashback_max || "0") || 0;
    return user.monthly_spend_usd * (max / 100) * 0.6; // 用 6 折 baseline 估当前 cashback
  }));
  const feeBurdenPerMonth = estimateMonthlyFeeBurdenUsd(card, ctx);
  const RCU_norm = normalizeMonetaryUpliftLog(RCU_usd, currentBest, feeBurdenPerMonth, ctx.referenceUpliftUsd);

  const FF = computeFeatureFit(card, user);
  const CO = computeComplementarity(card, user, ownedCards);
  const ABR_user = computeApprovalProbForUser(card, user, ctx);
  const LCF = computeLocationFit(card, user, inferredCountry, ABR_user);
  const PF = computePersonalFriction(card, user);

  return { RCU_usd, RCU_norm, FF, CO, LCF, PF, ABR_user };
}
