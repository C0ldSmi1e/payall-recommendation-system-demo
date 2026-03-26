# Feedback Override Layer — Ship Today

Alright, if we're doing this today, **don't rebuild the recommendation system**.
Your current Bun + SSE + 6-step pipeline already produces a "best card today." The simplest and most effective approach is:

## Add a **Feedback Override Layer** after the existing recommendation output

In other words:

```text
Base Recommender (existing) -> produces today's best card
Feedback Layer (new)        -> rewrites next_action based on just-happened events, swaps primary if needed
Frontend                    -> only shows "the final feedback-corrected result"
```

This can ship today, and the feedback effect will be immediately noticeable.

---

# I. Minimal Architecture Based on Your Current Project

Your current project structure is roughly:

* `src/server.ts`: Bun API + SSE
* `src/pipeline.ts`: 6-step recommendation pipeline
* `src/types.ts`: types
* `src/index.html`: frontend display

Today, add just 1 core module:

## New file

```text
src/feedback.ts
```

## Only modify 3 files

```text
src/types.ts
src/pipeline.ts
src/server.ts
```

If you want to see changes on the frontend immediately, also make a small change to:

```text
src/index.html
```

---

# II. Core Idea for Today's Version

## Don't re-run the entire pipeline

Your pipeline currently runs:

* User State Analysis
* Constraint Engine
* Preference Analysis
* Card Perception
* Ranking
* Final Recommendation

It's heavy and requires LLM calls.
**The feedback system today should NOT re-run it for every event.**

### The right approach

Just maintain two layers of state:

## 1. Base Recommendation

Produced by the existing pipeline, representing the "current big-picture optimal solution"

## 2. Feedback Override

Based on what just happened, immediately change:

* `primary.next_action`
* `primary.reason`
* Swap `primary` and `backup` if necessary

---

# III. The 4 Data Objects You Must Have Today

Don't bother with complex database design today.
If we just want to get the system working, **an in-memory Map is enough**.
If you want to go straight to production, swap the same interface to Redis later.

## 1. feedback_event

Stores all key feedback events

## 2. user_hot_state

Stores "the current hot state that most affects recommendations"

## 3. action_cooldown

Stores failed action cooldowns

## 4. recommendation_snapshot

Stores the final recommendation snapshot shown to the frontend

---

# IV. Minimal Type Design for Today

## Add these types to `src/types.ts`

```ts
export type FeedbackEventType =
  | "application_started"
  | "application_abandoned"
  | "kyc_blocked"
  | "kyc_approved"
  | "application_rejected"
  | "topup_started"
  | "topup_failed"
  | "topup_succeeded"
  | "low_balance_detected"
  | "cashout_failed"
  | "cashout_succeeded";

export interface FeedbackEvent {
  user_id: string;
  event_type: FeedbackEventType;
  payload?: Record<string, any>;
  created_at: number;
}

export interface UserHotState {
  user_id: string;
  current_intent?: string;
  kyc_stage?: "not_started" | "in_progress" | "blocked" | "approved" | "rejected";
  current_blocker?: string;
  balance_risk?: "normal" | "low";
  last_failed_card_id?: number;
  last_failed_route?: string;
  ignore_count?: number;
  version: number;
  updated_at: number;
}

export interface RecommendationSnapshot {
  user_id: string;
  base_recommendation: FinalRecommendation;
  final_recommendation: FinalRecommendation;
  state_version: number;
  updated_at: number;
}
```

---

# V. Today's New `src/feedback.ts`

This file is the core of the entire system.

## 5.1 Start with in-memory storage

Fastest for today:

```ts
const hotStateStore = new Map<string, UserHotState>();
const snapshotStore = new Map<string, RecommendationSnapshot>();
const cooldownStore = new Map<string, Record<string, number>>();
const eventLog: FeedbackEvent[] = [];
```

If you want to swap to Redis tonight, just replace these Maps with Redis reads/writes — no business logic changes needed.

---

## 5.2 Core Function 1: Ingest Event

```ts
export function ingestFeedbackEvent(evt: FeedbackEvent) {
  eventLog.push(evt);
  const prev = hotStateStore.get(evt.user_id) || {
    user_id: evt.user_id,
    version: 0,
    updated_at: Date.now(),
  };

  const next = reduceHotState(prev, evt);
  hotStateStore.set(evt.user_id, next);
  return next;
}
```

---

## 5.3 Core Function 2: Hot State Reducer

This step only handles "will the recommendation change right now?"

