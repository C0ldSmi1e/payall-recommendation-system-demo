import type { User, UserState, FeasibleSet, Card } from "../types";
import { inferLocation, getUserCountries, type InferredLocation } from "./location";

/**
 * Deterministic constraint engine — replaces LLM-based Step 2.
 * Pure code, zero LLM calls, instant, 100% reproducible.
 *
 * Rules (mechanical, no subjective judgment):
 * 1. ELIMINATE if card is deleted (is_deleted = 1)
 * 2. ELIMINATE if user already owns the card
 * 3. ELIMINATE if ANY of the user's inferred countries is in disallowed_countries
 *    (uses transaction-based location inference, not just profile country)
 * 4. Everything else PASSES (KYC, payment methods → flagged, not eliminated)
 */

function parseJsonArray(val: string): string[] {
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface ConstraintResult {
  feasibleSet: FeasibleSet;
  inferredLocation: InferredLocation;
}

export function runConstraintEngine(
  userState: UserState,
  cards: Card[],
  user: User
): ConstraintResult {
  const feasible: FeasibleSet["feasible"] = [];
  const eliminated: FeasibleSet["eliminated"] = [];

  // Infer real location from transaction patterns
  const inferredLoc = inferLocation(user);

  // All countries to check against disallowed_countries
  const userCountries = getUserCountries(user);
  const ownedSet = new Set(user.owned_card_ids);

  for (const card of cards) {
    // Rule 1: Deleted cards
    if (card.is_deleted === 1) {
      eliminated.push({
        card_id: card.id,
        card_name: card.card_name,
        reason: "Card is deleted/discontinued",
        blocked_reason_category: "deleted",
      });
      continue;
    }

    // Rule 2: Already owned
    if (ownedSet.has(card.id)) {
      eliminated.push({
        card_id: card.id,
        card_name: card.card_name,
        reason: "User already owns this card",
        blocked_reason_category: "owned",
      });
      continue;
    }

    // Rule 3: Country block — check ALL inferred countries
    const disallowed = parseJsonArray(card.disallowed_countries).map((c: string) =>
      c.toUpperCase()
    );
    const blockedCountry = userCountries.find((c) => disallowed.includes(c));

    if (blockedCountry) {
      eliminated.push({
        card_id: card.id,
        card_name: card.card_name,
        reason: `Blocked in ${blockedCountry} (inferred: ${inferredLoc.primary_country}, registered: ${user.country})`,
        blocked_reason_category: "country",
      });
      continue;
    }

    // Card passes all hard constraints — build notes
    const kycGate =
      card.kyc_required === 1 &&
      userState.hard_requirements.kyc_status === "unverified";

    const notes: string[] = [];
    if (kycGate) notes.push("Requires KYC (user not yet verified)");
    if (card.has_physical_card === 0 && userState.hard_requirements.needs_physical) {
      notes.push("No physical card available");
    }
    if (card.has_virtual_card === 0 && userState.hard_requirements.needs_virtual) {
      notes.push("No virtual card available");
    }

    const payMethods = userState.hard_requirements.payment_methods;
    if (payMethods.includes("apple_pay") && card.apple_wallet_support === 0) {
      notes.push("No Apple Pay");
    }
    if (payMethods.includes("google_pay") && card.google_pay_support === 0) {
      notes.push("No Google Pay");
    }
    if (payMethods.includes("wechat_pay") && card.wechat_pay_support === 0) {
      notes.push("No WeChat Pay");
    }
    if (payMethods.includes("alipay") && card.alipay_support === 0) {
      notes.push("No Alipay");
    }

    feasible.push({
      card_id: card.id,
      card_name: card.card_name,
      kyc_gate: kycGate,
      note: notes.join("; ") || "No issues",
    });
  }

  return {
    feasibleSet: { feasible, eliminated },
    inferredLocation: inferredLoc,
  };
}
