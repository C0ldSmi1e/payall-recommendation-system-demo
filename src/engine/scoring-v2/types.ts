/**
 * scoring-v2 · 类型定义
 *
 * 和 src/types.ts 的 MultiOutcomeCard 保持兼容：
 * V2 在不改动旧结构的前提下，把完整信息放在 `v2_trace` 里。
 */

import type { MultiOutcomeCard } from "../../types";

// 10 维度名（与 FACTOR_MAP_V2 列一一对应）
export const V2_DIMENSIONS = [
  "IRS", "CP", "FB", "RCR", "ABR",      // benchmark 层
  "RCU", "FF", "CO", "LCF", "PF",       // fit 层
] as const;

export type V2DimensionKey = typeof V2_DIMENSIONS[number];

/** 10 维权重（mapPreferencesToWeightsV2 输出） */
export type V2Weights = Record<V2DimensionKey, number>;

/** Benchmark 层输出（与用户无关，可缓存） */
export interface V2Benchmark {
  card_id: number;
  IRS: number;   // [0,1]  issuer reputation
  CP: number;    // [0,1]  cashback potential
  FB: number;    // [0,1]  fee burden (higher = worse)
  RCR: number;   // [0,1]  continuity risk (higher = worse)
  ABR_base: number; // [0,1] approval base rate (issuer-level prior)
  benchmark_score: number; // [0,100] 对外展示分
}

/** Fit 层输出（per user × card） */
export interface V2Fit {
  RCU_usd: number;   // absolute USD/mo realized cashback
  RCU_norm: number;  // [0,1] 归一后的 MonetaryUplift 输入
  FF: number;        // [0,1]
  CO: number;        // [0,1]
  LCF: number;       // [0,1]
  PF: number;        // [0,1] higher = more friction for this user
  ABR_user: number;  // [0,1] approval prob for this (card, country, kyc)
}

/** 完整 trace：scoring-v2 每次计算都会产出，用于 breakdown + 对比 + 调试 */
export interface V2Trace {
  card_id: number;
  card_name: string;

  benchmark: V2Benchmark;
  fit: V2Fit;

  weights: V2Weights;

  // 合成中间量
  fitFraction: number;       // [0,1]
  monetaryUplift: number;    // [0,1]
  safetyFactor: number;      // [0,1]

  // 最终分
  display_score: number;     // [0,100]

  // 护栏触发记录
  guardrail_flags: {
    reputation_gate_blocked: boolean;  // G2
    hard_constraint_blocked: boolean;  // G1 (会在 enforceHardConstraints 之前产生 trace 时设置)
    promoted: boolean;                  // G4
  };

  // 告警（如未识别 factor）
  warnings: string[];
}

/** 一次打分请求的上下文（为了纯函数化，所有依赖显式传入） */
export interface V2Context {
  // 反馈驱动的动态数据
  issuerTrust: Record<string, number>;         // vendor/issuer → IRS 动态分（0..1）
  approvalStats: Record<string, { alpha: number; beta: number }>; // key = "cardId|country|kyc"
  // 配置
  referenceMonthlySpendUsd: number;  // 默认 3000
  referenceUpliftUsd: number;         // 默认 200
  minReputation: number;              // 默认 0.40
  promotedCardIds: Set<number>;       // 默认 {23}（Bit2Go）
}

/** 扩展的 MultiOutcomeCard：保留旧字段，附带 v2 trace */
export interface MultiOutcomeCardV2 extends MultiOutcomeCard {
  v2_trace?: V2Trace;
}
