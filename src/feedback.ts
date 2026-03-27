import type {
  CardFeedback,
  CardOpeningResult,
  FeedbackStore,
  FinalRecommendation,
} from "./types";

const DATA_PATH = "./data/feedback.json";

// ---- File-based persistence ----

let store: FeedbackStore = { card_feedbacks: [], opening_results: [] };

async function loadStore() {
  try {
    const file = Bun.file(DATA_PATH);
    if (await file.exists()) {
      store = await file.json();
    }
  } catch {
    store = { card_feedbacks: [], opening_results: [] };
  }
}

async function saveStore() {
  await Bun.write(DATA_PATH, JSON.stringify(store, null, 2));
}

// Load on module init
await loadStore();

// ---- Card Feedback (like/dislike) ----

export async function recordCardFeedback(
  userId: string,
  cardId: number,
  action: "like" | "dislike"
) {
  store.card_feedbacks.push({
    user_id: userId,
    card_id: cardId,
    action,
    timestamp: Date.now(),
  });
  await saveStore();
}

export function getDislikedCardIds(userId: string): Set<number> {
  const liked = new Set<number>();
  const disliked = new Set<number>();

  for (const fb of store.card_feedbacks) {
    if (fb.user_id !== userId) continue;
    if (fb.action === "dislike") {
      disliked.add(fb.card_id);
      liked.delete(fb.card_id);
    } else {
      liked.add(fb.card_id);
      disliked.delete(fb.card_id);
    }
  }
  return disliked;
}

// ---- Card Opening Results ----

export async function recordOpeningResult(
  userId: string,
  cardId: number,
  cardName: string,
  kycSuccess: boolean,
  topupSuccess: boolean,
  approval: boolean
) {
  const result: CardOpeningResult = {
    user_id: userId,
    card_id: cardId,
    card_name: cardName,
    kyc_success: kycSuccess,
    topup_success: topupSuccess,
    approval,
    timestamp: Date.now(),
  };
  store.opening_results.push(result);
  await saveStore();
  return result;
}

function getRejectedCardIds(userId: string): Set<number> {
  const rejected = new Set<number>();
  for (const r of store.opening_results) {
    if (r.user_id === userId && !r.approval) {
      rejected.add(r.card_id);
    }
  }
  return rejected;
}

// ---- Quick-fix overrides (KYC/topup failures only) ----
// Dislike and approval rejection are handled by re-ranking (LLM), not here.

export function applyQuickFixOverrides(
  userId: string,
  base: FinalRecommendation
): FinalRecommendation {
  const next: FinalRecommendation = JSON.parse(JSON.stringify(base));

  // Find latest failed opening for the primary card
  for (let i = store.opening_results.length - 1; i >= 0; i--) {
    const r = store.opening_results[i];
    if (r.user_id !== userId || r.card_id !== next.primary.card_id) continue;

    if (!r.kyc_success) {
      next.primary.next_action = {
        type: "kyc",
        description:
          "KYC verification failed — retry or submit additional documents",
      };
      next.primary.reason =
        "Your KYC verification didn't pass for this card. You can retry with corrected documents, or try an alternative card below.";
    } else if (!r.topup_success) {
      next.primary.next_action = {
        type: "topup",
        description: "Top-up failed — try a different funding route",
      };
      next.primary.reason =
        "Card was approved but top-up failed. Try a different funding method or route.";
    }
    break;
  }

  return next;
}

// ---- Get all card IDs to exclude from re-ranking ----

export function getExcludedCardIds(userId: string): number[] {
  const disliked = getDislikedCardIds(userId);
  const rejected = getRejectedCardIds(userId);
  return [...new Set([...disliked, ...rejected])];
}

// ---- Build feedback context string for LLM re-ranking ----

export function buildFeedbackContext(userId: string): string {
  const parts: string[] = [];

  // Collect disliked cards
  const dislikedFeedbacks: { card_id: number; timestamp: number }[] = [];
  for (const fb of store.card_feedbacks) {
    if (fb.user_id === userId && fb.action === "dislike") {
      dislikedFeedbacks.push({ card_id: fb.card_id, timestamp: fb.timestamp });
    }
  }
  if (dislikedFeedbacks.length > 0) {
    const ids = dislikedFeedbacks.map((f) => f.card_id).join(", ");
    parts.push(
      `**Disliked cards** (card IDs: ${ids}): The user explicitly disliked these cards. Do NOT recommend them or cards that are very similar (same vendor, same fee structure, same limitations). Think about WHY the user might have disliked them and avoid cards with similar characteristics.`
    );
  }

  // Collect failed openings (approval rejected)
  const rejections: { card_id: number; card_name: string }[] = [];
  for (const r of store.opening_results) {
    if (r.user_id === userId && !r.approval) {
      rejections.push({ card_id: r.card_id, card_name: r.card_name });
    }
  }
  if (rejections.length > 0) {
    const names = rejections.map((r) => `${r.card_name} (#${r.card_id})`).join(", ");
    parts.push(
      `**Rejected applications** (${names}): These cards rejected the user's application. Do NOT recommend them. Also avoid cards with similar issuer requirements, KYC strictness, or country restrictions — the user is likely to be rejected again.`
    );
  }

  // Collect KYC/topup failures (informational, not exclusions)
  const kycFailures: string[] = [];
  const topupFailures: string[] = [];
  for (const r of store.opening_results) {
    if (r.user_id !== userId) continue;
    if (!r.kyc_success) kycFailures.push(r.card_name);
    if (r.kyc_success && !r.topup_success) topupFailures.push(r.card_name);
  }
  if (kycFailures.length > 0) {
    parts.push(
      `**KYC difficulties** with: ${kycFailures.join(", ")}. The user had trouble with KYC verification. Prefer cards with simpler KYC or no-KYC options.`
    );
  }
  if (topupFailures.length > 0) {
    parts.push(
      `**Top-up failures** with: ${topupFailures.join(", ")}. Consider cards with more flexible funding options.`
    );
  }

  if (parts.length === 0) {
    return "No previous feedback.";
  }

  return parts.join("\n\n");
}

// ---- Query ----

export function getUserFeedback(userId: string) {
  return {
    card_feedbacks: store.card_feedbacks.filter((f) => f.user_id === userId),
    opening_results: store.opening_results.filter(
      (r) => r.user_id === userId
    ),
  };
}

// ---- Check if re-rank is needed ----

export function needsReRank(
  userId: string,
  cardId: number,
  eventType: "dislike" | "approval_rejected"
): boolean {
  return true; // Always re-rank on dislike or approval rejection
}
