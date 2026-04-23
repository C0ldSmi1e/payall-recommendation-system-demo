import Anthropic from "@anthropic-ai/sdk";
import type {
  User, Card, SendFn, StepMeta, UserState, UserAnalysis,
  PreferenceProfile, PerceptionResult, FinalRecommendation,
} from "./types";
import {
  applyQuickFixOverrides, getExcludedCardIds, buildFeedbackContext,
} from "./feedback";
import {
  STEP_USER_ANALYSIS_SYSTEM, buildUserAnalysisPrompt,
  STEP6_SYSTEM,
} from "./prompt";
import { runConstraintEngine } from "./engine/constraint";
import { computeCardPerception } from "./engine/perception";
import { rescoreAndSort } from "./engine/scoring";
import { rescoreAndSortV2, buildV2Context, overrideFinalRecWithV2Scores } from "./engine/scoring-v2";
import type { MultiOutcomeCardV2 } from "./engine/scoring-v2/types";
import { validateStepOutput, type ValidationResult } from "./engine/validators";
import { inferLocation, type InferredLocation } from "./engine/location";

/**
 * Dark-launch 开关：`SCORING_VERSION=v2` 启用新 scoring，其他值走 v1。
 * 默认 v1（回滚零风险）。v2 在打分之外还会附加 `v2_trace` 用于 UI / debug / AB 对比。
 */
function getScoringVersion(): "v1" | "v2" {
  const v = (process.env.SCORING_VERSION || "").toLowerCase();
  return v === "v2" ? "v2" : "v1";
}

