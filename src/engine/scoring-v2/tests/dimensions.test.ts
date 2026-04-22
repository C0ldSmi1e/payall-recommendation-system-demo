/**
 * scoring-v2 · 单元测试 · 维度 + 权重 + 护栏
 *
 * 要求（对应 README §九 自验证清单）：
 *   - 所有维度输出必须在 [0,1]
 *   - 所有权重和必须归一到 1
 *   - FACTOR_MAP_V2 每行也应和 ≈ 1（设计约束）
 *   - G1/G2 护栏正确阻断
 *   - log1p 归一对高消费不再撞上限
 *   - 同一张卡在不同 priority 下权重和分数要有明显差异（个性化）
 */
import { test, expect, beforeAll } from "bun:test";
import type { Card, User, UserState, PreferenceProfile } from "../../../types";
import {
  scoreOneCardV2,
  buildV2Context,
  mapPreferencesToWeightsV2,
  FACTOR_MAP_V2,
  V2_DIMENSIONS,
  PROMOTED_CARD_IDS,
} from "../index";
import { computeRealizedCashback, normalizeMonetaryUpliftLog } from "../fit";
import { __resetIssuerTrust } from "../issuer-trust";
import { __resetApprovalStats } from "../approval-rate";

beforeAll(() => {
  // 单测隔离：不加载真正的 seed 数据
  __resetIssuerTrust({});
  __resetApprovalStats({});
  process.env.SCORING_V2_STRICT = "1";
});

// ---- 测试 fixtures ----
function baseCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 999,
    card_name: "TestCard",
    vendor: "TestVendor",
    card_type: '["Visa"]',
    is_credit: 0,
    has_physical_card: 1,
    has_virtual_card: 1,
    kyc_required: 1,
    based_currency: '["USD"]',
    based_crypto: '["USDT","BTC"]',
    cashback: "[]",
    cashback_max: "1.0",
    fees: '{"annualFee":{"type":"flat","value":0},"monthlyFee":{"type":"flat","value":0},"fxFee":{"type":"percentage","value":1.2},"atmFee":{"type":"percentage","value":2.0},"topupFee":{"type":"percentage","value":1.0},"issuanceFee":{"type":"flat","value":10}}',
    spending_limits: '{}',
    atm_withdrawal_support: 1,
    google_pay_support: 1,
    apple_wallet_support: 1,
    wechat_pay_support: 0,
    alipay_support: 0,
    chatgpt_pay_support: 0,
    disallowed_countries: "[]",
    limits: "",
    key_features: "[]",
    summary: "",
    intro: "",
    application_url: "",
    can_apply: 1,
    tags: null,
    is_deleted: 0,
    card_image_large: "",
    vendor_logo: null,
    card_image_thumbnail: "",
    general_ratings: 80,
    benefit_ratings: 80,
    privacy_ratings: 70,
    ...overrides,
  };
}

function baseUser(overrides: Partial<User> = {}): User {
  return {
    id: "test",
    name: "Test",
    description: "",
    country: "USA",
    current_location: "USA",
    kyc_verified: true,
    monthly_spend_usd: 3000,
    primary_use: ["online_shopping"],
    preferred_currency: "USD",
    held_cryptos: ["USDT"],
    preferred_topup_crypto: "USDT",
    wants_physical_card: true,
    wants_virtual_card: true,
    fee_sensitivity: "medium",
    needs_apple_pay: true,
    needs_google_pay: false,
    needs_wechat_pay: false,
    needs_alipay: false,
    priorities: ["cashback"],
    owned_card_ids: [],
    transaction_history: [],
    ...overrides,
  };
}

const EMPTY_USER_STATE: UserState = {
  summary: "", hard_requirements: {
    country: "USA", current_location: "USA", kyc_status: "verified",
    needs_physical: true, needs_virtual: true, payment_methods: ["apple_pay"],
  },
  spending_profile: { monthly_usd: 3000, top_categories: [], spending_pattern: "" },
  preferences: { fee_sensitivity: "medium", priorities_ranked: [], crypto_preferences: [], preferred_topup: "", preferred_currency: "USD" },
  deal_breakers: [], nice_to_haves: [], owned_card_context: "",
  derived_scores: { kyc_friction_tolerance: 0.5, travel_need_score: 0, fee_sensitivity_score: 0.5, instant_need_score: 0, backup_card_need: 0, spending_diversity: 0 },
  journey_position: "new_user", current_mode: "routine", detected_intent: "",
};

const cashbackPrefs: PreferenceProfile = {
  right_now_priorities: [{ factor: "cashback", weight: 1.0 }],
  short_term_intent: "", long_term_intent: "", friction_budget: "medium",
  value_vs_convenience: "value", spending_insights: [], unmet_needs: [],
};

// =====================================================================
// 权重矩阵（G - §四）
// =====================================================================
test("FACTOR_MAP_V2 每行权重和 ≈ 1", () => {
  for (const [factor, row] of Object.entries(FACTOR_MAP_V2)) {
    const sum = (Object.values(row) as number[]).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
  }
});

