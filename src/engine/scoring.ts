import type { MultiOutcomeCard, PreferenceProfile } from "../types";

/**
 * Deterministic composite score calculator.
 *
 * LLM predicts 6 outcome dimensions (0-1), this code combines them
 * into a composite_score (0-100) using the user's preference profile.
 *
 * Formula:
 *   positive = w_act * activation + w_sav * normalize(savings) + w_feat * coverage + w_comp * complementarity
 *   penalty  = frictionPenalty(friction, budget) + RISK_WEIGHT * risk
 *   score    = clamp(0, 100, (positive - penalty) * 100)
 */

// ---- Tunable hyperparameters ----

const RISK_WEIGHT = 0.15;
const SAVINGS_CEILING_USD = 50; // $50/mo savings = normalized score of 1.0

const FRICTION_MULTIPLIERS: Record<string, number> = {
  low: 0.40,    // Low friction tolerance → heavy penalty
  medium: 0.20,
  high: 0.10,   // High tolerance → mild penalty
};

// Maps user preference factors → outcome dimension weights.
// Each row sums to 1.0 for that factor.
const FACTOR_MAP: Record<string, DimensionWeights> = {
  low_fees:            { activation: 0.15, savings: 0.55, features: 0.20, complementarity: 0.10 },
  cashback:            { activation: 0.10, savings: 0.60, features: 0.20, complementarity: 0.10 },
  privacy:             { activation: 0.25, savings: 0.10, features: 0.45, complementarity: 0.20 },
  high_spending_limit: { activation: 0.15, savings: 0.25, features: 0.45, complementarity: 0.15 },
  no_kyc:              { activation: 0.50, savings: 0.10, features: 0.20, complementarity: 0.20 },
  travel_perks:        { activation: 0.15, savings: 0.25, features: 0.40, complementarity: 0.20 },
  wide_acceptance:     { activation: 0.20, savings: 0.15, features: 0.50, complementarity: 0.15 },
  atm_access:          { activation: 0.15, savings: 0.15, features: 0.55, complementarity: 0.15 },
  wechat_alipay:       { activation: 0.15, savings: 0.10, features: 0.60, complementarity: 0.15 },
  multi_currency:      { activation: 0.15, savings: 0.25, features: 0.40, complementarity: 0.20 },
  security:            { activation: 0.20, savings: 0.10, features: 0.50, complementarity: 0.20 },
};

const DEFAULT_WEIGHTS: DimensionWeights = {
  activation: 0.25,
  savings: 0.25,
  features: 0.30,
  complementarity: 0.20,
};

// ---- Types ----

interface DimensionWeights {
  activation: number;
  savings: number;
  features: number;
  complementarity: number;
}

// ---- Core functions ----

function normalizeSavings(savingsUsd: number): number {
  return Math.min(1.0, Math.max(0, savingsUsd) / SAVINGS_CEILING_USD);
}

function computeFrictionPenalty(
  frictionScore: number,
  frictionBudget: string
): number {
  const multiplier = FRICTION_MULTIPLIERS[frictionBudget] ?? FRICTION_MULTIPLIERS.medium;
  return frictionScore * multiplier;
}

/**
 * Map user preference factors to outcome dimension weights.
 * Blends all priority factors proportional to their user-assigned weights.
 */
export function mapPreferencesToWeights(
  preferences: PreferenceProfile
): DimensionWeights {
  const weights: DimensionWeights = { activation: 0, savings: 0, features: 0, complementarity: 0 };

  if (!preferences.right_now_priorities || preferences.right_now_priorities.length === 0) {
    return { ...DEFAULT_WEIGHTS };
  }

  for (const { factor, weight } of preferences.right_now_priorities) {
    const mapping = FACTOR_MAP[factor] ?? DEFAULT_WEIGHTS;
    weights.activation += weight * mapping.activation;
    weights.savings += weight * mapping.savings;
    weights.features += weight * mapping.features;
    weights.complementarity += weight * mapping.complementarity;
  }

  // Normalize so weights sum to 1.0
  const sum = weights.activation + weights.savings + weights.features + weights.complementarity;
  if (sum > 0) {
    weights.activation /= sum;
    weights.savings /= sum;
    weights.features /= sum;
    weights.complementarity /= sum;
  } else {
    return { ...DEFAULT_WEIGHTS };
  }

  return weights;
}

/**
 * Compute composite score (0-100) from outcome dimensions + user preferences.
 */
export function computeCompositeScore(
  outcomes: MultiOutcomeCard["outcomes"],
  preferences: PreferenceProfile
): number {
  const w = mapPreferencesToWeights(preferences);

  // Positive signal: weighted sum of good dimensions
  const positiveSignal =
    w.activation * outcomes.p_activation_success +
    w.savings * normalizeSavings(outcomes.e_monthly_savings) +
    w.features * outcomes.feature_coverage +
    w.complementarity * outcomes.complementarity;

  // Penalties
  const frictionPenalty = computeFrictionPenalty(
    outcomes.friction_score,
    preferences.friction_budget
  );
  const riskPenalty = RISK_WEIGHT * outcomes.risk_score;

  // Final score on 0-100 scale
  const raw = positiveSignal - frictionPenalty - riskPenalty;
  return Math.round(Math.max(0, Math.min(100, raw * 100)));
}

/**
 * Re-score and sort cards using deterministic scoring.
 * Mutates the cards array in-place (overwrites composite_score, re-sorts).
 */
export function rescoreAndSort(
  cards: MultiOutcomeCard[],
  preferences: PreferenceProfile
): MultiOutcomeCard[] {
  for (const card of cards) {
    card.composite_score = computeCompositeScore(card.outcomes, preferences);
  }
  cards.sort((a, b) => b.composite_score - a.composite_score);
  return cards;
}
