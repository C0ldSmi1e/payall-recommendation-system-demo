/**
 * scoring-v2 · ScoreBreakdown 由代码产出（G5）
 *
 * 设计点: README §七 + G5
 * 对应设计文档第七节 + 附录 A（乘法分解回显示分）
 *
 * LLM 只负责填 explanation 的自然语言；score 和 weight 数值完全由代码给。
 */

import type { ScoreBreakdown } from "../../types";
import type { V2Trace } from "./types";
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
