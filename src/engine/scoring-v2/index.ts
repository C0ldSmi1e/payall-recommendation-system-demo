/**
 * scoring-v2 · Public API
 *
 * 对外函数：
 *   - rescoreAndSortV2          : 替代 v1 的 rescoreAndSort，接入 pipeline
 *   - scoreOneCardV2            : 单张卡打分（单测/compare 用）
 *   - buildV2Context            : 从反馈存储装配 V2Context
 *   - deriveScoreBreakdown /
 *     deriveFullBreakdown       : breakdown 给 UI
 *
 * 设计点索引见 ./README.md。
 */

import type { Card, User, UserState, PreferenceProfile } from "../../types";
import type { MultiOutcomeCardV2, V2Context, V2Trace } from "./types";
import { buildCardBenchmark, getCardBenchmark } from "./benchmark";
import { buildFit } from "./fit";
import { mapPreferencesToWeightsV2 } from "./factor-map";
import { computeDisplayScore, makeTrace } from "./compose";
import {
  enforceHardConstraints,
  enforceReputationThreshold,
  tagPromoted,
  PROMOTED_CARD_IDS,
  MIN_REPUTATION,
} from "./guardrails";
import { loadIssuerTrust } from "./issuer-trust";
import { loadApprovalStats } from "./approval-rate";
import { inferLocation } from "../location";

// ---- Build V2 context ----
export function buildV2Context(overrides: Partial<V2Context> = {}): V2Context {
  return {
    issuerTrust: overrides.issuerTrust ?? loadIssuerTrust(),
    approvalStats: overrides.approvalStats ?? loadApprovalStats(),
    referenceMonthlySpendUsd: overrides.referenceMonthlySpendUsd ?? 3000,
    referenceUpliftUsd: overrides.referenceUpliftUsd ?? 200,
    minReputation: overrides.minReputation ?? MIN_REPUTATION,
    promotedCardIds: overrides.promotedCardIds ?? new Set(PROMOTED_CARD_IDS),
  };
}

export interface ScoreOneInput {
  card: Card;
  user: User;
  userState: UserState;
  preferences: PreferenceProfile;
  ownedCards: Card[];
  ctx: V2Context;
}

export interface ScoreOneOutput {
  display_score: number;
  trace: V2Trace;
  // 如果被护栏阻断，trace.display_score 会被设为 0 并在 guardrail_flags 里打标
  blocked: { hard?: string; reputation?: string } | null;
}

// ---- 核心：单张卡打分 ----
export function scoreOneCardV2(inp: ScoreOneInput): ScoreOneOutput {
  const { card, user, userState, preferences, ownedCards, ctx } = inp;
  const warnings: string[] = [];

  // G1: 硬约束
  const hard = enforceHardConstraints(card, user, userState);
  if (!hard.passed) {
    // 这类卡一般不会进入 scoring（已由 constraint engine 过滤），
    // 但即便进来了也产出一个 blocked trace 方便调试。
    const benchmark = buildCardBenchmark(card, ctx);
    const fit = { RCU_usd: 0, RCU_norm: 0, FF: 0, CO: 0, LCF: 0, PF: 1, ABR_user: 0 };
    const weights = mapPreferencesToWeightsV2(preferences, (f) => warnings.push(`unknown factor: ${f}`));
    const trace = makeTrace(card.id, card.card_name, benchmark, fit, weights,
      { fitFraction: 0, monetaryUplift: 0, safetyFactor: 0, display_score: 0 }, warnings);
    trace.guardrail_flags.hard_constraint_blocked = true;
    return { display_score: 0, trace, blocked: { hard: hard.reason } };
  }

  // 计算 benchmark（会走缓存）
  const benchmark = getCardBenchmark(card, ctx);

  // G2: reputation 门槛
  const rep = enforceReputationThreshold(benchmark.IRS);
  if (!rep.passed) {
    const fit = { RCU_usd: 0, RCU_norm: 0, FF: 0, CO: 0, LCF: 0, PF: 1, ABR_user: 0 };
    const weights = mapPreferencesToWeightsV2(preferences, (f) => warnings.push(`unknown factor: ${f}`));
    const trace = makeTrace(card.id, card.card_name, benchmark, fit, weights,
      { fitFraction: 0, monetaryUplift: 0, safetyFactor: 0, display_score: 0 }, warnings);
    trace.guardrail_flags.reputation_gate_blocked = true;
    return { display_score: 0, trace, blocked: { reputation: rep.reason } };
  }

  // Fit 层
  const inferredCountry = inferLocation(user).primary_country;
  const fit = buildFit(card, user, inferredCountry, ownedCards, ctx);

  // Weights
  const weights = mapPreferencesToWeightsV2(preferences, (f) => warnings.push(`unknown factor: ${f}`));

  // 合成
  const compose = computeDisplayScore({ benchmark, fit, weights });

  const trace = makeTrace(card.id, card.card_name, benchmark, fit, weights, compose, warnings);
  return { display_score: compose.display_score, trace, blocked: null };
}

// ---- 批量：rescoreAndSortV2（pipeline 入口） ----
//
// 签名接近 v1 的 rescoreAndSort，但需要 cards + user + userState 来计算 fit。
// 返回：就地修改 `MultiOutcomeCard[]`：
//   - 重写 composite_score
//   - 附加 v2_trace
//   - 按 (score desc, card_id asc) 稳定排序（G7）
export function rescoreAndSortV2(
  perceptionCards: MultiOutcomeCardV2[],
  allCards: Card[],
  user: User,
  userState: UserState,
  preferences: PreferenceProfile,
  ctx?: V2Context,
): MultiOutcomeCardV2[] {
  const _ctx = ctx ?? buildV2Context();
  const ownedCards = user.owned_card_ids
    .map(id => allCards.find(c => c.id === id))
    .filter(Boolean) as Card[];

  const cardById = new Map(allCards.map(c => [c.id, c]));

  for (const pc of perceptionCards) {
    const card = cardById.get(pc.card_id);
    if (!card) {
      pc.composite_score = 0;
      continue;
    }
    const r = scoreOneCardV2({
      card, user, userState, preferences, ownedCards, ctx: _ctx,
    });
    pc.composite_score = Math.round(r.display_score * 100) / 100; // 保留 2 位小数
    pc.v2_trace = r.trace;
    tagPromoted(pc, _ctx);
  }

  // G7: 稳定排序（JS 的 sort 在 ES2019 起稳定，但 ties 用 card_id 升序作为 deterministic tiebreak）
  perceptionCards.sort((a, b) => {
    if (b.composite_score !== a.composite_score) return b.composite_score - a.composite_score;
    return a.card_id - b.card_id;
  });

  return perceptionCards;
}

// Re-export breakdown helpers
export { deriveScoreBreakdown, deriveFullBreakdown } from "./breakdown";
export { FACTOR_MAP_V2, DEFAULT_WEIGHTS_V2, mapPreferencesToWeightsV2 } from "./factor-map";
export { V2_DIMENSIONS } from "./types";
export type { V2Trace, V2Weights, V2Benchmark, V2Fit, V2Context, MultiOutcomeCardV2 } from "./types";
export { PROMOTED_CARD_IDS, MIN_REPUTATION } from "./guardrails";
export { recordIssuerEvent, loadIssuerTrust } from "./issuer-trust";
export { updateApprovalStats, loadApprovalStats } from "./approval-rate";
