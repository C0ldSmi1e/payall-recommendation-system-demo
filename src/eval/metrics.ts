import type { EvalFixture, FixtureResult } from "./fixture-types";
import type { FeasibleSet, PerceptionResult, FinalRecommendation } from "../types";
import type { ValidationResult } from "../engine/validators";

/**
 * Compute constraint engine metrics.
 */
export function computeConstraintMetrics(
  fixture: EvalFixture,
  feasibleSet: FeasibleSet
): { precision: number; recall: number } {
  const eliminatedIds = new Set(feasibleSet.eliminated.map((e) => e.card_id));
  const feasibleIds = new Set(feasibleSet.feasible.map((f) => f.card_id));
  const expected = fixture.expectations.constraint;

  // Recall: of must_eliminate, how many were actually eliminated?
  const mustElimCount = expected.must_eliminate.length;
  const correctlyEliminated = expected.must_eliminate.filter((id) => eliminatedIds.has(id)).length;
  const recall = mustElimCount > 0 ? correctlyEliminated / mustElimCount : 1.0;

  // Precision check: of must_keep, how many survived?
  const mustKeepCount = expected.must_keep.length;
  const correctlyKept = expected.must_keep.filter((id) => feasibleIds.has(id)).length;
  const precision = mustKeepCount > 0 ? correctlyKept / mustKeepCount : 1.0;

  return { precision, recall };
}

/**
 * Compute Hit@K: whether any of the primary_candidates appear in the top K cards.
 */
export function computeHitAtK(
  primaryCandidates: number[],
  rankedCardIds: number[],
  k: number
): boolean {
  const topK = new Set(rankedCardIds.slice(0, k));
  return primaryCandidates.some((id) => topK.has(id));
}

/**
 * Compute ordering accuracy: fraction of score_ordering pairs correctly ordered.
 */
export function computeOrderingAccuracy(
  scoreOrdering: [number, number][],
  rankedCardIds: number[]
): number {
  if (scoreOrdering.length === 0) return 1.0;

  const rankMap = new Map<number, number>();
  rankedCardIds.forEach((id, i) => rankMap.set(id, i));

  let correct = 0;
  for (const [a, b] of scoreOrdering) {
    const rankA = rankMap.get(a);
    const rankB = rankMap.get(b);
    if (rankA !== undefined && rankB !== undefined && rankA < rankB) {
      correct++;
    }
  }
  return correct / scoreOrdering.length;
}

/**
 * Check exclusion compliance: none of must_not_recommend in the final output.
 */
export function checkExclusionCompliance(
  mustNotRecommend: number[],
  allRecommendedIds: number[]
): boolean {
  const recSet = new Set(allRecommendedIds);
  return !mustNotRecommend.some((id) => recSet.has(id));
}

/**
 * Check qualitative feature requirements on the primary card.
 */
export function checkQualitativeFeatures(
  expectations: EvalFixture["expectations"]["qualitative"],
  primaryCardData: Record<string, unknown> | undefined,
  primaryReason: string
): { featurePass: boolean; reasonPass: boolean; details: string[] } {
  const details: string[] = [];
  let featurePass = true;
  let reasonPass = true;

  if (!expectations) return { featurePass, reasonPass, details };

  if (expectations.primary_must_have_feature && primaryCardData) {
    for (const feat of expectations.primary_must_have_feature) {
      const val = primaryCardData[feat];
      if (val === 0 || val === false || val === undefined) {
        featurePass = false;
        details.push(`Primary card missing required feature: ${feat}`);
      }
    }
  }

  if (expectations.reason_must_mention) {
    const reasonLower = primaryReason.toLowerCase();
    for (const keyword of expectations.reason_must_mention) {
      if (!reasonLower.includes(keyword.toLowerCase())) {
        reasonPass = false;
        details.push(`Reason text missing keyword: "${keyword}"`);
      }
    }
  }

  return { featurePass, reasonPass, details };
}

/**
 * Build a complete FixtureResult from pipeline outputs.
 */
export function buildFixtureResult(
  fixture: EvalFixture,
  feasibleSet: FeasibleSet,
  perceptionCardIds: number[],
  finalRec: FinalRecommendation,
  validationErrors: Record<string, string[]>,
  validationWarnings: Record<string, string[]>,
  durationMs: number
): FixtureResult {
  const constraintMetrics = computeConstraintMetrics(fixture, feasibleSet);
  const exp = fixture.expectations;

  const allRecommendedIds = [
    finalRec.primary.card_id,
    ...finalRec.backups.map((b) => b.card_id),
  ];

  const top10 = perceptionCardIds.slice(0, 10);

  return {
    fixture_id: fixture.id,
    fixture_name: fixture.name,

    constraint_feasible_ids: feasibleSet.feasible.map((f) => f.card_id),
    constraint_eliminated_ids: feasibleSet.eliminated.map((e) => e.card_id),
    top_10_card_ids: top10,
    primary_card_id: finalRec.primary.card_id,
    backup_card_ids: finalRec.backups.map((b) => b.card_id),
    all_recommended_ids: allRecommendedIds,

    metrics: {
      constraint_precision: constraintMetrics.precision,
      constraint_recall: constraintMetrics.recall,
      hit_at_1: computeHitAtK(exp.recommendation.primary_candidates, perceptionCardIds, 1),
      hit_at_3: computeHitAtK(exp.recommendation.primary_candidates, perceptionCardIds, 3),
      hit_at_5: computeHitAtK(exp.recommendation.primary_candidates, perceptionCardIds, 5),
      exclusion_compliance: checkExclusionCompliance(
        exp.recommendation.must_not_recommend,
        allRecommendedIds
      ),
      ordering_accuracy: computeOrderingAccuracy(
        exp.scoring.score_ordering,
        perceptionCardIds
      ),
      validation_passed: Object.values(validationErrors).every((errs) => errs.length === 0),
    },

    validation_errors: validationErrors,
    validation_warnings: validationWarnings,
    duration_ms: durationMs,
  };
}
