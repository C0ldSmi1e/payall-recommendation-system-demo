/**
 * scoring-v2 · ScoreBreakdown 由代码产出（G5）
 *
 * 设计点: README §七 + G5
 * 对应设计文档第七节 + 附录 A（乘法分解回显示分）
 *
 * LLM 只负责填 explanation 的自然语言；score 和 weight 数值完全由代码给。
 */

import type { ScoreBreakdown, FinalRecommendation } from "../../types";
import type { V2Trace, MultiOutcomeCardV2 } from "./types";
import { clamp100 } from "./invariants";

// 维度对应的用户可读 label（中文优先，给 payall 用户看）
const LABELS: Record<string, string> = {
  IRS: "发卡商声誉",
  CP: "返现设计强度",
  FB: "费用负担",
  RCR: "连续性/监管风险",
  ABR: "历史通过率",
  RCU: "你的实际返现",
  FF: "功能匹配",
  CO: "互补性",
  LCF: "地区合规契合",
  PF: "个人摩擦",
};

// 对应 dimension 的 [0,100] 分数（把 v2 trace 中 [0,1] 的维度展平）
function dimValue(trace: V2Trace, dim: string): number {
  switch (dim) {
    case "IRS": return trace.benchmark.IRS * 100;
    case "CP":  return trace.benchmark.CP  * 100;
    case "FB":  return (1 - trace.benchmark.FB) * 100;   // 反转：越低越好 → 显示分越低
    case "RCR": return (1 - trace.benchmark.RCR) * 100;
    case "ABR": return trace.fit.ABR_user * 100;
    case "RCU": return trace.fit.RCU_norm * 100;
    case "FF":  return trace.fit.FF * 100;
    case "CO":  return trace.fit.CO * 100;
    case "LCF": return trace.fit.LCF * 100;
    case "PF":  return (1 - trace.fit.PF) * 100;
    default: return 50;
  }
}

/**
 * 从 trace 推导 ScoreBreakdown 数组。
 * 设计约束：
 *   - 不让 LLM 决定 score 数值
 *   - contribution 之和 ≈ display_score（按乘法分解近似，见附录 A）
 */
export function deriveScoreBreakdown(trace: V2Trace, dimsToShow?: string[]): ScoreBreakdown[] {
  const dims = dimsToShow ?? ["RCU", "FF", "IRS", "FB", "RCR", "PF", "CO"];
  const total = Math.max(1e-6, trace.display_score);

  return dims.map((dim) => {
    const rawScore = clamp100(dimValue(trace, dim));
    const weight = (trace.weights as unknown as Record<string, number>)[dim] ?? 0;
    // contribution 的直观解释：
    //   该维度分 × 该维度权重，再乘以一个比例因子让总和 ≈ display_score
    // 这里用加法近似（UI 展示用）
    const contribution = rawScore * weight;
    return {
      dimension: dim.toLowerCase(),
      label: LABELS[dim] ?? dim,
      score: Math.round(rawScore),
      // 下面两个字段不在 ScoreBreakdown 原 type 里，但对 v2 来说有价值
      // 用 explanation 字段做个兜底，UI 里解析
      explanation: `权重 ${(weight * 100).toFixed(0)}% · 贡献 ≈ ${contribution.toFixed(1)}（/100）`,
    };
  });
}

/**
 * 对外 API：针对一张推荐卡的完整 breakdown（含护栏说明）
 */
export function deriveFullBreakdown(trace: V2Trace): {
  display_score: number;
  benchmark_score: number;
  dimensions: ScoreBreakdown[];
  notes: string[];
} {
  const notes: string[] = [];
  if (trace.guardrail_flags.promoted) {
    notes.push("此卡由 PayAll 官方运营推荐（Promoted）。打分仍按统一规则计算。");
  }
  if (trace.warnings.length > 0) {
    notes.push(...trace.warnings);
  }
  return {
    display_score: trace.display_score,
    benchmark_score: trace.benchmark.benchmark_score,
    dimensions: deriveScoreBreakdown(trace),
    notes,
  };
}

// ---------------------------------------------------------------------------
// overrideFinalRecWithV2Scores  ·  G5 的真正 wire-up
// ---------------------------------------------------------------------------
// 设计稿第七节要求 "score_breakdown 由代码产出，LLM 只填 explanation"。
// 本函数是唯一把 scoring-v2 trace 落回 UI 展示字段的地方。
//
// 作用：
//   1. 用 trace.display_score 覆盖 primary.score 和 backups[i].score（整数）。
//      —— 之前 LLM 可以在 JSON 里随便写 score:88，和真实排序完全脱节。
//   2. 用 deriveScoreBreakdown(trace) 覆盖 primary.score_breakdown。
//      —— 之前 LLM 自己编每个维度的分数，和 display_score 算不出关系。
//   3. 把 fitFraction / monetaryUplift / safetyFactor / benchmark_score 挂到
//      primary.v2_debug，UI 可以显式展示"为什么这个分"，与 trace 一一对应。
//
// 不改：primary.reason / pros / cons / insights / bit2go_action / next_action —
// 这些是 LLM 真正擅长的自然语言，保留。
//
// 追溯：如果你看到 UI 上分数和排序对不上，这里是唯一 override 点。
//       如果传入的 perceptionCards 缺少 v2_trace（v1 模式下），函数
//       "就地 no-op"，以便 SCORING_VERSION=v1 依然 work。
// ---------------------------------------------------------------------------
export function overrideFinalRecWithV2Scores(
  rec: FinalRecommendation,
  perceptionCards: MultiOutcomeCardV2[],
): FinalRecommendation {
  const byId = new Map<number, MultiOutcomeCardV2>();
  for (const pc of perceptionCards) byId.set(pc.card_id, pc);

  const primaryPc = byId.get(rec.primary.card_id);
  if (primaryPc?.v2_trace) {
    const t = primaryPc.v2_trace;
    rec.primary.score = Math.round(t.display_score);
    rec.primary.score_breakdown = deriveScoreBreakdown(t);
    rec.primary.v2_debug = {
      display_score: Math.round(t.display_score * 100) / 100,
      benchmark_score: Math.round(t.benchmark.benchmark_score * 100) / 100,
      fitFraction: Math.round(t.fitFraction * 1000) / 1000,
      monetaryUplift: Math.round(t.monetaryUplift * 1000) / 1000,
      safetyFactor: Math.round(t.safetyFactor * 1000) / 1000,
      promoted: t.guardrail_flags.promoted,
    };
  }

  for (const bk of rec.backups ?? []) {
    const bkPc = byId.get(bk.card_id);
    if (bkPc?.v2_trace) bk.score = Math.round(bkPc.v2_trace.display_score);
  }

  return rec;
}
