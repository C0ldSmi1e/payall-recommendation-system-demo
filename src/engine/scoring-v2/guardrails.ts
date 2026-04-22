/**
 * scoring-v2 · 7 条护栏（对所有用户不变）
 *
 * 设计点 → README §三：
 *   G1 硬约束硬过滤           → enforceHardConstraints
 *   G2 IRS < 0.40 最低门槛    → enforceReputationThreshold + MIN_REPUTATION
 *   G3 Safety 乘法合成         → 在 compose.ts 内实现（乘法形式）
 *   G4 Promoted slot 分离      → tagPromoted + PROMOTED_CARD_IDS
 *   G5 breakdown 由代码产出    → 在 breakdown.ts 实现
 *   G6 log1p 归一              → 在 fit.ts 的 normalizeMonetaryUpliftLog 实现
 *   G7 稳定排序                → 在 index.ts 的 rescoreAndSortV2 实现
 *
 * 这个文件只负责可单独过滤的 G1/G2/G4。
 */

import type { Card, User, UserState } from "../../types";
import type { V2Context, MultiOutcomeCardV2 } from "./types";

// Bit2Go id = 23 是 payall 自家卡；走 Promoted slot 而非打分 bonus
export const PROMOTED_CARD_IDS: Set<number> = new Set([23]);

export const MIN_REPUTATION = 0.40;

// ---- G1: 硬约束硬过滤 ----
// 沿用 src/engine/constraint.ts 的规则（is_deleted / owned / disallowed country）。
// 这里不重复实现，提供一个"在 scoring-v2 流程里的最终 defense"入口。
function parseJsonArray(val: string | null | undefined): string[] {
  try {
    const p = JSON.parse(val || "[]");
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}

export function enforceHardConstraints(
  card: Card,
  user: User,
  userState: UserState,
): { passed: boolean; reason?: string } {
  if (card.is_deleted === 1) return { passed: false, reason: "deleted" };
  if (user.owned_card_ids?.includes(card.id)) return { passed: false, reason: "owned" };
  const disallowed = parseJsonArray(card.disallowed_countries).map(c => c.toUpperCase());
  const userCountries = [user.country, user.current_location, userState.hard_requirements.country]
    .filter(Boolean).map(c => c!.toUpperCase());
  const blocked = userCountries.find(c => disallowed.includes(c));
  if (blocked) return { passed: false, reason: `blocked in ${blocked}` };
  return { passed: true };
}

// ---- G2: IRS 最低门槛 ----
export function enforceReputationThreshold(IRS: number): { passed: boolean; reason?: string } {
  if (IRS < MIN_REPUTATION) return { passed: false, reason: `IRS ${IRS.toFixed(2)} < ${MIN_REPUTATION}` };
  return { passed: true };
}

// ---- G4: Promoted slot 标记 ----
export function isPromoted(cardId: number, ctx: V2Context): boolean {
  return ctx.promotedCardIds.has(cardId);
}

/** 把 promoted 标记写到 trace 上，不改动打分。 */
export function tagPromoted(card: MultiOutcomeCardV2, ctx: V2Context): void {
  if (!card.v2_trace) return;
  card.v2_trace.guardrail_flags.promoted = isPromoted(card.card_id, ctx);
}
