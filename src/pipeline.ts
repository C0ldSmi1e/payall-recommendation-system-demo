import Anthropic from "@anthropic-ai/sdk";
import type {
  User,
  Card,
  SendFn,
  StepMeta,
  UserState,
  FeasibleSet,
  PreferenceProfile,
  PerceptionResult,
  RankingResult,
  FinalRecommendation,
} from "./types";
import {
  STEP1_SYSTEM,
  buildStep1Prompt,
  STEP2_SYSTEM,
  buildStep2Prompt,
  STEP3_SYSTEM,
  buildStep3Prompt,
  STEP4_SYSTEM,
  buildStep4Prompt,
  STEP5_SYSTEM,
  buildStep5Prompt,
  STEP6_SYSTEM,
  buildStep6Prompt,
} from "./prompt";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const PIPELINE_STEPS: StepMeta[] = [
  {
    id: "user_state",
    name: "User State Analysis",
    description: "Analyzing user journey, derived scores, intent, and spending patterns",
  },
  {
    id: "constraint_engine",
    name: "Constraint Engine",
    description: "Deterministic filtering — hard constraints only",
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
  send: SendFn
): Promise<{ reasoning: string; result: T }> {
  send("step_start", { stepId });

  let text = "";
  const stream = client.messages.stream({
    model: "claude-sonnet-4-20250514",
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

export async function runPipeline(
  user: User,
  cards: Card[],
  send: SendFn
): Promise<void> {
  send("plan", { steps: PIPELINE_STEPS });

  // Step 1: User State Analysis
  const { result: userState } = await runStep<UserState>(
    "user_state",
    STEP1_SYSTEM,
    buildStep1Prompt(user, cards),
    send
  );

  // Step 2: Constraint Engine
  const { result: feasibleSet } = await runStep<FeasibleSet>(
    "constraint_engine",
    STEP2_SYSTEM,
    buildStep2Prompt(userState, cards),
    send
  );

  if (feasibleSet.feasible.length === 0) {
    send("step_error", {
      stepId: "constraint_engine",
      error: "No feasible cards found for this user.",
    });
    return;
  }

  // Step 3: User Preference Analysis (CoT-Rec Step A)
  const { result: preferenceProfile } = await runStep<PreferenceProfile>(
    "preference_analysis",
    STEP3_SYSTEM,
    buildStep3Prompt(userState),
    send
  );

  // Step 4: Card Perception Analysis (CoT-Rec Step B)
  const feasibleIds = new Set(feasibleSet.feasible.map((f) => f.card_id));
  const feasibleCards = cards.filter((c) => feasibleIds.has(c.id));

  const { result: perceptionResult } = await runStep<PerceptionResult>(
    "card_perception",
    STEP4_SYSTEM,
    buildStep4Prompt(preferenceProfile, feasibleCards),
    send
  );

  // Step 5: Reasoning & Ranking (top 10)
  const top10 = perceptionResult.cards.slice(0, 10);
  const top10Ids = new Set(top10.map((c) => c.card_id));
  const top10CardDetails = cards.filter((c) => top10Ids.has(c.id));

  const { result: rankingResult } = await runStep<RankingResult>(
    "reasoning_ranking",
    STEP5_SYSTEM,
    buildStep5Prompt(preferenceProfile, top10, top10CardDetails),
    send
  );

  // Step 6: Final Recommendation & Action Plan
  const { result: finalRec } = await runStep<FinalRecommendation>(
    "final_action",
    STEP6_SYSTEM,
    buildStep6Prompt(userState, rankingResult),
    send
  );

  // Attach card metadata for display
  const recCardIds = new Set([
    finalRec.primary.card_id,
    ...finalRec.backups.map((b) => b.card_id),
  ]);
  const recCards = cards
    .filter((c) => recCardIds.has(c.id))
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

  send("pipeline_done", { recommendation: finalRec, cards: recCards });
}
