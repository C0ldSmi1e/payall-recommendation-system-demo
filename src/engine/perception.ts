import type { User, Card, PreferenceProfile, MultiOutcomeCard, PerceptionResult } from "../types";

/**
 * Fully deterministic card perception engine.
 * Replaces LLM Step 4 — computes all 6 outcome dimensions from card data + user profile.
 * Zero LLM calls, instant, 100% reproducible.
 */

export function computeCardPerception(
  cards: Card[],
  user: User,
  preferences: PreferenceProfile
): PerceptionResult {
  const ownedCards = user.owned_card_ids
    .map((id) => cards.find((c) => c.id === id))
    .filter(Boolean) as Card[];

  const results: MultiOutcomeCard[] = cards.map((card) => {
    const outcomes = {
      p_activation_success: computeActivation(card, user, preferences),
      e_monthly_savings: computeSavings(card, user, ownedCards),
      feature_coverage: computeFeatureCoverage(card, user),
      friction_score: computeFriction(card, user),
      risk_score: computeRisk(card),
      complementarity: computeComplementarity(card, user, ownedCards),
    };

    return {
      card_id: card.id,
      card_name: card.card_name,
      outcomes,
      composite_score: 0, // Will be set by scoring engine
      key_insight: generateInsight(card, user, outcomes),
    };
  });

  return { cards: results };
}

// ---- Activation probability (0-1) ----
// Will they actually use this card within 30 days?
function computeActivation(card: Card, user: User, prefs: PreferenceProfile): number {
  let score = 0.5; // Base

  // KYC friction
  if (card.kyc_required === 0) {
    score += 0.25; // No KYC = easy to start
  } else if (user.kyc_verified) {
    score += 0.15; // Already verified somewhere
  } else {
    // Adjust based on friction budget
    if (prefs.friction_budget === "low") score -= 0.3;
    else if (prefs.friction_budget === "medium") score -= 0.1;
    // high budget = neutral
  }

  // Virtual card = instant use
  if (card.has_virtual_card === 1) score += 0.1;

  // Payment method match — if they need Apple Pay and card has it, more likely to use
  if (user.needs_apple_pay && card.apple_wallet_support === 1) score += 0.1;
  if (user.needs_google_pay && card.google_pay_support === 1) score += 0.1;

  // Bit2Go bonus (our revenue card, we actively promote it)
  if (card.id === 23) score += 0.05;

  return clamp(score);
}

// ---- Monthly savings (USD) ----
// Estimated savings vs current card(s)
function computeSavings(card: Card, user: User, ownedCards: Card[]): number {
  const monthlySpend = user.monthly_spend_usd;

  // Cashback earnings
  let cbRate = 0;
  try { cbRate = parseFloat(card.cashback_max) || 0; } catch {}
  const monthlyCashback = monthlySpend * (cbRate / 100);

  // Fee comparison vs current cards
  let currentBestCb = 0;
  for (const owned of ownedCards) {
    try {
      const ownedCb = parseFloat(owned.cashback_max) || 0;
      currentBestCb = Math.max(currentBestCb, ownedCb);
    } catch {}
  }
  const cbImprovement = monthlySpend * (Math.max(0, cbRate - currentBestCb) / 100);

  // FX fee savings (if applicable)
  let cardFxFee = 0;
  try {
    const fees = JSON.parse(card.fees);
    cardFxFee = parseFloat(fees.fxFee || fees.fx_fee || fees.foreignTransactionFee || "0") || 0;
  } catch {}

  // Assume 30% of spend is cross-border for travelers, 10% otherwise
  const isTraveler = user.primary_use.includes("travel");
  const crossBorderPct = isTraveler ? 0.3 : 0.1;
  const fxSavings = monthlySpend * crossBorderPct * (Math.max(0, 2.5 - cardFxFee) / 100); // vs 2.5% average

  return Math.round((cbImprovement + fxSavings) * 100) / 100;
}

