import Anthropic from "@anthropic-ai/sdk";
import { Glob } from "bun";
import type { EvalFixture, FixtureResult } from "./fixture-types";
import type {
  Card,
  UserState,
  PreferenceProfile,
  PerceptionResult,
  RankingResult,
  FinalRecommendation,
  SendFn,
} from "../types";
import { users } from "../users";
import { runConstraintEngine } from "../engine/constraint";
import { rescoreAndSort } from "../engine/scoring";
import {
  validateStepOutput,
  type StepId,
  type ValidationResult,
} from "../engine/validators";
import { buildFixtureResult } from "./metrics";
import { buildReport, formatReport } from "./report";
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
} from "../prompt";

// ---- Load fixtures ----

async function loadFixtures(fixtureFilter?: string): Promise<EvalFixture[]> {
  const fixtures: EvalFixture[] = [];
  const glob = new Glob("*.json");
  const fixtureDir = new URL("./fixtures/", import.meta.url).pathname;

  for await (const file of glob.scan(fixtureDir)) {
    const data = await Bun.file(`${fixtureDir}${file}`).json();
    if (fixtureFilter && !data.id.includes(fixtureFilter) && !data.name.includes(fixtureFilter)) {
      continue;
    }

    // Resolve user from users.ts using user_id
    const user = users.find((u) => u.id === data.user_id);
    if (!user) {
      console.warn(`Fixture ${data.id}: user_id "${data.user_id}" not found, skipping`);
      continue;
    }

    fixtures.push({
      ...data,
      user,
    } as EvalFixture);
  }

  return fixtures;
}

// ---- LLM step runner (silent, no SSE) ----

function extractJson(text: string): string {
  const fenced = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (fenced) return fenced[1];
  const obj = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (obj) return obj[0];
  throw new Error("No JSON found in response");
}

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL_FAST = "claude-sonnet-4-6";
const MODEL_DEEP = "claude-opus-4-6";

async function runLLMStep<T>(systemPrompt: string, userPrompt: string, model: string = MODEL_FAST): Promise<T> {
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const jsonStr = extractJson(text);
  return JSON.parse(jsonStr) as T;
}

// ---- Eval modes ----

/**
 * Fast mode: only tests the deterministic constraint engine. No LLM calls.
 */
async function runFastEval(
  fixtures: EvalFixture[],
  cards: Card[]
): Promise<FixtureResult[]> {
  const results: FixtureResult[] = [];

  for (const fixture of fixtures) {
    const start = performance.now();
    const validationErrors: Record<string, string[]> = {};
    const validationWarnings: Record<string, string[]> = {};

    // Simulate a minimal UserState from user profile for constraint engine
    const userState: UserState = {
      summary: "",
      hard_requirements: {
        country: fixture.user.self_reported?.country || fixture.user.country,
        current_location: fixture.user.current_location,
        kyc_status: fixture.user.kyc_verified ? "verified" : "unverified",
        needs_physical: fixture.user.wants_physical_card,
        needs_virtual: fixture.user.wants_virtual_card,
        payment_methods: [
          ...(fixture.user.needs_apple_pay ? ["apple_pay"] : []),
          ...(fixture.user.needs_google_pay ? ["google_pay"] : []),
          ...(fixture.user.needs_wechat_pay ? ["wechat_pay"] : []),
          ...(fixture.user.needs_alipay ? ["alipay"] : []),
        ],
      },
      spending_profile: { monthly_usd: fixture.user.monthly_spend_usd, top_categories: [], spending_pattern: "" },
      preferences: { fee_sensitivity: fixture.user.fee_sensitivity, priorities_ranked: fixture.user.priorities, crypto_preferences: fixture.user.held_cryptos, preferred_topup: fixture.user.preferred_topup_crypto, preferred_currency: fixture.user.preferred_currency },
      deal_breakers: [],
      nice_to_haves: [],
      owned_card_context: "",
      derived_scores: { kyc_friction_tolerance: 0.5, travel_need_score: 0.5, fee_sensitivity_score: 0.5, instant_need_score: 0.5, backup_card_need: 0.5, spending_diversity: 0.5 },
      journey_position: fixture.user.owned_card_ids.length === 0 ? "new_user" : "active_single_card",
      current_mode: "exploring",
      detected_intent: "eval",
    };

    const { feasibleSet } = runConstraintEngine(userState, cards, fixture.user);
    const v = validateStepOutput("constraint_engine", feasibleSet, { totalCards: cards.length });
    validationErrors["constraint_engine"] = v.errors;
    validationWarnings["constraint_engine"] = v.warnings;

    const durationMs = performance.now() - start;

    // Build a minimal result (no LLM data available)
    const result = buildFixtureResult(
      fixture,
      feasibleSet,
      feasibleSet.feasible.map((f) => f.card_id), // No ranking in fast mode
      {
        primary: { card_id: feasibleSet.feasible[0]?.card_id ?? 0, card_name: "N/A (fast mode)", score: 0, tagline: "", reason: "", pros: [], cons: [], next_action: { type: "explore", description: "" } },
        backups: [],
        why_not_others: [],
      },
      validationErrors,
      validationWarnings,
      durationMs
    );

    results.push(result);
  }

  return results;
}

