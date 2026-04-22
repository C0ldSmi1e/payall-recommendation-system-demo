/**
 * scoring-v2 · Approval Base Rate (Bayesian Beta)
 *
 * 设计点: README §六 + 设计文档 §八
 *
 * Key = `${card_id}|${country}|${kyc_bucket}` 粒度。90 天滚动窗口（简化：当前累计）。
 * 先验 Beta(2,2)；对应 mean=0.5。
 *
 * API:
 *   loadApprovalStats() - 给 V2Context 用
 *   updateApprovalStats(event) - 接收 feedback
 *   computePosterior(key) - 内部用
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { clamp01 } from "./invariants";

const PATH = resolve(process.cwd(), "data/approval-stats.json");

interface Stats { alpha: number; beta: number }
type Store = Record<string, Stats>;

let store: Store = {};
let loaded = false;

function loadIfNeeded(): void {
  if (loaded) return;
  if (existsSync(PATH)) {
    try { store = JSON.parse(readFileSync(PATH, "utf8")); } catch { store = {}; }
  }
  loaded = true;
}

function persist(): void {
  try { writeFileSync(PATH, JSON.stringify(store, null, 2)); } catch {}
}

export function loadApprovalStats(): Record<string, Stats> {
  loadIfNeeded();
  // Return a shallow copy so callers can't mutate us by reference
  return { ...store };
}

export function computePosterior(key: string): number {
  loadIfNeeded();
  const s = store[key];
  if (!s) return 0.5;
  return clamp01((s.alpha + 2) / (s.alpha + s.beta + 4));
}

export type ApprovalEvent = {
  card_id: number;
  country: string;
  kyc_verified: boolean;
  approved: boolean;
};

export function updateApprovalStats(evt: ApprovalEvent): void {
  loadIfNeeded();
  const kyc = evt.kyc_verified ? "v" : "u";
  const key = `${evt.card_id}|${(evt.country || "").toUpperCase()}|${kyc}`;
  const s = store[key] ?? { alpha: 0, beta: 0 };
  if (evt.approved) s.alpha++;
  else s.beta++;
  store[key] = s;

  // 也写 card 级别聚合（key = "cardId|*|*"）
  const cardKey = `${evt.card_id}|*|*`;
  const cs = store[cardKey] ?? { alpha: 0, beta: 0 };
  if (evt.approved) cs.alpha++;
  else cs.beta++;
  store[cardKey] = cs;

  persist();
}

/** 单测用 */
export function __resetApprovalStats(initial: Store = {}): void {
  store = initial;
  loaded = true;
}
