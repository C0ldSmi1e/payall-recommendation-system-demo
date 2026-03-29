import Anthropic from "@anthropic-ai/sdk";
import type {
  User,
  Card,
  SendFn,
  StepMeta,
  UserState,
  PreferenceProfile,
  PerceptionResult,
  RankingResult,
  FinalRecommendation,
} from "./types";
import {
  applyQuickFixOverrides,
  getExcludedCardIds,
  buildFeedbackContext,
} from "./feedback";
import {
  STEP1_SYSTEM,
  buildStep1Prompt,
  STEP3_SYSTEM,
  buildStep3Prompt,
  STEP4_SYSTEM,
  buildStep4Prompt,
  STEP5_SYSTEM,
  buildStep5Prompt,
  STEP6_SYSTEM,
  buildStep6Prompt,
  buildStep5ReRankPrompt,
  buildStep6ReRankPrompt,
} from "./prompt";
import { runConstraintEngine } from "./engine/constraint";
import { rescoreAndSort } from "./engine/scoring";
import { validateStepOutput, type ValidationResult } from "./engine/validators";
import { inferLocation, type InferredLocation } from "./engine/location";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ---- Model selection ----
// Sonnet for fast analysis steps, Opus for the critical scoring step
const MODEL_FAST = "claude-sonnet-4-6";   // Steps 1, 3, 5, 6
const MODEL_DEEP = "claude-opus-4-6";      // Step 4 (card perception — needs deep reasoning)

// ---- Pipeline step metadata ----

export const PIPELINE_STEPS: StepMeta[] = [
  {
    id: "user_state",
    name: "User State Analysis",
    description: "Analyzing user journey, derived scores, intent, and spending patterns",
  },
  {
    id: "constraint_engine",
    name: "Constraint Engine",
    description: "Deterministic filtering + location inference from spending patterns",
  },
  {
    id: "preference_analysis",
    name: "User Preference Analysis",
    description: "CoT-Rec Step A — what matters most right now",
  },
  {
    id: "card_perception",
    name: "Card Perception Analysis",
    description: "CoT-Rec Step B — multi-outcome prediction per card",
  },
  {
    id: "reasoning_ranking",
    name: "Reasoning & Ranking",
    description: "Head-to-head comparison, diversity-aware selection",
  },
  {
    id: "final_action",
    name: "Recommendation & Action Plan",
    description: "1 primary + 2 backups + next action",
  },
];

export const RERANK_STEPS: StepMeta[] = [
  {
    id: "rerank_reasoning",
    name: "Re-Ranking with Feedback",
    description: "Re-thinking card selection based on your feedback",
  },
  {
    id: "rerank_final",
    name: "New Recommendation",
    description: "Producing updated recommendation",
  },
];

// ---- Personalization context builder ----