function rescoreAndSortByVersion(
  cards: MultiOutcomeCardV2[],
  allCards: Card[],
  user: User,
  userState: UserState,
  preferences: PreferenceProfile,
): void {
  const version = getScoringVersion();
  if (version === "v2") {
    const ctx = buildV2Context();
    rescoreAndSortV2(cards, allCards, user, userState, preferences, ctx);
  } else {
    rescoreAndSort(cards, preferences);
  }
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = "claude-sonnet-4-6"; // ALL Sonnet for speed — target <15s total

// ---- Pipeline steps (shown to user) ----

export const PIPELINE_STEPS: StepMeta[] = [
  { id: "user_analysis", name: "用户分析", description: "分析消费模式、位置和偏好" },
  { id: "card_scoring", name: "卡片评分", description: "筛选和评分所有可用卡片" },
  { id: "final_recommendation", name: "生成推荐", description: "选择最佳卡片并生成个性化理由" },
];

export const RERANK_STEPS: StepMeta[] = [
  { id: "rerank_final", name: "重新推荐", description: "根据反馈更新推荐" },
];

// ---- Personalization context ----

function buildPersonalizationContext(user: User, inferredLoc: InferredLocation, perceptionResult: PerceptionResult, cards: Card[]) {
  let locationEvidence = "";
  if (inferredLoc.primary_country !== user.country.toUpperCase()) {
    locationEvidence = `IMPORTANT: Registered in ${user.country}, but actual location is ${inferredLoc.primary_country} (${inferredLoc.confidence}). ${inferredLoc.evidence}`;
  } else {
    locationEvidence = `User is in ${inferredLoc.primary_country}. ${inferredLoc.evidence}`;
  }

  const txns = user.transaction_history;
  const catSpend: Record<string, { total: number; count: number }> = {};
  let totalSpend = 0;
  for (const t of txns) {
    if (!catSpend[t.category]) catSpend[t.category] = { total: 0, count: 0 };
    catSpend[t.category].total += t.amount_usd; catSpend[t.category].count++; totalSpend += t.amount_usd;
  }
  const sorted = Object.entries(catSpend).sort((a, b) => b[1].total - a[1].total);
  const spendingAnalysis = txns.length > 0
    ? [`Total: $${totalSpend.toFixed(0)} (${txns.length} txns)`, ...sorted.slice(0, 5).map(([c, d]) => `  ${c}: $${d.total.toFixed(0)} (${((d.total / totalSpend) * 100).toFixed(0)}%, avg $${(d.total / d.count).toFixed(0)})`)].join("\n")
    : "No transaction history";

  const ownedCards = user.owned_card_ids.map((id) => cards.find((c) => c.id === id)).filter(Boolean) as Card[];
  const gaps: string[] = [];
  for (const c of ownedCards) {
    if (user.needs_apple_pay && c.apple_wallet_support === 0) gaps.push(`${c.card_name} lacks Apple Pay`);
    try { const cb = JSON.parse(c.cashback || "[]"); if (!cb || (Array.isArray(cb) && cb.length === 0)) gaps.push(`${c.card_name} has no cashback`); } catch { gaps.push(`${c.card_name} has no cashback`); }
  }

  const top5 = perceptionResult.cards.slice(0, 5);
  const perceptionData = top5.map((c) => `${c.card_name}(#${c.card_id}): score=${c.composite_score}, savings=$${c.outcomes.e_monthly_savings}, features=${(c.outcomes.feature_coverage * 100).toFixed(0)}%`).join("\n");

  const BIT2GO_ID = 23;
  const hasBit2Go = user.owned_card_ids.includes(BIT2GO_ID);
  const bit2GoTxns = txns.filter((t) => t.card_id === BIT2GO_ID);
  const bit2GoSpend = bit2GoTxns.reduce((s, t) => s + t.amount_usd, 0);
  const bit2goStatus = !hasBit2Go
    ? `No Bit2Go. OPEN CARD opportunity. Monthly: $${user.monthly_spend_usd}.`
    : bit2GoTxns.length < 10 ? `Has Bit2Go, LOW USAGE (${bit2GoTxns.length} txns, $${bit2GoSpend.toFixed(0)}). TOP-UP opportunity.`
    : `Has Bit2Go, ACTIVE (${bit2GoTxns.length} txns, $${bit2GoSpend.toFixed(0)}). INCREASE_USAGE/CASHOUT.`;

  return { locationEvidence, spendingAnalysis, currentCardGaps: gaps.join("\n"), perceptionData, bit2goStatus };
}

// ---- Pipeline cache ----

interface PipelineCache {
  user: User;
  userState: UserState;
  preferenceProfile: PreferenceProfile;
  perceptionResult: PerceptionResult;
  cards: Card[];
  personalizationContext: ReturnType<typeof buildPersonalizationContext>;
}
const pipelineCache = new Map<string, PipelineCache>();

// ---- JSON parsing ----

function parseJsonSafe(text: string): any {
  const fenced = text.match(/```json\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenced) { try { return JSON.parse(fenced[1]); } catch {} }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch {}
  }
  if (first === -1) throw new Error("No JSON in response");

  // Repair truncated JSON
  let raw = text.slice(first);
  raw = raw.replace(/,\s*"[^"]*"?\s*:?\s*[^,}\]]*$/, '').replace(/,\s*$/, '');
  let braces = 0, brackets = 0, inStr = false, esc = false;
  for (const ch of raw) {
    if (esc) { esc = false; continue; } if (ch === '\\') { esc = true; continue; }
    if (ch === '"' && !esc) { inStr = !inStr; continue; } if (inStr) continue;
    if (ch === '{') braces++; if (ch === '}') braces--;
    if (ch === '[') brackets++; if (ch === ']') brackets--;
  }
  if (inStr) raw += '"';
  while (brackets > 0) { raw += ']'; brackets--; }
  while (braces > 0) { raw += '}'; braces--; }
  try { return JSON.parse(raw); } catch {}
  throw new Error("Could not parse JSON");
}

// ---- Step runner ----

async function runStep<T>(stepId: string, systemPrompt: string, userPrompt: string, send: SendFn, model: string, maxTokens: number): Promise<T> {
  send("step_start", { stepId });
  let text = "";
  try {
    const stream = client.messages.stream({ model, max_tokens: maxTokens, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
        send("step_stream", { stepId, chunk: event.delta.text });
      }
    }
  } catch (err: any) {
    console.error(`[${stepId}] Stream error:`, err.message);
  }
  const result = parseJsonSafe(text) as T;
  const jsonStart = text.indexOf('{');
  send("step_done", { stepId, reasoning: jsonStart > 0 ? text.slice(0, jsonStart).trim() : "", result });
  return result;
}

function buildCardMeta(cards: Card[], cardIds: Set<number>) {
  return cards.filter((c) => cardIds.has(c.id)).map((c) => ({
    id: c.id, card_name: c.card_name, vendor: c.vendor, card_type: c.card_type,
    is_credit: c.is_credit, kyc_required: c.kyc_required,
    has_physical_card: c.has_physical_card, has_virtual_card: c.has_virtual_card,
    based_crypto: c.based_crypto, cashback_max: c.cashback_max, fees: c.fees,
    spending_limits: c.spending_limits, atm_withdrawal_support: c.atm_withdrawal_support,
    apple_wallet_support: c.apple_wallet_support, google_pay_support: c.google_pay_support,
    wechat_pay_support: c.wechat_pay_support, alipay_support: c.alipay_support,
    key_features: c.key_features, card_image_thumbnail: c.card_image_thumbnail,
    general_ratings: c.general_ratings,
  }));
}

// ==================================================================
// MAIN PIPELINE: 2 LLM calls, all Sonnet, target <15s
//   Call 1: User Analysis (~4s)
//   Deterministic: constraint + perception + scoring (0ms)
//   Call 2: Combined ranking + recommendation (~8s)
// ==================================================================

export async function runPipeline(user: User, cards: Card[], send: SendFn): Promise<void> {
  send("plan", { steps: PIPELINE_STEPS });

  // ---- LLM Call 1: User Analysis (Sonnet, ~4s) ----
  const analysis = await runStep<UserAnalysis>(
    "user_analysis", STEP_USER_ANALYSIS_SYSTEM, buildUserAnalysisPrompt(user, cards),
    send, MODEL, 3000
  );
  const userState = analysis.user_state;
  const preferenceProfile = analysis.preferences;

  // ---- Deterministic: Constraint + Perception + Scoring (0ms) ----
  send("step_start", { stepId: "card_scoring" });

  const inferredLoc = inferLocation(user);
  const { feasibleSet } = runConstraintEngine(userState, cards, user);

  if (feasibleSet.feasible.length === 0) {
    send("step_error", { stepId: "card_scoring", error: "No feasible cards." }); return;
  }

  const feasibleIds = new Set(feasibleSet.feasible.map((f) => f.card_id));
  const feasibleCards = cards.filter((c) => feasibleIds.has(c.id));
  const perceptionResult = computeCardPerception(feasibleCards, user, preferenceProfile);
  // Dark-launch switch: SCORING_VERSION=v2 activates new scoring (attaches v2_trace too).
  rescoreAndSortByVersion(
    perceptionResult.cards as MultiOutcomeCardV2[],
    cards, user, userState, preferenceProfile,
  );

  const personalizationContext = buildPersonalizationContext(user, inferredLoc, perceptionResult, cards);

  send("step_done", {
    stepId: "card_scoring",
    reasoning: `${feasibleSet.feasible.length} cards scored. Top: ${perceptionResult.cards.slice(0, 3).map(c => `${c.card_name}(${c.composite_score})`).join(", ")}`,
    result: { feasible: feasibleSet.feasible.length, top3: perceptionResult.cards.slice(0, 3).map(c => ({ name: c.card_name, score: c.composite_score })) },
  });

  pipelineCache.set(user.id, { user, userState, preferenceProfile, perceptionResult, cards, personalizationContext });

  // ---- LLM Call 2: Combined Ranking + Recommendation (Sonnet, ONE call, ~8s) ----
  const excludedIds = new Set(getExcludedCardIds(user.id));
  const top10 = perceptionResult.cards.filter((c) => !excludedIds.has(c.card_id)).slice(0, 10);
  const top10Ids = new Set(top10.map((c) => c.card_id));
  const top10CardDetails = cards.filter((c) => top10Ids.has(c.id));

  // Build combined prompt: ranking context + final output instruction
  const cardContext = top10.map((c) => {
    const detail = top10CardDetails.find((d) => d.id === c.card_id);
    return `#${c.card_id} ${c.card_name}: score=${c.composite_score}, activation=${c.outcomes.p_activation_success.toFixed(2)}, savings=$${c.outcomes.e_monthly_savings}, features=${(c.outcomes.feature_coverage * 100).toFixed(0)}%, friction=${c.outcomes.friction_score.toFixed(2)}`;
  }).join("\n");

  const combinedPrompt = `## Top 10 Scored Cards (pre-ranked by deterministic engine)
${cardContext}

## User Preferences
${JSON.stringify(preferenceProfile, null, 2)}

${personalizationContext.bit2goStatus ? `## Bit2Go Status\n${personalizationContext.bit2goStatus}\n` : ""}
${personalizationContext.locationEvidence ? `## Location\n${personalizationContext.locationEvidence}\n` : ""}
${personalizationContext.spendingAnalysis ? `## Spending\n${personalizationContext.spendingAnalysis}\n` : ""}
${personalizationContext.currentCardGaps ? `## Gaps\n${personalizationContext.currentCardGaps}\n` : ""}

## User State
${userState.summary}
Journey: ${userState.journey_position} | Mode: ${userState.current_mode}

Select 1 primary + 2 backups from the top 10. Output the final recommendation with insights, bit2go_action, score_breakdown, savings, and conversion_hook. Be concise.`;

  const finalRec = await runStep<FinalRecommendation>(
    "final_recommendation", STEP6_SYSTEM, combinedPrompt,
    send, MODEL, 6000
  );

  const finalWithFixes = applyQuickFixOverrides(user.id, finalRec);
  // G5 wire-up: override LLM-编的 score/score_breakdown with scoring-v2 determ. trace.
  // 在 v1 模式下 perception cards 没有 v2_trace，函数无副作用。
  overrideFinalRecWithV2Scores(finalWithFixes, perceptionResult.cards as MultiOutcomeCardV2[]);
  const recCardIds = new Set([finalWithFixes.primary.card_id, ...finalWithFixes.backups.map((b) => b.card_id)]);

  send("pipeline_done", {
    recommendation: finalWithFixes,
    cards: buildCardMeta(cards, recCardIds),
    location: { inferred: inferredLoc.primary_country, registered: user.country, evidence: inferredLoc.evidence, confidence: inferredLoc.confidence },
  });
}

// ---- Re-rank (1 LLM call only) ----

export async function reRankPipeline(userId: string, send: SendFn): Promise<void> {
  const cache = pipelineCache.get(userId);
  if (!cache) { send("step_error", { stepId: "rerank_final", error: "Run full pipeline first." }); return; }

  send("plan", { steps: RERANK_STEPS });
  const { user, userState, preferenceProfile, perceptionResult, cards, personalizationContext } = cache;
  const feedbackContext = buildFeedbackContext(userId);
  const excludedIds = new Set(getExcludedCardIds(userId));
  const remaining = perceptionResult.cards.filter((c) => !excludedIds.has(c.card_id));
  rescoreAndSortByVersion(
    remaining as MultiOutcomeCardV2[],
    cards, user, userState, preferenceProfile,
  );
  if (remaining.length === 0) { send("step_error", { stepId: "rerank_final", error: "No cards left." }); return; }

  const top10 = remaining.slice(0, 10);
  const top10CardDetails = cards.filter((c) => new Set(top10.map(t => t.card_id)).has(c.id));

  // Single Sonnet call for rerank
  const cardContext = top10.map((c) => `#${c.card_id} ${c.card_name}: score=${c.composite_score}`).join("\n");
  const reRankPrompt = `## Feedback\n${feedbackContext}\n\n## Top Cards\n${cardContext}\n\n## User\n${userState.summary}\n${personalizationContext.bit2goStatus||''}\n${personalizationContext.locationEvidence||''}\n\nRe-select 1 primary + 2 backups. Output final recommendation JSON.`;

  const finalRec = await runStep<FinalRecommendation>(
    "rerank_final", STEP6_SYSTEM, reRankPrompt,
    send, MODEL, 6000
  );

  const finalWithFixes = applyQuickFixOverrides(userId, finalRec);
  // G5 wire-up (rerank 路径也走同一个 override)
  overrideFinalRecWithV2Scores(finalWithFixes, remaining as MultiOutcomeCardV2[]);
  const recCardIds = new Set([finalWithFixes.primary.card_id, ...finalWithFixes.backups.map((b) => b.card_id)]);
  send("pipeline_done", { recommendation: finalWithFixes, cards: buildCardMeta(cards, recCardIds) });
}
