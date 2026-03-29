import type {
  UserState,
  FeasibleSet,
  PreferenceProfile,
  PerceptionResult,
  RankingResult,
  FinalRecommendation,
} from "../types";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function ok(): ValidationResult {
  return { valid: true, errors: [], warnings: [] };
}

function fail(errors: string[], warnings: string[] = []): ValidationResult {
  return { valid: false, errors, warnings };
}

// ---- Step 1: UserState ----

export function validateUserState(data: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const s = data as UserState;

  if (!s || typeof s !== "object") return fail(["UserState is not an object"]);

  // Required fields
  if (!s.summary) errors.push("Missing summary");
  if (!s.hard_requirements) errors.push("Missing hard_requirements");
  if (!s.derived_scores) errors.push("Missing derived_scores");
  if (!s.journey_position) errors.push("Missing journey_position");
  if (!s.current_mode) errors.push("Missing current_mode");

  // Derived scores range check
  if (s.derived_scores) {
    const scores = s.derived_scores;
    const scoreFields = [
      "kyc_friction_tolerance",
      "travel_need_score",
      "fee_sensitivity_score",
      "instant_need_score",
      "backup_card_need",
      "spending_diversity",
    ] as const;

    for (const field of scoreFields) {
      const v = scores[field];
      if (typeof v !== "number") {
        errors.push(`derived_scores.${field} is not a number`);
      } else if (v < 0 || v > 1) {
        errors.push(`derived_scores.${field} = ${v} is out of range [0,1]`);
      }
    }
  }

  // Enum checks
  const validPositions = ["new_user", "active_single_card", "multi_card_user", "heavy_spender"];
  if (s.journey_position && !validPositions.includes(s.journey_position)) {
    errors.push(`Invalid journey_position: ${s.journey_position}`);
  }

  const validModes = ["travel", "routine", "exploring", "urgent"];
  if (s.current_mode && !validModes.includes(s.current_mode)) {
    errors.push(`Invalid current_mode: ${s.current_mode}`);
  }

  return errors.length > 0 ? fail(errors, warnings) : ok();
}

// ---- Step 2: FeasibleSet ----

export function validateFeasibleSet(data: unknown, totalCards: number): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const s = data as FeasibleSet;

  if (!s || typeof s !== "object") return fail(["FeasibleSet is not an object"]);
  if (!Array.isArray(s.feasible)) errors.push("feasible is not an array");
  if (!Array.isArray(s.eliminated)) errors.push("eliminated is not an array");

  if (errors.length > 0) return fail(errors);

  // No card in both lists
  const feasibleIds = new Set(s.feasible.map((c) => c.card_id));
  const eliminatedIds = new Set(s.eliminated.map((c) => c.card_id));
  const overlap = [...feasibleIds].filter((id) => eliminatedIds.has(id));
  if (overlap.length > 0) {
    errors.push(`Cards in both feasible and eliminated: ${overlap.join(", ")}`);
  }

  // No duplicates within lists
  if (feasibleIds.size !== s.feasible.length) {
    errors.push("Duplicate card_ids in feasible list");
  }
  if (eliminatedIds.size !== s.eliminated.length) {
    errors.push("Duplicate card_ids in eliminated list");
  }

  // Coverage check
  const total = feasibleIds.size + eliminatedIds.size;
  if (total !== totalCards) {
    warnings.push(`Processed ${total} cards but expected ${totalCards}`);
  }

  // Reason category check
  const validCategories = ["country", "deleted", "owned", "status"];
  for (const e of s.eliminated) {
    if (!validCategories.includes(e.blocked_reason_category)) {
      errors.push(`Invalid blocked_reason_category for card ${e.card_id}: ${e.blocked_reason_category}`);
    }
  }

  return errors.length > 0 ? fail(errors, warnings) : { valid: true, errors: [], warnings };
}

// ---- Step 3: PreferenceProfile ----

export function validatePreferenceProfile(data: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const s = data as PreferenceProfile;

  if (!s || typeof s !== "object") return fail(["PreferenceProfile is not an object"]);

  if (!Array.isArray(s.right_now_priorities)) {
    errors.push("right_now_priorities is not an array");
  } else {
    if (s.right_now_priorities.length < 2) {
      warnings.push("Fewer than 2 priorities — may be underspecified");
    }

    const weightSum = s.right_now_priorities.reduce((sum, p) => sum + (p.weight || 0), 0);
    if (Math.abs(weightSum - 1.0) > 0.05) {
      errors.push(`Priority weights sum to ${weightSum.toFixed(3)}, expected ~1.0`);
    }

    for (const p of s.right_now_priorities) {
      if (typeof p.weight !== "number" || p.weight < 0 || p.weight > 1) {
        errors.push(`Invalid weight for factor "${p.factor}": ${p.weight}`);
      }
    }
  }

  const validBudgets = ["low", "medium", "high"];
  if (s.friction_budget && !validBudgets.includes(s.friction_budget)) {
    errors.push(`Invalid friction_budget: ${s.friction_budget}`);
  }

  const validTradeoffs = ["value", "balanced", "convenience"];
  if (s.value_vs_convenience && !validTradeoffs.includes(s.value_vs_convenience)) {
    errors.push(`Invalid value_vs_convenience: ${s.value_vs_convenience}`);
  }

  return errors.length > 0 ? fail(errors, warnings) : { valid: true, errors: [], warnings };
}

// ---- Step 4: PerceptionResult ----