// ---- Feature coverage (0-1) ----
// What fraction of user's needs does this card satisfy?
function computeFeatureCoverage(card: Card, user: User): number {
  let needs = 0;
  let met = 0;

  // Payment methods
  if (user.needs_apple_pay) { needs++; if (card.apple_wallet_support === 1) met++; }
  if (user.needs_google_pay) { needs++; if (card.google_pay_support === 1) met++; }
  if (user.needs_wechat_pay) { needs++; if (card.wechat_pay_support === 1) met++; }
  if (user.needs_alipay) { needs++; if (card.alipay_support === 1) met++; }

  // Card type
  if (user.wants_physical_card) { needs++; if (card.has_physical_card === 1) met++; }
  if (user.wants_virtual_card) { needs++; if (card.has_virtual_card === 1) met++; }

  // ATM
  if (user.primary_use.includes("atm_withdrawal")) { needs++; if (card.atm_withdrawal_support === 1) met++; }

  // Crypto support
  if (user.preferred_topup_crypto) {
    needs++;
    try {
      const cryptos = JSON.parse(card.based_crypto || "[]");
      if (Array.isArray(cryptos) && cryptos.some((c: string) =>
        c.toUpperCase().includes(user.preferred_topup_crypto.toUpperCase())
      )) met++;
    } catch {}
  }

  // Spending limits
  if (user.monthly_spend_usd > 5000) {
    needs++;
    try {
      const limits = JSON.parse(card.spending_limits || "{}");
      const monthly = parseFloat(limits.monthly || limits.monthlyLimit || "0") || 0;
      if (monthly === 0 || monthly >= user.monthly_spend_usd) met++;
    } catch { met++; } // If can't parse, assume no limit
  }

  // Priorities
  for (const prio of user.priorities.slice(0, 3)) {
    needs++;
    if (prio === "cashback" || prio === "low_fees") {
      try { if ((parseFloat(card.cashback_max) || 0) > 0) met++; } catch {}
    } else if (prio === "privacy" || prio === "no_kyc") {
      if (card.kyc_required === 0) met++;
    } else if (prio === "high_spending_limit") {
      try {
        const limits = JSON.parse(card.spending_limits || "{}");
        const monthly = parseFloat(limits.monthly || limits.monthlyLimit || "0") || 0;
        if (monthly === 0 || monthly >= 10000) met++;
      } catch { met++; }
    } else {
      met += 0.5; // Partial credit for other priorities
    }
  }

  return needs > 0 ? clamp(met / needs) : 0.5;
}

// ---- Friction score (0-1) ----
// How much effort to get started. 0=zero friction, 1=maximum
function computeFriction(card: Card, user: User): number {
  let friction = 0;

  if (card.kyc_required === 1) {
    if (user.kyc_verified) {
      friction += 0.2; // Already did KYC elsewhere, still some effort
    } else {
      friction += 0.6; // Need to do KYC from scratch
    }
  }

  // No virtual card = need to wait for physical
  if (card.has_virtual_card === 0) friction += 0.15;

  // can_apply check
  if (card.can_apply === 0) friction += 0.1;

  return clamp(friction);
}

// ---- Risk score (0-1) ----
// Combined risk. 0=safe, 1=risky
function computeRisk(card: Card): number {
  // Invert general_ratings (higher rating = lower risk)
  // Ratings are typically 50-85
  const rating = card.general_ratings || 50;
  if (rating >= 80) return 0.1;
  if (rating >= 70) return 0.2;
  if (rating >= 60) return 0.3;
  if (rating >= 50) return 0.4;
  return 0.6;
}

// ---- Complementarity (0-1) ----
// Fills a gap vs duplicates existing cards
function computeComplementarity(card: Card, user: User, ownedCards: Card[]): number {
  if (ownedCards.length === 0) return 0.8; // New user, any card is complementary

  let gapsFilled = 0;
  let totalGaps = 0;

  for (const owned of ownedCards) {
    // Check if this card provides something owned cards don't
    if (user.needs_apple_pay && owned.apple_wallet_support === 0 && card.apple_wallet_support === 1) {
      gapsFilled++; totalGaps++;
    }
    if (user.needs_google_pay && owned.google_pay_support === 0 && card.google_pay_support === 1) {
      gapsFilled++; totalGaps++;
    }
    if (owned.atm_withdrawal_support === 0 && card.atm_withdrawal_support === 1 && user.primary_use.includes("atm_withdrawal")) {
      gapsFilled++; totalGaps++;
    }

    // Cashback improvement
    try {
      const ownedCb = parseFloat(owned.cashback_max) || 0;
      const newCb = parseFloat(card.cashback_max) || 0;
      if (newCb > ownedCb) { gapsFilled++; }
      totalGaps++;
    } catch {}
  }

  if (totalGaps === 0) return 0.5;
  return clamp(0.3 + 0.7 * (gapsFilled / totalGaps));
}

// ---- Key insight generator ----
function generateInsight(card: Card, user: User, outcomes: MultiOutcomeCard["outcomes"]): string {
  if (outcomes.e_monthly_savings > 50) return `Could save $${outcomes.e_monthly_savings}/mo vs current card`;
  if (outcomes.friction_score < 0.1) return "Zero friction — no KYC, instant virtual card";
  if (outcomes.feature_coverage > 0.9) return "Covers nearly all your needs";
  if (outcomes.complementarity > 0.8) return "Fills gaps your current cards don't cover";
  if (card.kyc_required === 0) return "No KYC required";
  return `Rating: ${card.general_ratings}/100`;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}