/**
 * Full mode: runs complete pipeline (Steps 1, 3, 4, 5, 6) with LLM + deterministic Step 2 + scoring.
 */
async function runFullEval(
  fixtures: EvalFixture[],
  cards: Card[]
): Promise<FixtureResult[]> {
  const results: FixtureResult[] = [];

  for (const fixture of fixtures) {
    console.log(`\n▶ Running fixture: ${fixture.name}`);
    const start = performance.now();
    const validationErrors: Record<string, string[]> = {};
    const validationWarnings: Record<string, string[]> = {};

    try {
      // Step 1: User State (LLM)
      console.log("  Step 1: User State Analysis...");
      const userState = await runLLMStep<UserState>(
        STEP1_SYSTEM,
        buildStep1Prompt(fixture.user, cards)
      );
      const v1 = validateStepOutput("user_state", userState);
      validationErrors["user_state"] = v1.errors;
      validationWarnings["user_state"] = v1.warnings;

      // Step 2: Constraint Engine (deterministic, with location inference)
      console.log("  Step 2: Constraint Engine (deterministic)...");
      const { feasibleSet, inferredLocation } = runConstraintEngine(userState, cards, fixture.user);
      console.log(`    Location: ${inferredLocation.primary_country} (${inferredLocation.confidence}) — ${inferredLocation.evidence}`);
      const v2 = validateStepOutput("constraint_engine", feasibleSet, { totalCards: cards.length });
      validationErrors["constraint_engine"] = v2.errors;
      validationWarnings["constraint_engine"] = v2.warnings;

      if (feasibleSet.feasible.length === 0) {
        console.log("  ✗ No feasible cards!");
        continue;
      }

      // Step 3: Preference Analysis (LLM)
      console.log("  Step 3: Preference Analysis...");
      const preferenceProfile = await runLLMStep<PreferenceProfile>(
        STEP3_SYSTEM,
        buildStep3Prompt(userState)
      );
      const v3 = validateStepOutput("preference_analysis", preferenceProfile);
      validationErrors["preference_analysis"] = v3.errors;
      validationWarnings["preference_analysis"] = v3.warnings;

      // Step 4: Card Perception (LLM predicts dimensions, code scores)
      console.log("  Step 4: Card Perception...");
      const feasibleIds = new Set(feasibleSet.feasible.map((f) => f.card_id));
      const feasibleCards = cards.filter((c) => feasibleIds.has(c.id));

      const perceptionResult = await runLLMStep<PerceptionResult>(
        STEP4_SYSTEM,
        buildStep4Prompt(preferenceProfile, feasibleCards),
        MODEL_DEEP  // Opus for critical scoring step
      );
      rescoreAndSort(perceptionResult.cards, preferenceProfile);
      const v4 = validateStepOutput("card_perception", perceptionResult);
      validationErrors["card_perception"] = v4.errors;
      validationWarnings["card_perception"] = v4.warnings;

      // Step 5: Ranking (LLM)
      console.log("  Step 5: Reasoning & Ranking...");
      const top10 = perceptionResult.cards.slice(0, 10);
      const top10Ids = new Set(top10.map((c) => c.card_id));
      const top10Details = cards.filter((c) => top10Ids.has(c.id));

      const rankingResult = await runLLMStep<RankingResult>(
        STEP5_SYSTEM,
        buildStep5Prompt(preferenceProfile, top10, top10Details)
      );
      const v5 = validateStepOutput("reasoning_ranking", rankingResult);
      validationErrors["reasoning_ranking"] = v5.errors;
      validationWarnings["reasoning_ranking"] = v5.warnings;

      // Step 6: Final Recommendation (LLM)
      console.log("  Step 6: Final Recommendation...");
      const finalRec = await runLLMStep<FinalRecommendation>(
        STEP6_SYSTEM,
        buildStep6Prompt(userState, rankingResult)
      );
      const v6 = validateStepOutput("final_action", finalRec);
      validationErrors["final_action"] = v6.errors;
      validationWarnings["final_action"] = v6.warnings;

      const durationMs = performance.now() - start;
      console.log(`  ✓ Done in ${(durationMs / 1000).toFixed(1)}s — Primary: ${finalRec.primary.card_name} (#${finalRec.primary.card_id})`);

      const result = buildFixtureResult(
        fixture,
        feasibleSet,
        perceptionResult.cards.map((c) => c.card_id),
        finalRec,
        validationErrors,
        validationWarnings,
        durationMs
      );
      results.push(result);
    } catch (err: any) {
      console.error(`  ✗ Error: ${err.message}`);
      const durationMs = performance.now() - start;
      // Create a failed result
      results.push({
        fixture_id: fixture.id,
        fixture_name: fixture.name,
        constraint_feasible_ids: [],
        constraint_eliminated_ids: [],
        top_10_card_ids: [],
        primary_card_id: 0,
        backup_card_ids: [],
        all_recommended_ids: [],
        metrics: {
          constraint_precision: 0,
          constraint_recall: 0,
          hit_at_1: false,
          hit_at_3: false,
          hit_at_5: false,
          exclusion_compliance: false,
          ordering_accuracy: 0,
          validation_passed: false,
        },
        validation_errors: { ...validationErrors, pipeline: [err.message] },
        validation_warnings: validationWarnings,
        duration_ms: durationMs,
      });
    }
  }

  return results;
}

// ---- CLI entry point ----

async function main() {
  const args = process.argv.slice(2);
  const fastMode = args.includes("--fast");
  const fixtureFilter = args.find((a) => a.startsWith("--fixture="))?.split("=")[1];

  console.log(`Loading cards...`);
  const cards: Card[] = await Bun.file("./cards.json").json();
  console.log(`Loaded ${cards.length} cards`);

  console.log(`Loading fixtures...`);
  const fixtures = await loadFixtures(fixtureFilter);
  console.log(`Loaded ${fixtures.length} fixture(s)`);

  if (fixtures.length === 0) {
    console.log("No fixtures found. Exiting.");
    process.exit(0);
  }

  let results: FixtureResult[];

  if (fastMode) {
    console.log("\n=== FAST MODE: Constraint engine only (no LLM calls) ===\n");
    results = await runFastEval(fixtures, cards);
  } else {
    console.log("\n=== FULL MODE: Running complete pipeline with LLM ===\n");
    results = await runFullEval(fixtures, cards);
  }

  const report = buildReport(results);
  console.log("\n" + formatReport(report));

  // Save report to file
  const reportPath = `./data/eval-report-${Date.now()}.json`;
  await Bun.write(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved to ${reportPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