export function validatePerceptionResult(data: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const s = data as PerceptionResult;

  if (!s || typeof s !== "object") return fail(["PerceptionResult is not an object"]);
  if (!Array.isArray(s.cards)) return fail(["cards is not an array"]);

  const ids = new Set<number>();
  for (let i = 0; i < s.cards.length; i++) {
    const card = s.cards[i];
    if (ids.has(card.card_id)) {
      errors.push(`Duplicate card_id: ${card.card_id}`);
    }
    ids.add(card.card_id);

    const o = card.outcomes;
    if (!o) {
      errors.push(`Card ${card.card_id} missing outcomes`);
      continue;
    }

    // Range checks for 0-1 dimensions
    const dims = ["p_activation_success", "feature_coverage", "friction_score", "risk_score", "complementarity"] as const;
    for (const dim of dims) {
      const v = o[dim];
      if (typeof v !== "number") {
        errors.push(`Card ${card.card_id}: ${dim} is not a number`);
      } else if (v < 0 || v > 1) {
        errors.push(`Card ${card.card_id}: ${dim} = ${v} out of [0,1]`);
      }
    }

    // e_monthly_savings must be non-negative
    if (typeof o.e_monthly_savings !== "number" || o.e_monthly_savings < 0) {
      errors.push(`Card ${card.card_id}: e_monthly_savings = ${o.e_monthly_savings} invalid`);
    }

    // composite_score in [0,100]
    if (typeof card.composite_score !== "number" || card.composite_score < 0 || card.composite_score > 100) {
      errors.push(`Card ${card.card_id}: composite_score = ${card.composite_score} out of [0,100]`);
    }
  }

  // Check sorted order
  for (let i = 1; i < s.cards.length; i++) {
    if (s.cards[i].composite_score > s.cards[i - 1].composite_score) {
      warnings.push("Cards not sorted by composite_score descending");
      break;
    }
  }

  return errors.length > 0 ? fail(errors, warnings) : { valid: true, errors: [], warnings };
}

// ---- Step 5: RankingResult ----

export function validateRankingResult(data: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const s = data as RankingResult;

  if (!s || typeof s !== "object") return fail(["RankingResult is not an object"]);
  if (!Array.isArray(s.ranked)) return fail(["ranked is not an array"]);

  const primaries = s.ranked.filter((c) => c.role === "primary");
  const backups = s.ranked.filter((c) => c.role === "backup");

  if (primaries.length !== 1) {
    errors.push(`Expected exactly 1 primary, got ${primaries.length}`);
  }
  if (backups.length < 1) {
    errors.push(`Expected at least 1 backup, got ${backups.length}`);
  }

  const ids = new Set<number>();
  for (const c of s.ranked) {
    if (ids.has(c.card_id)) {
      errors.push(`Duplicate card_id in ranking: ${c.card_id}`);
    }
    ids.add(c.card_id);

    if (typeof c.final_score !== "number" || c.final_score < 0 || c.final_score > 100) {
      errors.push(`Card ${c.card_id}: final_score = ${c.final_score} out of [0,100]`);
    }

    const validRoles = ["primary", "backup", "contender"];
    if (!validRoles.includes(c.role)) {
      errors.push(`Card ${c.card_id}: invalid role "${c.role}"`);
    }
  }

  if (!s.head_to_head_summary) {
    warnings.push("Missing head_to_head_summary");
  }

  return errors.length > 0 ? fail(errors, warnings) : { valid: true, errors: [], warnings };
}

// ---- Step 6: FinalRecommendation ----

export function validateFinalRecommendation(data: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const s = data as FinalRecommendation;

  if (!s || typeof s !== "object") return fail(["FinalRecommendation is not an object"]);

  // Primary
  if (!s.primary) {
    errors.push("Missing primary recommendation");
  } else {
    if (!s.primary.card_id) errors.push("Primary missing card_id");
    if (!s.primary.card_name) errors.push("Primary missing card_name");
    if (typeof s.primary.score !== "number" || s.primary.score < 0 || s.primary.score > 100) {
      errors.push(`Primary score = ${s.primary.score} out of [0,100]`);
    }
    if (s.primary.tagline && s.primary.tagline.split(/\s+/).length > 15) {
      warnings.push(`Primary tagline too long: ${s.primary.tagline.split(/\s+/).length} words`);
    }
    if (!s.primary.next_action) {
      errors.push("Primary missing next_action");
    }
  }

  // Backups
  if (!Array.isArray(s.backups)) {
    errors.push("backups is not an array");
  } else {
    if (s.backups.length < 2) {
      warnings.push(`Expected 2 backups, got ${s.backups.length}`);
    }
    for (const b of s.backups) {
      if (!b.card_id) errors.push("Backup missing card_id");
      if (!b.pick_this_if) warnings.push(`Backup ${b.card_id} missing pick_this_if`);
    }
  }

  // Why not others
  if (!Array.isArray(s.why_not_others)) {
    warnings.push("why_not_others is not an array");
  }

  return errors.length > 0 ? fail(errors, warnings) : { valid: true, errors: [], warnings };
}

// ---- Unified validator dispatcher ----

export type StepId = "user_state" | "constraint_engine" | "preference_analysis" | "card_perception" | "reasoning_ranking" | "final_action";

export function validateStepOutput(stepId: StepId, data: unknown, context?: { totalCards?: number }): ValidationResult {
  switch (stepId) {
    case "user_state":
      return validateUserState(data);
    case "constraint_engine":
      return validateFeasibleSet(data, context?.totalCards ?? 0);
    case "preference_analysis":
      return validatePreferenceProfile(data);
    case "card_perception":
      return validatePerceptionResult(data);
    case "reasoning_ranking":
      return validateRankingResult(data);
    case "final_action":
      return validateFinalRecommendation(data);
    default:
      return ok();
  }
}
