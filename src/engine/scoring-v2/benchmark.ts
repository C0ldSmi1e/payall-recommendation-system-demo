/**
 * scoring-v2 · Benchmark 层（客观卡评级，与用户无关）
 *
 * 维度映射（见 README "二、十个维度 · 客观基准层"）：
 *   - IRS = computeIssuerReputation
 *   - CP  = computeCashbackPotential
 *   - FB  = computeFeeBurden
 *   - RCR = computeContinuityRisk
 *   - ABR_base = computeApprovalBaseRate (issuer-level 部分；用户维度部分在 fit.ts)
 *
 * 所有函数都是**纯函数**：相同输入 → 相同输出，无副作用。
 * 结果可缓存，每周离线刷新一次即可。
 */

import type { Card } from "../../types";
import type { V2Benchmark, V2Context } from "./types";
import { assertRange01, assertScore, clamp01 } from "./invariants";

// ---- JSON 解析工具（防御性） ----
function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

interface FeeEntry { type?: string; value?: number; currency?: string }
interface FeesStruct {
  annualFee?: FeeEntry;
  monthlyFee?: FeeEntry;
  fxFee?: FeeEntry;
  atmFee?: FeeEntry;
  topupFee?: FeeEntry;
  issuanceFee?: FeeEntry;
  transactionFee?: FeeEntry;
}

interface CashbackRule { name?: string; maxRate?: number; minRate?: number; assets?: string[] }

// ---- IRS · Issuer Reputation ----
// 综合：general_ratings（用户侧评测聚合）+ 动态 issuer trust prior + privacy_ratings（只对 "privacy" 类卡加成）
//
// 设计点: README §二 → IRS
// 数据来源:
//   static: card.general_ratings (0..100), privacy_ratings (0..100)
//   dynamic: ctx.issuerTrust[vendor] (0..1), 由反馈层回写
//
// 返回 [0, 1]
export function computeIssuerReputation(card: Card, ctx: V2Context): number {
  const staticPart = clamp01((card.general_ratings ?? 50) / 100);
  const privacyPart = clamp01((card.privacy_ratings ?? 50) / 100);

  // 动态部分：issuer 粒度的历史通过率/客诉（反馈回写）
  const vendorKey = (card.vendor || "").toLowerCase();
  const dynamic = ctx.issuerTrust[vendorKey];

  // 合成（加权）：static 0.55、privacy 0.10、dynamic 0.35（若有）
  let score: number;
  if (typeof dynamic === "number") {
    score = 0.55 * staticPart + 0.10 * privacyPart + 0.35 * clamp01(dynamic);
  } else {
    // 没有动态数据，退回 static 0.85 + privacy 0.15
    score = 0.85 * staticPart + 0.15 * privacyPart;
  }

  return assertRange01("IRS", score);
}

// ---- CP · Cashback Potential ----
// 不是看用户能拿多少（那是 RCU 的事），而是看卡的 cashback 设计有多强：
//   - headline 最高返现率（按 0..8% 归一）
//   - MCC 覆盖广度
//   - cap 宽松度（从 limits 里文字检测 capped 关键词）
//   - 是否需 staking（需要则 × 0.6 惩罚）
//
// 设计点: README §二 → CP
// 返回 [0, 1]
export function computeCashbackPotential(card: Card): number {
  const rules = parseJson<CashbackRule[]>(card.cashback, []);
  const headlineMax = Math.max(
    0,
    parseFloat(card.cashback_max || "0") || 0,
    ...rules.map(r => r.maxRate ?? 0),
  );

  // headline 归一：8% 封顶（payall 宣称 "up to 8%"，以此为天花板参考）
  const rateTerm = clamp01(headlineMax / 8);

  // MCC breadth：规则数越多 → 覆盖越广（最多记 5 档）
  const breadth = clamp01(rules.length / 5);

  // cap 宽松度：在 limits 文字里找 "cap"/"capped"/"limit" 关键词出现次数越多，cap 越苛刻
  const limitsText = (card.limits || "").toLowerCase();
  const capHits = (limitsText.match(/cap(?:ped)?|capped\s+at|\$\d+\s*\/\s*month|monthly\s+limit/g) || []).length;
  const capGenerosity = clamp01(1 - capHits / 3); // 3 次命中以上 → 非常苛刻

  // staking 检测：limits/intro 里有 "stake"/"staking"/"locked" 关键词
  const fullText = `${card.limits || ""} ${card.intro || ""} ${card.summary || ""}`.toLowerCase();
  const needsStaking = /stak(e|ing)|locked|hold\s+\$|minimum\s+balance/.test(fullText);
  const stakingPenalty = needsStaking ? 0.4 : 0; // staking 卡打 6 折

  const raw = 0.60 * rateTerm + 0.25 * breadth + 0.15 * capGenerosity;
  const cp = raw * (1 - stakingPenalty);

  return assertRange01("CP", cp);
}