function buildPersonalizationContext(
  user: User,
  inferredLoc: InferredLocation,
  perceptionResult: PerceptionResult,
  cards: Card[]
) {
  // Location evidence
  let locationEvidence = "";
  if (inferredLoc.primary_country !== user.country.toUpperCase()) {
    locationEvidence = `IMPORTANT: User's card is registered in ${user.country}, but their actual spending location is ${inferredLoc.primary_country} (${inferredLoc.confidence} confidence). ${inferredLoc.evidence}`;
    if (inferredLoc.secondary_countries.length > 0) {
      locationEvidence += `\nSecondary locations: ${inferredLoc.secondary_countries.join(", ")}`;
    }
  } else {
    locationEvidence = `User is in ${inferredLoc.primary_country}. ${inferredLoc.evidence}`;
  }

  // Spending analysis
  const txns = user.transaction_history;
  const catSpend: Record<string, { total: number; count: number }> = {};
  let totalSpend = 0;
  for (const t of txns) {
    if (!catSpend[t.category]) catSpend[t.category] = { total: 0, count: 0 };
    catSpend[t.category].total += t.amount_usd;
    catSpend[t.category].count++;
    totalSpend += t.amount_usd;
  }
  const sortedCats = Object.entries(catSpend).sort((a, b) => b[1].total - a[1].total);
  const spendingAnalysis = txns.length > 0
    ? [
        `Total tracked: $${totalSpend.toFixed(0)} across ${txns.length} transactions`,
        ...sortedCats.slice(0, 5).map(([cat, d]) => {
          const avgPerTx = d.count > 0 ? (d.total / d.count).toFixed(0) : "0";
          return `  ${cat}: $${d.total.toFixed(0)} (${((d.total / totalSpend) * 100).toFixed(0)}%, ${d.count} txns, avg $${avgPerTx}/tx)`;
        }),
      ].join("\n")
    : "No transaction history available";

  // Current card gaps
  const ownedCards = user.owned_card_ids
    .map((id) => cards.find((c) => c.id === id))
    .filter(Boolean) as Card[];
  const gaps: string[] = [];
  if (ownedCards.length > 0) {
    for (const c of ownedCards) {
      if (user.needs_apple_pay && c.apple_wallet_support === 0) gaps.push(`${c.card_name} lacks Apple Pay`);
      if (user.needs_google_pay && c.google_pay_support === 0) gaps.push(`${c.card_name} lacks Google Pay`);
      if (user.needs_wechat_pay && c.wechat_pay_support === 0) gaps.push(`${c.card_name} lacks WeChat Pay`);
      if (user.needs_alipay && c.alipay_support === 0) gaps.push(`${c.card_name} lacks Alipay`);
      try {
        const cashback = JSON.parse(c.cashback || "[]");
        if (!cashback || (Array.isArray(cashback) && cashback.length === 0)) gaps.push(`${c.card_name} has no cashback program`);
      } catch { gaps.push(`${c.card_name} has no cashback program`); }
    }
  }
  const currentCardGaps = gaps.length > 0 ? gaps.join("\n") : "";

  // Top perception scores for context
  const top5 = perceptionResult.cards.slice(0, 5);
  const perceptionData = top5.map((c) =>
    `${c.card_name} (#${c.card_id}): composite=${c.composite_score}, activation=${c.outcomes.p_activation_success}, savings=$${c.outcomes.e_monthly_savings}, features=${c.outcomes.feature_coverage}, friction=${c.outcomes.friction_score}`
  ).join("\n");

  // Bit2Go status (card_id: 23) — our revenue card
  const BIT2GO_ID = 23;
  const hasBit2Go = user.owned_card_ids.includes(BIT2GO_ID);
  const bit2GoTxns = user.transaction_history.filter((t) => t.card_id === BIT2GO_ID);
  const bit2GoSpend = bit2GoTxns.reduce((s, t) => s + t.amount_usd, 0);
  let bit2goStatus: string;
  if (!hasBit2Go) {
    bit2goStatus = `User does NOT have Bit2Go card. This is an OPEN CARD opportunity.\nMonthly spend: $${user.monthly_spend_usd.toLocaleString()} — all going to other cards.\nDrive: open_card action.`;
  } else if (bit2GoTxns.length < 10 || bit2GoSpend < 500) {
    bit2goStatus = `User HAS Bit2Go but LOW USAGE: ${bit2GoTxns.length} transactions, $${bit2GoSpend.toFixed(0)} total spend.\nThis is a TOP-UP opportunity. Drive them to load more funds and use Bit2Go more.\nDrive: topup action.`;
  } else {
    bit2goStatus = `User HAS Bit2Go and is ACTIVE: ${bit2GoTxns.length} transactions, $${bit2GoSpend.toFixed(0)} total spend.\nLook for cashout/optimization opportunities. They could earn more with better usage patterns.\nDrive: increase_usage or cashout action.`;
  }

  return { locationEvidence, spendingAnalysis, currentCardGaps, perceptionData, bit2goStatus };
}

// ---- Pipeline cache (steps 1-4 results per user) ----

interface PipelineCache {
  userState: UserState;
  preferenceProfile: PreferenceProfile;
  perceptionResult: PerceptionResult;
  cards: Card[];
  personalizationContext: ReturnType<typeof buildPersonalizationContext>;
}

const pipelineCache = new Map<string, PipelineCache>();

// ---- Shared step runner ----

function extractJson(text: string): string {
  const fenced = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (fenced) return fenced[1];
  const obj = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (obj) return obj[0];
  throw new Error("No JSON found in response");
}

async function runStep<T>(
  stepId: string,
  systemPrompt: string,
  userPrompt: string,
  send: SendFn,
  model: string = MODEL_FAST
): Promise<{ reasoning: string; result: T }> {
  send("step_start", { stepId });

  let text = "";
  const stream = client.messages.stream({
    model,
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      text += event.delta.text;
      send("step_stream", { stepId, chunk: event.delta.text });
    }
  }

  const jsonStr = extractJson(text);
  const result = JSON.parse(jsonStr) as T;
  const reasoning = text
    .replace(jsonStr, "")
    .replace(/```json\s*\n?\s*```/g, "")
    .trim();

  send("step_done", { stepId, reasoning, result });
  return { reasoning, result };
}

// ---- Validation helper ----

function logValidation(stepId: string, v: ValidationResult, send: SendFn) {
  if (!v.valid) {
    console.warn(`[VALIDATOR] ${stepId} FAILED:`, v.errors);
    send("step_warning", { stepId, type: "validation", errors: v.errors, warnings: v.warnings });
  } else if (v.warnings.length > 0) {
    console.warn(`[VALIDATOR] ${stepId} warnings:`, v.warnings);
    send("step_warning", { stepId, type: "validation", errors: [], warnings: v.warnings });
  }
}