```ts
function reduceHotState(prev: UserHotState, evt: FeedbackEvent): UserHotState {
  const next: UserHotState = {
    ...prev,
    version: (prev.version || 0) + 1,
    updated_at: Date.now(),
  };

  switch (evt.event_type) {
    case "application_started":
      next.kyc_stage = "in_progress";
      break;

    case "application_abandoned":
      next.kyc_stage = "in_progress";
      next.current_blocker = "abandoned";
      break;

    case "kyc_blocked":
      next.kyc_stage = "blocked";
      next.current_blocker = evt.payload?.reason || "missing_document";
      break;

    case "kyc_approved":
      next.kyc_stage = "approved";
      next.current_blocker = undefined;
      break;

    case "application_rejected":
      next.kyc_stage = "rejected";
      next.last_failed_card_id = evt.payload?.card_id;
      break;

    case "topup_failed":
      next.last_failed_card_id = evt.payload?.card_id;
      next.last_failed_route = evt.payload?.route;
      break;

    case "topup_succeeded":
      next.balance_risk = "normal";
      break;

    case "low_balance_detected":
      next.balance_risk = "low";
      break;

    case "cashout_failed":
      next.current_blocker = "cashout_failed";
      break;

    case "cashout_succeeded":
      if (next.current_blocker === "cashout_failed") next.current_blocker = undefined;
      break;
  }

  return next;
}
```

---

## 5.4 Core Function 3: Action Cooldown

```ts
function setCooldown(userId: string, actionKey: string, seconds: number) {
  const current = cooldownStore.get(userId) || {};
  current[actionKey] = Math.floor(Date.now() / 1000) + seconds;
  cooldownStore.set(userId, current);
}

function isCooling(userId: string, actionKey: string) {
  const current = cooldownStore.get(userId) || {};
  const until = current[actionKey];
  return until && until > Math.floor(Date.now() / 1000);
}
```

### Today, implement 3 cooldown rules:

* `topup_failed`: cool down that route for 30 minutes
* `application_rejected`: cool down that card for 24 hours
* `cashout_failed`: cool down that route for 30 minutes

---

## 5.5 Core Function 4: Feedback Rewriter

This is the most valuable function built today.

```ts
export function applyFeedbackOverrides(
  userId: string,
  base: FinalRecommendation
): FinalRecommendation {
  const hot = hotStateStore.get(userId);
  if (!hot) return base;

  const next: FinalRecommendation = JSON.parse(JSON.stringify(base));

  if (hot.kyc_stage === "blocked") {
    next.primary.next_action = {
      type: "resume_kyc",
      description: "Submit missing documents to continue your application",
    };
    next.primary.reason = "Your application is stuck at the document verification stage. Submitting the missing documents is the shortest path forward.";
    return next;
  }

  if (hot.kyc_stage === "approved") {
    next.primary.next_action = {
      type: "topup_card",
      description: "Fund $100 and make your first spend",
    };
    next.primary.reason = "Card approved! The best move right now is to complete the first-spend loop.";
    return next;
  }

  if (hot.balance_risk === "low") {
    next.primary.next_action = {
      type: "topup_card",
      description: "Your primary card balance is low — top up first",
    };
    next.primary.reason = "Your primary card balance is running low. Topping up is a better move than switching cards.";
    return next;
  }

  if (hot.last_failed_route) {
    const actionKey = `topup:${next.primary.card_id}:${hot.last_failed_route}`;
    if (isCooling(userId, actionKey)) {
      next.primary.next_action = {
        type: "switch_topup_route",
        description: "Previous funding route failed — switching to backup route",
      };
      next.primary.reason = "The previous funding route just failed. The system has switched to a more reliable route.";
      return next;
    }
  }

  if (hot.kyc_stage === "rejected" && next.backups.length > 0) {
    const backup = next.backups[0];
    next.primary = {
      card_id: backup.card_id,
      card_name: backup.card_name,
      score: backup.score,
      tagline: backup.tagline,
      reason: "Your top pick was just rejected. Switching to the closest alternative that fits your needs.",
      pros: [],
      cons: [],
      next_action: {
        type: "start_backup_application",
        description: `Apply for ${backup.card_name} instead`,
      },
    };
    return next;
  }

  return next;
}
```

---

# VI. How to Plug It Into Your Existing Pipeline

Your `pipeline.ts` currently ends with:

```ts
send("pipeline_done", { recommendation: finalRec, cards: recCards });
```

Today, just change it to:

```ts
import { saveRecommendationSnapshot, applyFeedbackOverrides } from "./feedback";

const finalWithFeedback = applyFeedbackOverrides(user.id, finalRec);

saveRecommendationSnapshot(user.id, finalRec, finalWithFeedback);

send("pipeline_done", {
  recommendation: finalWithFeedback,
  cards: recCards,
});
```

The benefits:

* Existing recommendation logic is completely untouched
* Just one layer of feedback correction added at the end
* Frontend continues consuming the same `FinalRecommendation` structure

This is the easiest integration for today.

---

# VII. Two New Endpoints for `server.ts` Today

## 7.1 Accept feedback events

