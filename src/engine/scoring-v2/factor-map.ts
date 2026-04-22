/**
 * scoring-v2 · 10 列 FACTOR_MAP（priority → 10 个维度权重）
 *
 * 设计点: README §四 个性化权重矩阵
 *
 * 与 v1 的关键区别：
 *   1. 从 4 列扩到 10 列（含 friction / risk / reputation），
 *      让"security"类偏好真正抬高风险权重。
 *   2. 未识别 factor 会通过 onUnknownFactor 回调告警，不静默。
 *   3. DEFAULT_WEIGHTS 用均衡分布，偏保守。
 *
 * 每行权重和 = 1 （由 invariants.ts assertWeightsSumTo1 在单测里校验）。
 */

import type { PreferenceProfile } from "../../types";
import type { V2Weights, V2DimensionKey } from "./types";
import { V2_DIMENSIONS } from "./types";
import { assertWeightsSumTo1, clamp01 } from "./invariants";

// ---- 10 列权重矩阵 ----
export const FACTOR_MAP_V2: Record<string, V2Weights> = {
  cashback: {
    IRS: 0.05, CP: 0.10, FB: 0.10, RCR: 0.05, ABR: 0.05,
    RCU: 0.40, FF: 0.10, CO: 0.05, LCF: 0.05, PF: 0.05,
  },
  low_fees: {
    IRS: 0.05, CP: 0.10, FB: 0.30, RCR: 0.05, ABR: 0.05,
    RCU: 0.20, FF: 0.10, CO: 0.05, LCF: 0.05, PF: 0.05,
  },
  privacy: {
    IRS: 0.10, CP: 0.05, FB: 0.05, RCR: 0.05, ABR: 0.20,
    RCU: 0.05, FF: 0.15, CO: 0.05, LCF: 0.10, PF: 0.20,
  },
  no_kyc: {
    IRS: 0.10, CP: 0.05, FB: 0.05, RCR: 0.05, ABR: 0.20,
    RCU: 0.05, FF: 0.15, CO: 0.05, LCF: 0.10, PF: 0.20,
  },
  high_spending_limit: {
    IRS: 0.15, CP: 0.10, FB: 0.10, RCR: 0.15, ABR: 0.10,
    RCU: 0.15, FF: 0.15, CO: 0.05, LCF: 0.05, PF: 0.00,
  },
  travel_perks: {
    IRS: 0.10, CP: 0.05, FB: 0.10, RCR: 0.05, ABR: 0.10,
    RCU: 0.15, FF: 0.30, CO: 0.05, LCF: 0.05, PF: 0.05,
  },
  wide_acceptance: {
    IRS: 0.15, CP: 0.05, FB: 0.05, RCR: 0.10, ABR: 0.10,
    RCU: 0.10, FF: 0.25, CO: 0.10, LCF: 0.05, PF: 0.05,
  },
  security: {
    IRS: 0.25, CP: 0.05, FB: 0.05, RCR: 0.25, ABR: 0.10,
    RCU: 0.05, FF: 0.15, CO: 0.05, LCF: 0.05, PF: 0.00,
  },
  multi_currency: {
    IRS: 0.10, CP: 0.05, FB: 0.05, RCR: 0.05, ABR: 0.05,
    RCU: 0.15, FF: 0.35, CO: 0.10, LCF: 0.05, PF: 0.05,
  },
  wechat_alipay: {
    IRS: 0.05, CP: 0.05, FB: 0.05, RCR: 0.05, ABR: 0.05,
    RCU: 0.15, FF: 0.45, CO: 0.10, LCF: 0.05, PF: 0.00,
  },
  atm_access: {
    IRS: 0.10, CP: 0.05, FB: 0.10, RCR: 0.10, ABR: 0.05,
    RCU: 0.10, FF: 0.35, CO: 0.10, LCF: 0.05, PF: 0.00,
  },
};

// ---- DEFAULT (没有任何 priority 时) ----
export const DEFAULT_WEIGHTS_V2: V2Weights = {
  IRS: 0.15, CP: 0.10, FB: 0.10, RCR: 0.10, ABR: 0.10,
  RCU: 0.15, FF: 0.15, CO: 0.05, LCF: 0.05, PF: 0.05,
};

// ---- 工具 ----
function zeroWeights(): V2Weights {
  return Object.fromEntries(V2_DIMENSIONS.map(k => [k, 0])) as V2Weights;
}

export function normalizeWeights(w: V2Weights): V2Weights {
  const sum = (Object.values(w) as number[]).reduce((a, b) => a + b, 0);
  if (sum <= 0) return { ...DEFAULT_WEIGHTS_V2 };
  const out = zeroWeights();
  for (const k of V2_DIMENSIONS) out[k] = clamp01(w[k] / sum);
  return out;
}

// ---- 主函数：priority 向量 → 10 维权重 ----
//
// 设计点: README §四 + G "未识别 factor 告警"
export function mapPreferencesToWeightsV2(
  prefs: PreferenceProfile,
  onUnknownFactor?: (factor: string) => void,
): V2Weights {
  const priorities = prefs.right_now_priorities ?? [];
  if (priorities.length === 0) return { ...DEFAULT_WEIGHTS_V2 };

  const acc = zeroWeights();
  let totalUsed = 0;

  for (const { factor, weight } of priorities) {
    const row = FACTOR_MAP_V2[factor];
    if (!row) {
      if (onUnknownFactor) onUnknownFactor(factor);
      // 落到 DEFAULT，但也计入总权重
      for (const k of V2_DIMENSIONS) acc[k] += weight * DEFAULT_WEIGHTS_V2[k];
      totalUsed += weight;
      continue;
    }
    for (const k of V2_DIMENSIONS) acc[k] += weight * row[k];
    totalUsed += weight;
  }

  if (totalUsed <= 0) return { ...DEFAULT_WEIGHTS_V2 };

  const normalized = normalizeWeights(acc);
  assertWeightsSumTo1("V2Weights", normalized, 1e-6);
  return normalized;
}
