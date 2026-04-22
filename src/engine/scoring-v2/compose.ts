/**
 * scoring-v2 · 合成 DisplayScore
 *
 * 设计点: README §一两层结构 + §五合成公式 + G3 (Safety 乘法)
 *
 * 公式:
 *   FitFraction   = clamp01( w.FF·FF + w.CO·CO + w.LCF·LCF )
 *   MonetaryUplift= fit.RCU_norm  （已经在 fit.ts 里 log1p 归一）
 *   SafetyFactor  = (1 - w.RCR·RCR) · (1 - w.IRS·(1-IRS)) · ABR_user · (1 - w.PF·PF)
 *   DisplayScore  = 100 · FitFraction · MonetaryUplift · SafetyFactor   （G3 乘法）
 *
 * 注：CP、FB、RCU（weight 层面）虽然在 weights 里，但它们通过 MonetaryUplift / BenchmarkScore
 * 进入；RCU_norm 本身已经融合了 RCU 数额。在 FitFraction 计算时我们对 CP/FB/RCU 不直接加项，
 * 而是把它们折进 MonetaryUplift 并把剩余权重归到 Fit 三项上。这是设计文档附录 A 的"乘法分解"。
 */

import type { V2Benchmark, V2Fit, V2Weights, V2Trace } from "./types";
import { assertRange01, assertScore, clamp01 } from "./invariants";

// 把 weights 里非 fit-fraction 部分折回到 FF/CO/LCF 三项（保证 weights 总和仍为 1 时 fit 分母合理）
// 这里选择：FitFraction 的权重基准 = weights.FF + weights.CO + weights.LCF
// 防止这 3 项权重之和为 0 导致 fit 永远是 0。
export function computeFitFraction(fit: V2Fit, w: V2Weights): number {
  const ffW = w.FF, coW = w.CO, lcfW = w.LCF;
  const denom = ffW + coW + lcfW;
  if (denom <= 1e-6) {
    // 降级：平均
    return assertRange01("FitFraction", (fit.FF + fit.CO + fit.LCF) / 3);
  }
  const num = ffW * fit.FF + coW * fit.CO + lcfW * fit.LCF;
  return assertRange01("FitFraction", clamp01(num / denom));
}

// Safety 乘法：任何一项极差都会把总分压低（G3 的关键）
export function computeSafetyFactor(benchmark: V2Benchmark, fit: V2Fit, w: V2Weights): number {
  // IRS: 越高越好。reputation 风险 = 1 - IRS
  const irsTerm = clamp01(1 - w.IRS * (1 - benchmark.IRS));
  // RCR: 越高越差
  const rcrTerm = clamp01(1 - w.RCR * benchmark.RCR);
  // ABR_user ∈ [0,1]：直接乘
  const abrTerm = clamp01(fit.ABR_user);
  // PF: 越高越差
  const pfTerm = clamp01(1 - w.PF * fit.PF);

  return assertRange01("SafetyFactor", irsTerm * rcrTerm * abrTerm * pfTerm);
}

export interface ComposeInput {
  benchmark: V2Benchmark;
  fit: V2Fit;
  weights: V2Weights;
}

export interface ComposeOutput {
  fitFraction: number;
  monetaryUplift: number;
  safetyFactor: number;
  display_score: number;
}

export function computeDisplayScore(inp: ComposeInput): ComposeOutput {
  const { benchmark, fit, weights: w } = inp;

  // 1) FitFraction
  const fitFraction = computeFitFraction(fit, w);

  // 2) MonetaryUplift: 直接用 fit.RCU_norm（已经 log1p 归一）
  //    但 weight 里 RCU/CP/FB 的权重要作用在这里 —— 用"加权平均"形式:
  //    monetaryUplift = RCU_norm × weightShare(RCU) + CP × weightShare(CP) + (1-FB) × weightShare(FB)
  //    然后归一到这 3 个权重之和。
  const monW = w.RCU + w.CP + w.FB;
  let monetaryUplift: number;
  if (monW <= 1e-6) {
    monetaryUplift = fit.RCU_norm;
  } else {
    monetaryUplift = clamp01(
      (w.RCU * fit.RCU_norm + w.CP * benchmark.CP + w.FB * (1 - benchmark.FB)) / monW,
    );
  }
  monetaryUplift = assertRange01("MonetaryUplift", monetaryUplift);

  // 3) SafetyFactor
  const safetyFactor = computeSafetyFactor(benchmark, fit, w);

  // 4) DisplayScore = 100 × Fit × Monetary × Safety  （G3 乘法，不是减法）
  const display_score = assertScore("DisplayScore", 100 * fitFraction * monetaryUplift * safetyFactor);

  return { fitFraction, monetaryUplift, safetyFactor, display_score };
}

// ---- Trace helper ----
export function makeTrace(
  card_id: number,
  card_name: string,
  benchmark: V2Benchmark,
  fit: V2Fit,
  weights: V2Weights,
  compose: ComposeOutput,
  warnings: string[],
): V2Trace {
  return {
    card_id, card_name,
    benchmark, fit, weights,
    fitFraction: compose.fitFraction,
    monetaryUplift: compose.monetaryUplift,
    safetyFactor: compose.safetyFactor,
    display_score: compose.display_score,
    guardrail_flags: {
      reputation_gate_blocked: false,
      hard_constraint_blocked: false,
      promoted: false,
    },
    warnings,
  };
}