```ts
if (url.pathname === "/api/feedback/event" && req.method === "POST") {
  const body = await req.json();
  const hotState = ingestFeedbackEvent({
    user_id: body.user_id,
    event_type: body.event_type,
    payload: body.payload || {},
    created_at: Date.now(),
  });

  if (body.event_type === "topup_failed" && body.payload?.route && body.payload?.card_id) {
    setCooldown(body.user_id, `topup:${body.payload.card_id}:${body.payload.route}`, 1800);
  }

  if (body.event_type === "application_rejected" && body.payload?.card_id) {
    setCooldown(body.user_id, `apply:${body.payload.card_id}`, 86400);
  }

  const snapshot = rewriteSnapshot(body.user_id);
  return Response.json({
    ok: true,
    state_version: hotState.version,
    recommendation: snapshot?.final_recommendation || null,
  });
}
```

## 7.2 Read current recommendation snapshot

```ts
if (url.pathname === "/api/recommendation/current") {
  const userId = url.searchParams.get("userId");
  if (!userId) return Response.json({ error: "Missing userId" }, { status: 400 });

  const snapshot = getRecommendationSnapshot(userId);
  return Response.json(snapshot || null);
}
```

---

# VIII. Two More Helper Functions for `feedback.ts`

```ts
export function saveRecommendationSnapshot(
  userId: string,
  base: FinalRecommendation,
  final: FinalRecommendation
) {
  const hot = hotStateStore.get(userId);
  snapshotStore.set(userId, {
    user_id: userId,
    base_recommendation: base,
    final_recommendation: final,
    state_version: hot?.version || 0,
    updated_at: Date.now(),
  });
}

export function getRecommendationSnapshot(userId: string) {
  return snapshotStore.get(userId);
}

export function rewriteSnapshot(userId: string) {
  const snapshot = snapshotStore.get(userId);
  if (!snapshot) return null;

  const final = applyFeedbackOverrides(userId, snapshot.base_recommendation);
  const next = {
    ...snapshot,
    final_recommendation: final,
    state_version: (hotStateStore.get(userId)?.version || snapshot.state_version),
    updated_at: Date.now(),
  };

  snapshotStore.set(userId, next);
  return next;
}
```

---

# IX. Frontend: Only Change One Thing Today

The current frontend already runs the SSE pipeline.
No major UI changes today — just:

## After key actions happen, call:

```text
POST /api/feedback/event
```

Then take the returned new recommendation and directly replace the current results area.

### The 4 most critical frontend trigger points:

* User starts an application
* User abandons an application
* Top-up fails
* Top-up succeeds

If you can't hook into real callbacks yet, use simulated buttons on the frontend to trigger them for now.

---

# X. The 5 Feedback Scenarios to Prioritize Today

Don't try to do too much today. Get these 5 scenarios right and users will immediately feel "the system is changing its advice based on what's happening to me."

## 1. KYC Document Request

Event:

```json
{ "event_type": "kyc_blocked", "payload": { "reason": "address_proof_missing" } }
```

Effect:

* Primary card stays the same
* `next_action = Submit missing documents to continue your application`

---

## 2. KYC Approved

Event:

```json
{ "event_type": "kyc_approved" }
```

Effect:

* `next_action = Fund $100 and make your first spend`

---

## 3. Top-up Failed

Event:

```json
{ "event_type": "topup_failed", "payload": { "card_id": 3, "route": "usdt_main" } }
```

Effect:

* That route cools down for 30 minutes
* `next_action = Previous funding route failed — switching to backup route`

---

## 4. Low Balance

Event:

```json
{ "event_type": "low_balance_detected" }
```

Effect:

* `next_action = Your primary card balance is low — top up first`

---

## 5. Primary Card Rejected

Event:

```json
{ "event_type": "application_rejected", "payload": { "card_id": 5 } }
```

Effect:

* Primary switches to `backup[0]`
* Action changes to `Apply for the backup card instead`

---

# XI. Implementation Order for Today

## Do these 6 steps:

### Step 1

Add the 4 feedback-related types to `types.ts`

### Step 2

Create `src/feedback.ts`
Use Map storage first — don't use Redis yet

### Step 3

At the end of `pipeline.ts`, plug in `applyFeedbackOverrides()`

### Step 4

Add to `server.ts`:

* `POST /api/feedback/event`
* `GET /api/recommendation/current`

### Step 5

After key frontend actions, refresh the recommendation

### Step 6

Manually test all 5 scenarios

---

# XII. Things NOT to Do Today

To make sure this ships tonight, don't touch any of these:

* Don't set up Redis Stream / MQ
* Don't build bandit
* Don't build LP
* Don't retrain models
* Don't let the LLM participate in hot feedback rewriting
* Don't restructure the 6-step pipeline

Today, only build:

# **Base Recommendation + Feedback Override**

---

# XIII. What Users Will Experience After You Ship Today

Users will immediately feel:

* The recommendation doesn't die after it's given
* When they fail, the system instantly changes its advice
* When they succeed, the system instantly moves to the next step
* It's not one card recommended forever — it recovers, reroutes, and picks up where you left off

This is the **best feedback effect PayAll can ship today**.

---

If you'd like, the next step can be:

**A complete copy-paste-ready version of `src/feedback.ts`**
Written for your Bun project structure.
