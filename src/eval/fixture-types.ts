import type { User } from "../types";

/**
 * Evaluation fixture: a user profile paired with annotated expected outcomes.
 * Used by the eval harness to measure recommendation quality.
 */
export interface EvalFixture {
  // Metadata
  id: string;
  name: string;
  description: string;

  // Input
  user: User;

  // Expected outcomes (ground truth)
  expectations: {
    // Step 2: Constraint engine
    constraint: {
      must_eliminate: number[];      // Card IDs that MUST be eliminated
      must_keep: number[];           // Card IDs that MUST survive filtering
    };

    // Steps 4-5: Scoring & ranking
    scoring: {
      top_5_must_include: number[];  // Card IDs that should appear in top 5
      top_10_must_include: number[]; // Card IDs that should appear in top 10
      must_not_rank_high: number[];  // Card IDs that should NOT be in top 5
      score_ordering: [number, number][]; // Pairs [cardA, cardB] where A should score > B
    };

    // Steps 5-6: Final recommendation
    recommendation: {
      primary_candidates: number[];   // Any of these is acceptable as primary
      must_not_recommend: number[];   // Must NEVER appear in final recommendation
    };

    // Qualitative checks
    qualitative?: {
      primary_must_have_feature?: string[];  // e.g., ["apple_wallet_support", "has_physical_card"]
      reason_must_mention?: string[];        // Keywords the reason text should contain
    };
  };

  // Annotation metadata
  confidence: "high" | "medium" | "low";
  notes?: string;
}

/**
 * Results from running one fixture through the pipeline.
 */
export interface FixtureResult {
  fixture_id: string;
  fixture_name: string;

  // Raw pipeline outputs
  constraint_feasible_ids: number[];
  constraint_eliminated_ids: number[];
  top_10_card_ids: number[];
  primary_card_id: number;
  backup_card_ids: number[];
  all_recommended_ids: number[];

  // Metric results
  metrics: {
    constraint_precision: number;    // Of eliminated, fraction expected
    constraint_recall: number;       // Of expected eliminated, fraction actually eliminated
    hit_at_1: boolean;               // Primary is in primary_candidates
    hit_at_3: boolean;               // Any primary_candidate in top 3
    hit_at_5: boolean;               // Any primary_candidate in top 5
    exclusion_compliance: boolean;    // No must_not_recommend in output
    ordering_accuracy: number;       // Fraction of score_ordering pairs correct
    validation_passed: boolean;      // All step validators passed
  };

  // Step validation details
  validation_errors: Record<string, string[]>;
  validation_warnings: Record<string, string[]>;

  // Timing
  duration_ms: number;
}

/**
 * Aggregate report across all fixtures.
 */
export interface EvalReport {
  timestamp: string;
  fixture_count: number;
  results: FixtureResult[];

  aggregate: {
    constraint_precision: number;
    constraint_recall: number;
    hit_at_1: number;       // Fraction of fixtures where primary matches
    hit_at_3: number;
    hit_at_5: number;
    exclusion_compliance: number;
    ordering_accuracy: number;
    validation_pass_rate: number;
    avg_duration_ms: number;
  };
}
