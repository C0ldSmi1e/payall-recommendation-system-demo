/**
 * scoring-v2 · Issuer Trust Prior（IRS 的动态部分）
 *
 * 设计点: README §六 + 设计文档 §八
 *
 * 行为：
 *   - 从 /data/issuer-prior.json 读种子（可人工维护）
 *   - 反馈事件（approval/rejection/客诉）经 recordIssuerEvent 回写
 *   - 对外暴露 `loadIssuerTrust(): Record<vendor, score>` 给 V2Context
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { clamp01 } from "./invariants";

const PATH = resolve(process.cwd(), "data/issuer-prior.json");

interface IssuerStats {
  // Bayesian Beta(α, β) 对应通过率 prior
  approvals: number;
  rejections: number;
  complaints: number;
  // 人工维护的 seed score（可覆盖回写统计）
  seed?: number;
}

type Store = Record<string, IssuerStats>;

let store: Store = {};
let loaded = false;

function loadIfNeeded(): void {
  if (loaded) return;
  if (existsSync(PATH)) {
    try {
      store = JSON.parse(readFileSync(PATH, "utf8"));
    } catch { store = {}; }
  }
  loaded = true;
}

function persist(): void {
  try { writeFileSync(PATH, JSON.stringify(store, null, 2)); } catch {}
}

/** issuer 的当前信任分（IRS 动态部分）。Bayesian Beta(α+2, β+2) 后验均值；减去 complaints 惩罚。 */
export function getIssuerTrust(vendor: string): number {
  loadIfNeeded();
  const v = vendor.toLowerCase();
  const s = store[v];
  if (!s) return 0.7; // 无数据默认 0.7，给陌生 issuer 一个温和先验
  if (typeof s.seed === "number") {
    // 有人工 seed 时用 seed 为先验中心，动态数据微调
    const base = s.seed;
    const n = s.approvals + s.rejections;
    if (n === 0) return clamp01(base - 0.05 * s.complaints);
    const empirical = (s.approvals + 2) / (n + 4);
    // 加权融合
    return clamp01(0.5 * base + 0.5 * empirical - 0.05 * s.complaints);
  }
  // 无 seed：纯 Bayesian
  const n = s.approvals + s.rejections;
  const posterior = (s.approvals + 2) / (n + 4);
  return clamp01(posterior - 0.05 * s.complaints);
}

/** 把所有 issuer 的 trust 拉成 map，给 V2Context 用 */
export function loadIssuerTrust(): Record<string, number> {
  loadIfNeeded();
  const out: Record<string, number> = {};
  for (const vendor of Object.keys(store)) {
    out[vendor] = getIssuerTrust(vendor);
  }
  return out;
}

export type IssuerEvent =
  | { type: "approval"; vendor: string }
  | { type: "rejection"; vendor: string }
  | { type: "complaint"; vendor: string };

export function recordIssuerEvent(evt: IssuerEvent): void {
  loadIfNeeded();
  const v = evt.vendor.toLowerCase();
  const s = store[v] ?? { approvals: 0, rejections: 0, complaints: 0 };
  if (evt.type === "approval") s.approvals++;
  else if (evt.type === "rejection") s.rejections++;
  else s.complaints++;
  store[v] = s;
  persist();
}

/** 单测用：重置 */
export function __resetIssuerTrust(initial: Store = {}): void {
  store = initial;
  loaded = true;
}