// ---- Helper: build card metadata for frontend ----

function buildCardMeta(cards: Card[], cardIds: Set<number>) {
  return cards
    .filter((c) => cardIds.has(c.id))
    .map((c) => ({
      id: c.id,
      card_name: c.card_name,
      vendor: c.vendor,
      card_type: c.card_type,
      is_credit: c.is_credit,
      kyc_required: c.kyc_required,
      has_physical_card: c.has_physical_card,
      has_virtual_card: c.has_virtual_card,
      based_crypto: c.based_crypto,
      cashback_max: c.cashback_max,
      fees: c.fees,
      spending_limits: c.spending_limits,
      atm_withdrawal_support: c.atm_withdrawal_support,
      apple_wallet_support: c.apple_wallet_support,
      google_pay_support: c.google_pay_support,
      wechat_pay_support: c.wechat_pay_support,
      alipay_support: c.alipay_support,
      key_features: c.key_features,
      card_image_thumbnail: c.card_image_thumbnail,
      general_ratings: c.general_ratings,
    }));
}

// ---- Full pipeline (Steps 1-6) ----
// Execution order:
//   Step 1 (LLM, Sonnet) → [Step 2 (instant) + Step 3 (LLM, Sonnet)] parallel
//   → Step 4 (LLM, Opus) → Step 5 (LLM, Sonnet) → Step 6 (LLM, Sonnet)

export async function runPipeline(
  user: User,
  cards: Card[],
  send: SendFn
): Promise<void> {
  send("plan", { steps: PIPELINE_STEPS });

  // Step 1: User State Analysis (Sonnet — fast)
  const { result: userState } = await runStep<UserState>(
    "user_state",
    STEP1_SYSTEM,
    buildStep1Prompt(user, cards),
    send,
    MODEL_FAST
  );
  logValidation("user_state", validateStepOutput("user_state", userState), send);

  // Step 2 + Step 3 in PARALLEL
  // Step 2: Constraint Engine (DETERMINISTIC — instant, with location inference)
  // Step 3: User Preference Analysis (Sonnet — only needs UserState)

  // Also infer location upfront for personalization context
  const inferredLoc = inferLocation(user);

  const step2Promise = (async () => {
    send("step_start", { stepId: "constraint_engine" });
    const { feasibleSet, inferredLocation } = runConstraintEngine(userState, cards, user);
    const constraintReasoning = [
      `Deterministic filter: ${feasibleSet.feasible.length} feasible, ${feasibleSet.eliminated.length} eliminated out of ${cards.length} total.`,
      ``,
      `Location inference (${inferredLocation.confidence} confidence):`,
      `  ${inferredLocation.evidence}`,
      `  Primary: ${inferredLocation.primary_country} | Secondary: ${inferredLocation.secondary_countries.join(", ") || "none"}`,
      ``,
      `Eliminated:`,
      ...(feasibleSet.eliminated.map((e) => `  - ${e.card_name} (#${e.card_id}): ${e.reason} [${e.blocked_reason_category}]`) || ["  (none)"]),
    ].join("\n");
    send("step_done", { stepId: "constraint_engine", reasoning: constraintReasoning, result: feasibleSet });
    logValidation("constraint_engine", validateStepOutput("constraint_engine", feasibleSet, { totalCards: cards.length }), send);
    return feasibleSet;
  })();

  const step3Promise = runStep<PreferenceProfile>(
    "preference_analysis",
    STEP3_SYSTEM,
    buildStep3Prompt(userState),
    send,
    MODEL_FAST
  );

  const [feasibleSet, { result: preferenceProfile }] = await Promise.all([step2Promise, step3Promise]);
  logValidation("preference_analysis", validateStepOutput("preference_analysis", preferenceProfile), send);

  if (feasibleSet.feasible.length === 0) {
    send("step_error", {
      stepId: "constraint_engine",
      error: "No feasible cards found for this user.",
    });
    return;
  }

  // Step 4: Card Perception Analysis (Opus — needs deep reasoning)
  const feasibleIds = new Set(feasibleSet.feasible.map((f) => f.card_id));
  const feasibleCards = cards.filter((c) => feasibleIds.has(c.id));

  const { result: perceptionResult } = await runStep<PerceptionResult>(
    "card_perception",
    STEP4_SYSTEM,
    buildStep4Prompt(preferenceProfile, feasibleCards),
    send,
    MODEL_DEEP
  );

  // Deterministic re-scoring: overwrite LLM composite_score with formula-based score
  rescoreAndSort(perceptionResult.cards, preferenceProfile);
  logValidation("card_perception", validateStepOutput("card_perception", perceptionResult), send);

  // Build personalization context for Step 6
  const personalizationContext = buildPersonalizationContext(user, inferredLoc, perceptionResult, cards);

  // Cache steps 1-4 for re-ranking
  pipelineCache.set(user.id, {
    userState,
    preferenceProfile,
    perceptionResult,
    cards,
    personalizationContext,
  });

  // Step 5: Reasoning & Ranking (Sonnet — top 10)
  const excludedIds = new Set(getExcludedCardIds(user.id));
  const top10 = perceptionResult.cards
    .filter((c) => !excludedIds.has(c.card_id))
    .slice(0, 10);
  const top10Ids = new Set(top10.map((c) => c.card_id));
  const top10CardDetails = cards.filter((c) => top10Ids.has(c.id));

  const { result: rankingResult } = await runStep<RankingResult>(
    "reasoning_ranking",
    STEP5_SYSTEM,
    buildStep5Prompt(preferenceProfile, top10, top10CardDetails),
    send,
    MODEL_FAST
  );
  logValidation("reasoning_ranking", validateStepOutput("reasoning_ranking", rankingResult), send);

  // Step 6: Final Recommendation & Action Plan (Opus — critical for conversion quality)
  const { result: finalRec } = await runStep<FinalRecommendation>(
    "final_action",
    STEP6_SYSTEM,
    buildStep6Prompt(userState, rankingResult, personalizationContext),
    send,
    MODEL_DEEP
  );
  logValidation("final_action", validateStepOutput("final_action", finalRec), send);

  // Apply quick-fix overrides (KYC/topup only)
  const finalWithFixes = applyQuickFixOverrides(user.id, finalRec);

  // Build card metadata
  const recCardIds = new Set([
    finalWithFixes.primary.card_id,
    ...finalWithFixes.backups.map((b) => b.card_id),
  ]);
  const recCards = buildCardMeta(cards, recCardIds);

  send("pipeline_done", {
    recommendation: finalWithFixes,
    cards: recCards,
    location: { inferred: inferredLoc.primary_country, registered: user.country, evidence: inferredLoc.evidence, confidence: inferredLoc.confidence },
  });
}

