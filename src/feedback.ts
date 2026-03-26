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

  // Process in order — later actions override earlier ones
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

export function getLikedCardIds(userId: string): Set<number> {
  const liked = new Set<number>();
  for (const fb of store.card_feedbacks) {
    if (fb.user_id !== userId) continue;
    if (fb.action === "like") liked.add(fb.card_id);
    else liked.delete(fb.card_id);
  }
  return liked;
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

export function getLastOpeningResult(
  userId: string,
  cardId: number
): CardOpeningResult | undefined {
  // Return most recent result for this user+card
  for (let i = store.opening_results.length - 1; i >= 0; i--) {
    const r = store.opening_results[i];
    if (r.user_id === userId && r.card_id === cardId) return r;
  }
  return undefined;
}

function getLatestFailedOpening(
  userId: string
): CardOpeningResult | undefined {
  for (let i = store.opening_results.length - 1; i >= 0; i--) {
    const r = store.opening_results[i];
    if (
      r.user_id === userId &&
      (!r.kyc_success || !r.topup_success || !r.approval)
    ) {
      return r;
    }
  }
  return undefined;
}

// ---- Feedback Override Logic ----

export function applyFeedbackOverrides(
  userId: string,
  base: FinalRecommendation
): FinalRecommendation {
  const next: FinalRecommendation = JSON.parse(JSON.stringify(base));
  const disliked = getDislikedCardIds(userId);

  // Remove disliked cards from backups
  next.backups = next.backups.filter((b) => !disliked.has(b.card_id));

  // If primary is disliked, swap to first backup
  if (disliked.has(next.primary.card_id) && next.backups.length > 0) {
    const replacement = next.backups.shift()!;
    next.primary = {
      card_id: replacement.card_id,
      card_name: replacement.card_name,
      score: replacement.score,
      tagline: replacement.tagline,
      reason: replacement.reason,
      pros: [],
      cons: [],
      next_action: {
        type: "apply",
        description: `Apply for ${replacement.card_name}`,
      },
    };
  }

  // Check for failed card openings on the current primary
  const failedOpening = getLatestFailedOpening(userId);
  if (failedOpening && failedOpening.card_id === next.primary.card_id) {
    if (!failedOpening.kyc_success) {
      next.primary.next_action = {
        type: "kyc",
        description: "KYC verification failed — retry or submit additional documents",
      };
      next.primary.reason =
        "Your KYC verification didn't pass for this card. You can retry with corrected documents, or try an alternative card below.";
    } else if (!failedOpening.topup_success) {
      next.primary.next_action = {
        type: "topup",
        description: "Top-up failed — try a different funding route",
      };
      next.primary.reason =
        "Card was approved but top-up failed. Try a different funding method or route.";
    } else if (!failedOpening.approval) {
      // Card application rejected — swap to backup
      if (next.backups.length > 0) {
        const replacement = next.backups.shift()!;
        next.primary = {
          card_id: replacement.card_id,
          card_name: replacement.card_name,
          score: replacement.score,
          tagline: replacement.tagline,
          reason: `${failedOpening.card_name} application was not approved. Switching to the best alternative.`,
          pros: [],
          cons: [],
          next_action: {
            type: "apply",
            description: `Apply for ${replacement.card_name} instead`,
          },
        };
      } else {
        next.primary.next_action = {
          type: "explore",
          description: "Application not approved — explore other options",
        };
        next.primary.reason =
          "This card application was not approved. Consider running a new recommendation search.";
      }
    }
  }

  return next;
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
