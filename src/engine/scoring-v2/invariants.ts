/**
 * scoring-v2 · Harness: runtime invariants.
 *
 * 原则：每个维度的输入/输出都在边界处断言。生产默认只打警告，
 * 设 SCORING_V2_STRICT=1 时抛异常（单测用）。
 *
 * 这个文件被所有 dimension/compose 文件引用——要改，先想清楚。
 */

const STRICT = process.env.SCORING_V2_STRICT === "1";
const WARN = process.env.SCORING_V2_WARN !== "0";

export class InvariantViolation extends Error {
  constructor(msg: string) {
    super(`[scoring-v2 invariant] ${msg}`);
    this.name = "InvariantViolation";
  }
}

function violate(msg: string): void {
  if (STRICT) throw new InvariantViolation(msg);
  if (WARN) console.warn(`[scoring-v2 WARN] ${msg}`);
}

/** [0, 1] clamp (design点 G6 的基础工具，覆盖 NaN/Infinity) */
export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/** [0, 100] clamp for final display score */
export function clamp100(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

/** Assert v ∈ [0, 1] */
export function assertRange01(name: string, v: number): number {
  if (!Number.isFinite(v)) violate(`${name} is not finite: ${v}`);
  else if (v < -1e-9 || v > 1 + 1e-9) violate(`${name} out of [0,1]: ${v}`);
  return clamp01(v);
}

/** Assert v ∈ [0, 100] */
export function assertScore(name: string, v: number): number {
  if (!Number.isFinite(v)) violate(`${name} is not finite: ${v}`);
  else if (v < -1e-6 || v > 100 + 1e-6) violate(`${name} out of [0,100]: ${v}`);
  return clamp100(v);
}

/** Assert weights sum to 1 (within tol) */
export function assertWeightsSumTo1(
  name: string,
  weights: Record<string, number>,
  tol = 1e-6,
): void {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > tol) {
    violate(`${name} weights do not sum to 1: got ${sum}, weights=${JSON.stringify(weights)}`);
  }
}

/** Assert a weight key exists (no silent fallback) */
export function assertDefined<T>(name: string, v: T | undefined): T {
  if (v === undefined) {
    violate(`${name} is undefined`);
    // Best-effort: return zero-like; callers should also handle.
    return 0 as unknown as T;
  }
  return v;
}