// ---- FB · Fee Burden ----
// 把所有 fee 折算成"每年/每月 $3k 消费" 等效美元成本，然后归一。
//
// 参考 ctx.referenceMonthlySpendUsd（默认 $3000）作为 "typical 用户"。
// 归一上限：$500/年。即年费总成本达到 $500 记为 FB = 1。
//
// 设计点: README §二 → FB；修复 v1 "忽略年费" 的 bug
// 返回 [0, 1]，越高越差
export function computeFeeBurden(card: Card, ctx: V2Context): number {
  const fees = parseJson<FeesStruct>(card.fees, {});
  const monthlySpend = ctx.referenceMonthlySpendUsd;

  // 年化固定费用
  const annual = (fees.annualFee?.value || 0);
  const monthly = (fees.monthlyFee?.value || 0) * 12;
  const issuance = (fees.issuanceFee?.value || 0) / 3; // 摊到 3 年

  // 消费产生的百分比费用
  // topup 假设月充值 1× 月消费
  const topupFeeRate = (fees.topupFee?.type === "percentage" ? (fees.topupFee.value || 0) : 0) / 100;
  const topupAnnual = monthlySpend * 12 * topupFeeRate;

  // FX 费用：假设 15% 跨境
  const fxFeeRate = (fees.fxFee?.type === "percentage" ? (fees.fxFee.value || 0) : 0) / 100;
  const fxAnnual = monthlySpend * 12 * 0.15 * fxFeeRate;

  // ATM 费用：假设月 2 次取现 × $300
  const atmFeeRate = (fees.atmFee?.type === "percentage" ? (fees.atmFee.value || 0) : 0) / 100;
  const atmAnnual = 2 * 12 * 300 * atmFeeRate;

  const totalAnnual = annual + monthly + issuance + topupAnnual + fxAnnual + atmAnnual;

  // 归一到 $500
  const burden = clamp01(totalAnnual / 500);
  return assertRange01("FB", burden);
}

// ---- RCR · Regulatory / Continuity Risk ----
// 初版：基于 disallowed 国家列表广度 + vendor 类型 + KYC 要求做启发式。
// 未来挂 webhook 后可用真实新闻/公告事件。
//
// 设计点: README §二 → RCR
// 返回 [0, 1]，越高越差
export function computeContinuityRisk(card: Card): number {
  const disallowed = parseJson<string[]>(card.disallowed_countries, []);

  // 禁用国家越多 → 通常监管压力越大（非绝对，但是合理先验）
  const disallowedPressure = clamp01(disallowed.length / 40); // 40+ 国家算高压

  // can_apply = 0 是现在就不能申请的信号，这不是 risk 的长期信号但短期增加不确定性
  const canApply = card.can_apply === 1 ? 0 : 0.2;

  // is_deleted 的卡理论上已被 G1 过滤，但 defensively 给 1.0
  if (card.is_deleted === 1) return 1.0;

  // 评测低分也是 risk 信号
  const ratingRisk = clamp01(1 - (card.general_ratings ?? 50) / 100) * 0.3;

  const rcr = clamp01(disallowedPressure * 0.5 + canApply + ratingRisk);
  return assertRange01("RCR", rcr);
}

// ---- ABR_base · Approval Base Rate (issuer-level) ----
// 用户维度的 ABR（按国家×KYC 分桶）在 fit.ts 的 computeApprovalProbForUser 里算；
// 这里只给 issuer/card 级别的基础率。
//
// 设计点: README §二 → ABR，§六 Bayesian
// 返回 [0, 1]
export function computeApprovalBaseRate(card: Card, ctx: V2Context): number {
  // 先从 approvalStats 里找 card 级别的聚合（忽略 country/kyc key 的情况，用 key = "cardId"）
  const key = `${card.id}|*|*`;
  const stats = ctx.approvalStats[key];
  if (stats && (stats.alpha + stats.beta) > 0) {
    // Bayesian posterior mean with prior Beta(2, 2) = 0.5
    const prior = { alpha: 2, beta: 2 };
    const post = { alpha: stats.alpha + prior.alpha, beta: stats.beta + prior.beta };
    return assertRange01("ABR_base", post.alpha / (post.alpha + post.beta));
  }

  // 无数据 → 用 KYC/rating 启发式
  const ratingPart = clamp01((card.general_ratings ?? 50) / 100);
  const kycPart = card.kyc_required === 1 ? 0.75 : 0.90; // 有 KYC 平均 75%，无 KYC 90%
  const base = 0.5 * ratingPart + 0.5 * kycPart;
  return assertRange01("ABR_base", base);
}

// ---- 合成 BenchmarkScore ----
// 设计文档第六节公式：
//   BenchmarkScore = 100 × (0.30·IRS + 0.30·CP + 0.20·(1-FB) + 0.15·(1-RCR) + 0.05·ABR)
export function computeBenchmarkScore(b: Omit<V2Benchmark, "benchmark_score" | "card_id">): number {
  const raw = 100 * (
    0.30 * b.IRS +
    0.30 * b.CP +
    0.20 * (1 - b.FB) +
    0.15 * (1 - b.RCR) +
    0.05 * b.ABR_base
  );
  return assertScore("benchmark_score", raw);
}

// ---- 一键 build ----
export function buildCardBenchmark(card: Card, ctx: V2Context): V2Benchmark {
  const IRS = computeIssuerReputation(card, ctx);
  const CP = computeCashbackPotential(card);
  const FB = computeFeeBurden(card, ctx);
  const RCR = computeContinuityRisk(card);
  const ABR_base = computeApprovalBaseRate(card, ctx);
  const benchmark_score = computeBenchmarkScore({ IRS, CP, FB, RCR, ABR_base });
  return { card_id: card.id, IRS, CP, FB, RCR, ABR_base, benchmark_score };
}

// ---- Benchmark 缓存（简易：memory map；生产上会落盘到 card_benchmarks 表） ----
const benchmarkCache = new Map<string, V2Benchmark>();

function cacheKey(card: Card, ctx: V2Context): string {
  // issuerTrust 变化会失效；为简便，ctx 签名用 issuerTrust 的长度
  return `${card.id}|${Object.keys(ctx.issuerTrust).length}`;
}

export function getCardBenchmark(card: Card, ctx: V2Context): V2Benchmark {
  const k = cacheKey(card, ctx);
  let b = benchmarkCache.get(k);
  if (!b) {
    b = buildCardBenchmark(card, ctx);
    benchmarkCache.set(k, b);
  }
  return b;
}

export function clearBenchmarkCache(): void {
  benchmarkCache.clear();
}