// ---- Re-rank pipeline (Steps 5+6 only, with feedback context) ----

export async function reRankPipeline(
  userId: string,
  send: SendFn
): Promise<void> {
  const cache = pipelineCache.get(userId);
  if (!cache) {
    send("step_error", {
      stepId: "rerank_reasoning",
      error: "No cached pipeline results. Run the full pipeline first.",
    });
    return;
  }

  send("plan", { steps: RERANK_STEPS });

  const { userState, preferenceProfile, perceptionResult, cards, personalizationContext } = cache;
  const feedbackContext = buildFeedbackContext(userId);
  const excludedIds = new Set(getExcludedCardIds(userId));

  // Filter out excluded cards and re-score with deterministic engine
  const remaining = perceptionResult.cards.filter(
    (c) => !excludedIds.has(c.card_id)
  );
  rescoreAndSort(remaining, preferenceProfile);

  if (remaining.length === 0) {
    send("step_error", {
      stepId: "rerank_reasoning",
      error: "No remaining cards after filtering. All candidates have been excluded.",
    });
    return;
  }

  const top10 = remaining.slice(0, 10);
  const top10Ids = new Set(top10.map((c) => c.card_id));
  const top10CardDetails = cards.filter((c) => top10Ids.has(c.id));

  // Re-run Step 5 with feedback context (Sonnet)
  const { result: rankingResult } = await runStep<RankingResult>(
    "rerank_reasoning",
    STEP5_SYSTEM,
    buildStep5ReRankPrompt(preferenceProfile, top10, top10CardDetails, feedbackContext),
    send,
    MODEL_FAST
  );

  // Re-run Step 6 with feedback context (Opus)
  const { result: finalRec } = await runStep<FinalRecommendation>(
    "rerank_final",
    STEP6_SYSTEM,
    buildStep6ReRankPrompt(userState, rankingResult, feedbackContext, personalizationContext),
    send,
    MODEL_FAST
  );

  // Apply quick-fix overrides
  const finalWithFixes = applyQuickFixOverrides(userId, finalRec);

  // Build card metadata
  const recCardIds = new Set([
    finalWithFixes.primary.card_id,
    ...finalWithFixes.backups.map((b) => b.card_id),
  ]);
  const recCards = buildCardMeta(cards, recCardIds);

  send("pipeline_done", { recommendation: finalWithFixes, cards: recCards });
}
