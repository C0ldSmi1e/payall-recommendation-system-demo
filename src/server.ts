import { users } from "./users";
import { runPipeline, reRankPipeline } from "./pipeline";
import {
  recordCardFeedback,
  recordOpeningResult,
  applyQuickFixOverrides,
  getUserFeedback,
} from "./feedback";
import type { Card } from "./types";

const cards: Card[] = await Bun.file("./cards.json").json();
const html = await Bun.file("./src/index.html").text();

function createSSEStream(handler: (send: (event: string, data: unknown) => void) => Promise<void>) {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };
      try {
        await handler(send);
      } catch (err: any) {
        console.error("SSE error:", err);
        send("step_error", { error: err.message || "Failed" });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

const server = Bun.serve({
  port: 3456,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response(html, {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (url.pathname === "/api/users") {
      return Response.json(users);
    }

    // Full pipeline SSE
    if (url.pathname === "/api/recommend/stream") {
      const userId = url.searchParams.get("userId");
      const user = users.find((u) => u.id === userId);
      if (!user) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }
      return createSSEStream((send) => runPipeline(user, cards, send));
    }

    // Re-rank SSE (steps 5+6 only, with feedback context)
    if (url.pathname === "/api/recommend/rerank") {
      const userId = url.searchParams.get("userId");
      if (!userId) {
        return Response.json({ error: "Missing userId" }, { status: 400 });
      }
      return createSSEStream((send) => reRankPipeline(userId, send));
    }

    // Like/dislike a card (JSON response — re-rank is triggered via SSE separately)
    if (url.pathname === "/api/feedback/card" && req.method === "POST") {
      const body = (await req.json()) as {
        user_id: string;
        card_id: number;
        action: "like" | "dislike";
      };
      await recordCardFeedback(body.user_id, body.card_id, body.action);
      return Response.json({ ok: true, action: body.action });
    }

    // Card opening simulation
    if (url.pathname === "/api/feedback/open-card" && req.method === "POST") {
      const body = (await req.json()) as {
        user_id: string;
        card_id: number;
        card_name: string;
        kyc_success: boolean;
        topup_success: boolean;
        approval: boolean;
      };

      const result = await recordOpeningResult(
        body.user_id,
        body.card_id,
        body.card_name,
        body.kyc_success,
        body.topup_success,
        body.approval
      );

      const allPass = body.kyc_success && body.topup_success && body.approval;
      const needsReRank = !body.approval; // Only re-rank on approval failure

      return Response.json({
        ok: true,
        result,
        all_pass: allPass,
        needs_rerank: needsReRank,
      });
    }

    // Feedback history
    if (url.pathname === "/api/feedback/history") {
      const userId = url.searchParams.get("userId");
      if (!userId)
        return Response.json({ error: "Missing userId" }, { status: 400 });
      return Response.json(getUserFeedback(userId));
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Server running at http://localhost:${server.port}`);