test("FACTOR_MAP_V2 覆盖全部 10 个维度", () => {
  for (const row of Object.values(FACTOR_MAP_V2)) {
    for (const dim of V2_DIMENSIONS) {
      expect(row[dim]).toBeTypeOf("number");
    }
  }
});

test("未识别 factor 会触发告警，不静默", () => {
  const unknowns: string[] = [];
  const w = mapPreferencesToWeightsV2(
    { ...cashbackPrefs, right_now_priorities: [{ factor: "quick_approval", weight: 1.0 }] },
    (f) => unknowns.push(f),
  );
  expect(unknowns).toEqual(["quick_approval"]);
  // 权重仍然归一
  const sum = (Object.values(w) as number[]).reduce((a, b) => a + b, 0);
  expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
});

// =====================================================================
// 维度范围（invariants）
// =====================================================================
test("所有 trace 维度输出在 [0,1]", () => {
  const card = baseCard();
  const user = baseUser();
  const ctx = buildV2Context();
  const r = scoreOneCardV2({
    card, user, userState: EMPTY_USER_STATE, preferences: cashbackPrefs,
    ownedCards: [], ctx,
  });
  const t = r.trace;
  for (const v of [t.benchmark.IRS, t.benchmark.CP, t.benchmark.FB, t.benchmark.RCR, t.benchmark.ABR_base,
                   t.fit.FF, t.fit.CO, t.fit.LCF, t.fit.PF, t.fit.ABR_user, t.fit.RCU_norm,
                   t.fitFraction, t.monetaryUplift, t.safetyFactor]) {
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  }
  expect(t.display_score).toBeGreaterThanOrEqual(0);
  expect(t.display_score).toBeLessThanOrEqual(100);
});

// =====================================================================
// G1 护栏: 硬约束
// =====================================================================
test("G1 硬约束：deleted 卡被阻断", () => {
  const r = scoreOneCardV2({
    card: baseCard({ is_deleted: 1 }),
    user: baseUser(), userState: EMPTY_USER_STATE, preferences: cashbackPrefs,
    ownedCards: [], ctx: buildV2Context(),
  });
  expect(r.blocked?.hard).toBe("deleted");
  expect(r.display_score).toBe(0);
});

test("G1 硬约束：owned 卡被阻断", () => {
  const r = scoreOneCardV2({
    card: baseCard({ id: 42 }),
    user: baseUser({ owned_card_ids: [42] }),
    userState: EMPTY_USER_STATE, preferences: cashbackPrefs,
    ownedCards: [], ctx: buildV2Context(),
  });
  expect(r.blocked?.hard).toBe("owned");
});

test("G1 硬约束：disallowed country 被阻断", () => {
  const r = scoreOneCardV2({
    card: baseCard({ disallowed_countries: '["USA"]' }),
    user: baseUser({ country: "USA" }),
    userState: EMPTY_USER_STATE, preferences: cashbackPrefs,
    ownedCards: [], ctx: buildV2Context(),
  });
  expect(r.blocked?.hard).toContain("USA");
});

// =====================================================================
// G2 护栏: reputation
// =====================================================================
test("G2: IRS < 0.40 的卡被阻断", () => {
  const r = scoreOneCardV2({
    card: baseCard({ general_ratings: 20, privacy_ratings: 20 }),
    user: baseUser(), userState: EMPTY_USER_STATE, preferences: cashbackPrefs,
    ownedCards: [], ctx: buildV2Context(),
  });
  expect(r.blocked?.reputation).toBeTruthy();
  expect(r.display_score).toBe(0);
});

// =====================================================================
// G3 护栏: Safety 乘法（极差风险压低总分）
// =====================================================================
test("G3: 高返现 + 高 continuity risk → 总分被压低", () => {
  const highCbHighRisk = baseCard({
    id: 101,
    cashback: '[{"name":"All","maxRate":5,"minRate":5}]',
    cashback_max: "5.0",
    general_ratings: 60,
    // 大量 disallowed 国家 → 高 RCR
    disallowed_countries: JSON.stringify(Array.from({length: 45}, (_, i) => `C${i}`)),
    can_apply: 0,
  });
  const highCbLowRisk = baseCard({
    id: 102,
    cashback: '[{"name":"All","maxRate":2,"minRate":2}]',
    cashback_max: "2.0",
    general_ratings: 85,
    disallowed_countries: "[]",
    can_apply: 1,
  });
  const ctx = buildV2Context();
  const user = baseUser();
  const r1 = scoreOneCardV2({ card: highCbHighRisk, user, userState: EMPTY_USER_STATE, preferences: cashbackPrefs, ownedCards: [], ctx });
  const r2 = scoreOneCardV2({ card: highCbLowRisk, user, userState: EMPTY_USER_STATE, preferences: cashbackPrefs, ownedCards: [], ctx });
  // 在 cashback 偏好下，低风险高声誉卡应该赢
  expect(r2.display_score).toBeGreaterThan(r1.display_score);
});

