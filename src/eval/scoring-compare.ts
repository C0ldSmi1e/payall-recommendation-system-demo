/**
 * v1 vs v2 Scoring Comparison Harness
 *
 * 运行：
 *   bun run src/eval/scoring-compare.ts
 *
 * 目的（对应 scoring-v2/README §九 自验证清单）：
 *   1. 对所有 demo 用户，同时跑 v1 和 v2 的打分
 *   2. 输出 per-user top10 排名差异
 *   3. 量化 Bit2Go（#23）在 v1 / v2 下的平均排名（v2 下应不再是所有用户的 Top1）
 *   4. 打分分布直方图（v2 应比 v1 更宽、更分散）
 *   5. 按 priority persona（cashback / privacy / travel_perks / …）聚合 top3，
 *      验证"不同偏好的用户，v2 的推荐应明显不同"
 *
 * 输入: /src/users.ts 的 15 用户 + /cards.json 全部卡（由 demo 提供）
 * 输出:
 *   - stdout: 人可读摘要（含表格）
 *   - data/v1-v2-compare.json: 完整 diff（机器可读）
 *
 * 设计点：为避免在此脚本里调用 LLM（Step 1 User Analysis），我们用一个**确定性 adapter**
 *        从 `User` 对象合成 `UserState` + `PreferenceProfile`。这和 pipeline 在生产环境下
 *        用 LLM 得出的结构保持同名兼容，仅用规则填充字段。对比结果因此是确定性且可 reproduce 的。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

import type {
  Card, User, UserState, PreferenceProfile, MultiOutcomeCard,
} from "../types";
import { runConstraintEngine } from "../engine/constraint";
import { computeCardPerception } from "../engine/perception";
import { rescoreAndSort as rescoreV1 } from "../engine/scoring";
import { rescoreAndSortV2, buildV2Context } from "../engine/scoring-v2";
import type { MultiOutcomeCardV2 } from "../engine/scoring-v2/types";
import { users } from "../users";

// ---- utils ----

function deepClone<T>(o: T): T { return JSON.parse(JSON.stringify(o)) as T; }

function loadCards(): Card[] {
  const path = resolve(process.cwd(), "cards.json");
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Card[] | { cards: Card[] };
  return Array.isArray(parsed) ? parsed : parsed.cards;
}

function ensureDir(filePath: string): void {
  try { mkdirSync(dirname(filePath), { recursive: true }); } catch {}
}

// ---- Synthesize UserState + PreferenceProfile from a User (no LLM) ----
//
// 纯规则 adapter，目的是让 compare 在无 API key、无网络下也能跑。
// 覆盖字段：仅 pipeline 下游实际需要的（constraint + perception + scoring）。
function synthesizeAnalysis(user: User): { userState: UserState; preferences: PreferenceProfile } {
  const paymentMethods: string[] = [];
  if (user.needs_apple_pay) paymentMethods.push("apple_pay");
  if (user.needs_google_pay) paymentMethods.push("google_pay");
  if (user.needs_wechat_pay) paymentMethods.push("wechat_pay");
  if (user.needs_alipay) paymentMethods.push("alipay");

  const userState: UserState = {
    summary: user.description,
    hard_requirements: {
      country: user.country,
      current_location: user.current_location,
      kyc_status: user.kyc_verified ? "verified" : "unverified",
      needs_physical: user.wants_physical_card,
      needs_virtual: user.wants_virtual_card,
      payment_methods: paymentMethods,
    },
    spending_profile: {
      monthly_usd: user.monthly_spend_usd,
      top_categories: user.primary_use.slice(0, 3),
      spending_pattern: user.monthly_spend_usd >= 5000 ? "high" : user.monthly_spend_usd >= 2000 ? "moderate" : "light",
    },
    preferences: {
      fee_sensitivity: user.fee_sensitivity,
      priorities_ranked: user.priorities,
      crypto_preferences: user.held_cryptos,
      preferred_topup: user.preferred_topup_crypto,
      preferred_currency: user.preferred_currency,
    },
    deal_breakers: [],
    nice_to_haves: [],
    owned_card_context: user.owned_card_ids.length ? `owns ${user.owned_card_ids.join(",")}` : "new user",
    derived_scores: {
      kyc_friction_tolerance: user.kyc_verified ? 0.7 : 0.3,
      travel_need_score: user.primary_use.includes("travel") ? 0.8 : 0.2,
      fee_sensitivity_score: user.fee_sensitivity === "high" ? 0.9 : user.fee_sensitivity === "medium" ? 0.5 : 0.2,
      instant_need_score: user.wants_virtual_card ? 0.8 : 0.4,
      backup_card_need: user.owned_card_ids.length > 0 ? 0.6 : 0.2,
      spending_diversity: new Set(user.primary_use).size / 5,
    },
    journey_position:
      user.owned_card_ids.length === 0 ? "new_user"
      : user.owned_card_ids.length === 1 ? "active_single_card"
      : user.monthly_spend_usd >= 5000 ? "heavy_spender"
      : "multi_card_user",
    current_mode: user.primary_use.includes("travel") ? "travel" : "routine",
    detected_intent: user.priorities[0] ?? "explore",
  };

  // 把 priorities 变成 right_now_priorities，权重均分
  const prios = user.priorities.length > 0 ? user.priorities : ["cashback"];
  const w = 1 / prios.length;
  const preferences: PreferenceProfile = {
    right_now_priorities: prios.map((factor) => ({ factor, weight: w })),
    short_term_intent: userState.detected_intent,
    long_term_intent: userState.detected_intent,
    friction_budget: user.fee_sensitivity === "high" ? "low" : user.fee_sensitivity === "low" ? "high" : "medium",
    value_vs_convenience:
      user.fee_sensitivity === "high" ? "value"
      : user.fee_sensitivity === "low" ? "convenience"
      : "balanced",
    spending_insights: [],
    unmet_needs: [],
  };

  return { userState, preferences };
}

// ---- Histogram helper ----
function histogram(scores: number[], bins: number = 10): { range: string; count: number }[] {
  if (scores.length === 0) return [];
  const min = 0; const max = 100;
  const width = (max - min) / bins;
  const buckets = Array.from({ length: bins }, () => 0);
  for (const s of scores) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((s - min) / width)));
    buckets[idx]++;
  }
  return buckets.map((count, i) => ({
    range: `[${Math.round(min + i * width)}, ${Math.round(min + (i + 1) * width)})`,
    count,
  }));
}

function stddev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
  return Math.sqrt(v);
}

// ---- Per-user comparison ----

interface PerUserCompare {
  user_id: string;
  user_name: string;
  priorities: string[];
  feasible_count: number;

  v1_top10: Array<{ rank: number; card_id: number; card_name: string; score: number }>;
  v2_top10: Array<{ rank: number; card_id: number; card_name: string; score: number }>;

  bit2go_rank_v1: number | null;
  bit2go_rank_v2: number | null;
  bit2go_score_v1: number | null;
  bit2go_score_v2: number | null;

  // 集合差异
  top10_added_in_v2: number[];     // v2 top10 有但 v1 没有
  top10_dropped_in_v2: number[];   // v1 top10 有但 v2 没有
  primary_card_changed: boolean;   // rank#1 是否换人
  v1_primary: { card_id: number; card_name: string } | null;
  v2_primary: { card_id: number; card_name: string } | null;

  // 全量分数（用于分布分析）
  v1_all_scores: number[];
  v2_all_scores: number[];
}

function compareForUser(user: User, cards: Card[]): PerUserCompare | null {
  const { userState, preferences } = synthesizeAnalysis(user);

  // Constraint → feasible
  const { feasibleSet } = runConstraintEngine(userState, cards, user);
  if (feasibleSet.feasible.length === 0) {
    return {
      user_id: user.id, user_name: user.name, priorities: user.priorities,
      feasible_count: 0,
      v1_top10: [], v2_top10: [],
      bit2go_rank_v1: null, bit2go_rank_v2: null,
      bit2go_score_v1: null, bit2go_score_v2: null,
      top10_added_in_v2: [], top10_dropped_in_v2: [],
      primary_card_changed: false, v1_primary: null, v2_primary: null,
      v1_all_scores: [], v2_all_scores: [],
    };
  }

  const feasibleIds = new Set(feasibleSet.feasible.map(f => f.card_id));
  const feasibleCards = cards.filter(c => feasibleIds.has(c.id));
  const perception = computeCardPerception(feasibleCards, user, preferences);

  // Clone so v1 / v2 don't mutate each other's composite_score
  const forV1 = deepClone(perception.cards) as MultiOutcomeCard[];
  const forV2 = deepClone(perception.cards) as MultiOutcomeCardV2[];

  rescoreV1(forV1, preferences);

  const ctx = buildV2Context();
  rescoreAndSortV2(forV2, cards, user, userState, preferences, ctx);

  // Ranks
  const top10V1 = forV1.slice(0, 10).map((c, i) => ({
    rank: i + 1, card_id: c.card_id, card_name: c.card_name, score: c.composite_score,
  }));
  const top10V2 = forV2.slice(0, 10).map((c, i) => ({
    rank: i + 1, card_id: c.card_id, card_name: c.card_name, score: c.composite_score,
  }));

  const BIT2GO = 23;
  const bit2goIdxV1 = forV1.findIndex(c => c.card_id === BIT2GO);
  const bit2goIdxV2 = forV2.findIndex(c => c.card_id === BIT2GO);

  const v1IdSet = new Set(top10V1.map(x => x.card_id));
  const v2IdSet = new Set(top10V2.map(x => x.card_id));
  const added = [...v2IdSet].filter(id => !v1IdSet.has(id));
  const dropped = [...v1IdSet].filter(id => !v2IdSet.has(id));

  const v1Primary = forV1[0]
    ? { card_id: forV1[0].card_id, card_name: forV1[0].card_name }
    : null;
  const v2Primary = forV2[0]
    ? { card_id: forV2[0].card_id, card_name: forV2[0].card_name }
    : null;

  return {
    user_id: user.id,
    user_name: user.name,
    priorities: user.priorities,
    feasible_count: feasibleCards.length,
    v1_top10: top10V1,
    v2_top10: top10V2,
    bit2go_rank_v1: bit2goIdxV1 >= 0 ? bit2goIdxV1 + 1 : null,
    bit2go_rank_v2: bit2goIdxV2 >= 0 ? bit2goIdxV2 + 1 : null,
    bit2go_score_v1: bit2goIdxV1 >= 0 ? forV1[bit2goIdxV1].composite_score : null,
    bit2go_score_v2: bit2goIdxV2 >= 0 ? forV2[bit2goIdxV2].composite_score : null,
    top10_added_in_v2: added,
    top10_dropped_in_v2: dropped,
    primary_card_changed: (v1Primary?.card_id ?? -1) !== (v2Primary?.card_id ?? -2),
    v1_primary: v1Primary,
    v2_primary: v2Primary,
    v1_all_scores: forV1.map(c => c.composite_score),
    v2_all_scores: forV2.map(c => c.composite_score),
  };
}

// ---- Aggregate across users ----

interface AggregateReport {
  generated_at: string;
  total_users: number;

  bit2go: {
    v1_ranks: number[];
    v2_ranks: number[];
    v1_avg_rank: number | null;
    v2_avg_rank: number | null;
    v1_times_top1: number;
    v2_times_top1: number;
  };

  // top-10 内分布（展示给用户的那部分）
  score_distribution_top10: {
    v1_all_scores: number;
    v2_all_scores: number;
    v1_mean: number;
    v2_mean: number;
    v1_stddev: number;
    v2_stddev: number;
    v1_hist: ReturnType<typeof histogram>;
    v2_hist: ReturnType<typeof histogram>;
  };

  // 全量（所有 feasible）分布 — 用于检验 v2 的 [0,100] 动态范围是否更宽
  score_distribution_full: {
    v1_all_scores: number;
    v2_all_scores: number;
    v1_mean: number;
    v2_mean: number;
    v1_stddev: number;
    v2_stddev: number;
    v1_min: number;
    v2_min: number;
    v1_max: number;
    v2_max: number;
    v1_hist: ReturnType<typeof histogram>;
    v2_hist: ReturnType<typeof histogram>;
  };

  persona_top3: Record<string, {
    priority: string;
    users: string[];
    v1_top3: string[];
    v2_top3: string[];
    top3_overlap: number; // 0..3
  }>;

  ranking_churn: {
    users_with_primary_changed: number;
    avg_top10_jaccard: number;
    avg_top10_added: number;
  };

  per_user: PerUserCompare[];
}

function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function derivePersona(user: User): string {
  // Dominant priority. Fallback 到 "general".
  return user.priorities[0] ?? "general";
}

function main(): void {
  const cards = loadCards();
  console.log(`[compare] loaded ${cards.length} cards, ${users.length} users`);

  const perUser: PerUserCompare[] = [];
  const top10V1Scores: number[] = [];
  const top10V2Scores: number[] = [];
  const fullV1Scores: number[] = [];
  const fullV2Scores: number[] = [];

  for (const u of users) {
    const r = compareForUser(u, cards);
    if (r) {
      perUser.push(r);
      for (const t of r.v1_top10) top10V1Scores.push(t.score);
      for (const t of r.v2_top10) top10V2Scores.push(t.score);
      fullV1Scores.push(...r.v1_all_scores);
      fullV2Scores.push(...r.v2_all_scores);
    }
  }

  // Bit2Go stats
  const v1Ranks = perUser.map(p => p.bit2go_rank_v1).filter((x): x is number => x !== null);
  const v2Ranks = perUser.map(p => p.bit2go_rank_v2).filter((x): x is number => x !== null);
  const v1AvgRank = v1Ranks.length ? v1Ranks.reduce((a, b) => a + b, 0) / v1Ranks.length : null;
  const v2AvgRank = v2Ranks.length ? v2Ranks.reduce((a, b) => a + b, 0) / v2Ranks.length : null;
  const v1Top1 = perUser.filter(p => p.bit2go_rank_v1 === 1).length;
  const v2Top1 = perUser.filter(p => p.bit2go_rank_v2 === 1).length;

  // Score distribution · top-10 only（展示给用户那 slice）
  const scoreDistTop10 = {
    v1_all_scores: top10V1Scores.length,
    v2_all_scores: top10V2Scores.length,
    v1_mean: top10V1Scores.length ? top10V1Scores.reduce((a, b) => a + b, 0) / top10V1Scores.length : 0,
    v2_mean: top10V2Scores.length ? top10V2Scores.reduce((a, b) => a + b, 0) / top10V2Scores.length : 0,
    v1_stddev: stddev(top10V1Scores),
    v2_stddev: stddev(top10V2Scores),
    v1_hist: histogram(top10V1Scores),
    v2_hist: histogram(top10V2Scores),
  };

  // Score distribution · full feasible set（检验动态范围 / 分布宽度）
  const scoreDistFull = {
    v1_all_scores: fullV1Scores.length,
    v2_all_scores: fullV2Scores.length,
    v1_mean: fullV1Scores.length ? fullV1Scores.reduce((a, b) => a + b, 0) / fullV1Scores.length : 0,
    v2_mean: fullV2Scores.length ? fullV2Scores.reduce((a, b) => a + b, 0) / fullV2Scores.length : 0,
    v1_stddev: stddev(fullV1Scores),
    v2_stddev: stddev(fullV2Scores),
    v1_min: fullV1Scores.length ? Math.min(...fullV1Scores) : 0,
    v2_min: fullV2Scores.length ? Math.min(...fullV2Scores) : 0,
    v1_max: fullV1Scores.length ? Math.max(...fullV1Scores) : 0,
    v2_max: fullV2Scores.length ? Math.max(...fullV2Scores) : 0,
    v1_hist: histogram(fullV1Scores),
    v2_hist: histogram(fullV2Scores),
  };

  // Persona top3
  const personaBuckets = new Map<string, PerUserCompare[]>();
  for (const p of perUser) {
    const key = derivePersona(users.find(u => u.id === p.user_id)!);
    if (!personaBuckets.has(key)) personaBuckets.set(key, []);
    personaBuckets.get(key)!.push(p);
  }
  const persona_top3: AggregateReport["persona_top3"] = {};
  for (const [priority, ps] of personaBuckets.entries()) {
    // 聚合该 persona 下所有用户的 top3（出现次数）
    const v1Counts = new Map<string, number>();
    const v2Counts = new Map<string, number>();
    for (const p of ps) {
      for (const t of p.v1_top10.slice(0, 3)) v1Counts.set(t.card_name, (v1Counts.get(t.card_name) ?? 0) + 1);
      for (const t of p.v2_top10.slice(0, 3)) v2Counts.set(t.card_name, (v2Counts.get(t.card_name) ?? 0) + 1);
    }
    const top3v1 = [...v1Counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => `${e[0]}(${e[1]})`);
    const top3v2 = [...v2Counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => `${e[0]}(${e[1]})`);
    const overlap = [...v2Counts.keys()].filter(k => v1Counts.has(k) && [...v1Counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]).includes(k)).length;
    persona_top3[priority] = {
      priority,
      users: ps.map(p => p.user_name),
      v1_top3: top3v1,
      v2_top3: top3v2,
      top3_overlap: overlap,
    };
  }

  // Ranking churn
  const primaryChanged = perUser.filter(p => p.primary_card_changed).length;
  const jaccards = perUser.map(p =>
    jaccard(new Set(p.v1_top10.map(x => x.card_id)), new Set(p.v2_top10.map(x => x.card_id)))
  );
  const avgJac = jaccards.length ? jaccards.reduce((a, b) => a + b, 0) / jaccards.length : 1;
  const avgAdded = perUser.length
    ? perUser.reduce((a, b) => a + b.top10_added_in_v2.length, 0) / perUser.length
    : 0;

  const report: AggregateReport = {
    generated_at: new Date().toISOString(),
    total_users: perUser.length,
    bit2go: {
      v1_ranks: v1Ranks,
      v2_ranks: v2Ranks,
      v1_avg_rank: v1AvgRank,
      v2_avg_rank: v2AvgRank,
      v1_times_top1: v1Top1,
      v2_times_top1: v2Top1,
    },
    score_distribution_top10: scoreDistTop10,
    score_distribution_full: scoreDistFull,
    persona_top3,
    ranking_churn: {
      users_with_primary_changed: primaryChanged,
      avg_top10_jaccard: avgJac,
      avg_top10_added: avgAdded,
    },
    per_user: perUser,
  };

  // ---- Write full JSON ----
  const outPath = resolve(process.cwd(), "data/v1-v2-compare.json");
  ensureDir(outPath);
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  // ---- Print concise summary ----
  const sep = "─".repeat(72);
  console.log("\n" + sep);
  console.log("  SCORING v1 vs v2 · Comparison Report");
  console.log(sep);
  console.log(`Generated:  ${report.generated_at}`);
  console.log(`Users:      ${report.total_users}`);
  console.log(`Full JSON:  data/v1-v2-compare.json`);

  console.log("\n# Bit2Go (#23, promoted card)");
  console.log(`  v1 avg rank: ${v1AvgRank?.toFixed(2) ?? "n/a"}   (top1 for ${v1Top1}/${perUser.length} users)`);
  console.log(`  v2 avg rank: ${v2AvgRank?.toFixed(2) ?? "n/a"}   (top1 for ${v2Top1}/${perUser.length} users)`);
  console.log(`  v1 ranks:    [${v1Ranks.join(", ")}]`);
  console.log(`  v2 ranks:    [${v2Ranks.join(", ")}]`);
  if (v2Top1 === 0 && v1Top1 > 0) {
    console.log(`  ✓ G4 verified: Bit2Go no longer top-1 for all users under v2 (promoted-slot separated).`);
  }

  console.log("\n# Score distribution · top-10 per user");
  console.log(`  v1  mean=${scoreDistTop10.v1_mean.toFixed(2)}  stddev=${scoreDistTop10.v1_stddev.toFixed(2)}  n=${scoreDistTop10.v1_all_scores}`);
  console.log(`  v2  mean=${scoreDistTop10.v2_mean.toFixed(2)}  stddev=${scoreDistTop10.v2_stddev.toFixed(2)}  n=${scoreDistTop10.v2_all_scores}`);

  console.log("\n# Score distribution · ALL feasible cards");
  console.log(`  v1  mean=${scoreDistFull.v1_mean.toFixed(2)}  stddev=${scoreDistFull.v1_stddev.toFixed(2)}  range=[${scoreDistFull.v1_min.toFixed(1)}, ${scoreDistFull.v1_max.toFixed(1)}]  n=${scoreDistFull.v1_all_scores}`);
  console.log(`  v2  mean=${scoreDistFull.v2_mean.toFixed(2)}  stddev=${scoreDistFull.v2_stddev.toFixed(2)}  range=[${scoreDistFull.v2_min.toFixed(1)}, ${scoreDistFull.v2_max.toFixed(1)}]  n=${scoreDistFull.v2_all_scores}`);
  console.log(`  histogram (all feasible cards, bin width 10):`);
  console.log(`    range        v1     v2`);
  for (let i = 0; i < scoreDistFull.v1_hist.length; i++) {
    const r = scoreDistFull.v1_hist[i].range.padEnd(12);
    const v1c = String(scoreDistFull.v1_hist[i].count).padStart(5);
    const v2c = String(scoreDistFull.v2_hist[i].count).padStart(5);
    console.log(`    ${r} ${v1c}  ${v2c}`);
  }

  console.log("\n# Persona top3 (dominant priority across users)");
  for (const [prio, p] of Object.entries(persona_top3)) {
    console.log(`  · ${prio}  (users: ${p.users.join(", ")})`);
    console.log(`      v1 top3: ${p.v1_top3.join(" | ") || "-"}`);
    console.log(`      v2 top3: ${p.v2_top3.join(" | ") || "-"}`);
  }

  console.log("\n# Ranking churn");
  console.log(`  Users with different #1:   ${primaryChanged}/${perUser.length}`);
  console.log(`  Avg top-10 Jaccard overlap: ${avgJac.toFixed(3)}  (1.0 = same sets)`);
  console.log(`  Avg # new cards into v2 top-10: ${avgAdded.toFixed(2)}`);

  console.log("\n# Per-user primary changes");
  console.log(`  user                 v1 #1                             v2 #1`);
  console.log("  " + "-".repeat(80));
  for (const p of perUser) {
    const flag = p.primary_card_changed ? "*" : " ";
    const u = (p.user_name || p.user_id).padEnd(20);
    const v1 = (p.v1_primary?.card_name ?? "-").padEnd(32);
    const v2 = p.v2_primary?.card_name ?? "-";
    console.log(`  ${flag} ${u} ${v1} ${v2}`);
  }

  console.log(sep);
  console.log("  (* = primary card changed between v1 and v2)");
  console.log(sep + "\n");
}

// Always run main when executed directly (both Bun and node --strip-types).
main();