// =====================================================================
// G4 Promoted: Bit2Go 不再在打分里加 bonus
// =====================================================================
test("G4: Bit2Go 没有 +0.05 activation bonus（v1 的硬编码被清除）", () => {
  const bit2go = baseCard({
    id: 23, card_name: "Bit2Go", vendor: "Bit2Go",
    cashback_max: "0.0", cashback: "[]", kyc_required: 0,
    general_ratings: 80,
  });
  const other = baseCard({
    id: 24, card_name: "Other", vendor: "Other",
    cashback_max: "0.0", cashback: "[]", kyc_required: 0,
    general_ratings: 80,
  });
  const ctx = buildV2Context();
  const user = baseUser({ preferred_topup_crypto: "USDT" });
  const r1 = scoreOneCardV2({ card: bit2go, user, userState: EMPTY_USER_STATE, preferences: cashbackPrefs, ownedCards: [], ctx });
  const r2 = scoreOneCardV2({ card: other, user, userState: EMPTY_USER_STATE, preferences: cashbackPrefs, ownedCards: [], ctx });
  // 两张卡结构完全一致 → 分数应该非常接近（±0.5 分）；Bit2Go 不再因为 id 被加分
  expect(Math.abs(r1.display_score - r2.display_score)).toBeLessThan(0.5);
  // 且 Bit2Go 会被标记为 promoted
  expect(PROMOTED_CARD_IDS.has(23)).toBe(true);
});

// =====================================================================
// G6 log1p: 高消费段不再撞上限
// =====================================================================
test("G6: log1p 归一 —— 不同 RCU 下 MonetaryUplift 有差异（不再全部 1.0）", () => {
  // 对应 v1 的 SAVINGS_CEILING_USD = 50 bug
  const n50 = normalizeMonetaryUpliftLog(50, 0, 0, 200);
  const n100 = normalizeMonetaryUpliftLog(100, 0, 0, 200);
  const n200 = normalizeMonetaryUpliftLog(200, 0, 0, 200);
  expect(n50).toBeLessThan(n100);
  expect(n100).toBeLessThan(n200);
  expect(n200).toBeLessThanOrEqual(1);
});

// =====================================================================
// RCU: 分级返现按 MCC 计算
// =====================================================================
test("RCU: 按 MCC 套分级返现", () => {
  const gemini = baseCard({
    id: 35, card_name: "Gemini", vendor: "Gemini",
    cashback: '[{"name":"Gas/EV charging/transit/taxis/rideshare","maxRate":4,"minRate":4},{"name":"Dining","maxRate":3,"minRate":3},{"name":"Groceries","maxRate":2,"minRate":2},{"name":"All other purchases","maxRate":1,"minRate":1}]',
    cashback_max: "4.0",
    limits: "4% category capped at $300/month",
  });
  const diner = baseUser({
    monthly_spend_usd: 2000,
    transaction_history: [
      { card_id: 1, amount_usd: 800, category: "dining", date: "", location: "USA" },  // 40% dining
      { card_id: 1, amount_usd: 200, category: "groceries", date: "", location: "USA" }, // 10% groceries
      { card_id: 1, amount_usd: 1000, category: "online_shopping", date: "", location: "USA" }, // 50% other (1%)
    ],
  });
  const rcu = computeRealizedCashback(gemini, diner);
  // 期望: 2000 × (0.4·3% + 0.1·2% + 0.5·1%) = 2000 × (1.2% + 0.2% + 0.5%) = 2000 × 0.019 = $38
  expect(rcu).toBeGreaterThan(30);
  expect(rcu).toBeLessThan(50);
});

// =====================================================================
// 个性化：同一张卡，在不同 priority 下 score 应明显不同
// =====================================================================
test("个性化: 同一张卡在 cashback vs privacy 偏好下，分差 > 10 分", () => {
  const card = baseCard({
    id: 77,
    cashback: '[{"name":"All","maxRate":3,"minRate":3}]',
    cashback_max: "3.0",
    kyc_required: 1,
    general_ratings: 80,
  });
  const user = baseUser({ monthly_spend_usd: 5000 });
  const ctx = buildV2Context();
  const rCashback = scoreOneCardV2({
    card, user, userState: EMPTY_USER_STATE, ownedCards: [], ctx,
    preferences: { ...cashbackPrefs, right_now_priorities: [{ factor: "cashback", weight: 1 }] },
  });
  const rPrivacy = scoreOneCardV2({
    card, user, userState: EMPTY_USER_STATE, ownedCards: [], ctx,
    preferences: { ...cashbackPrefs, right_now_priorities: [{ factor: "privacy", weight: 1 }] },
  });
  // cashback 偏好下应明显更高
  expect(rCashback.display_score - rPrivacy.display_score).toBeGreaterThan(10);
});
