import { users } from "./users";
import { runPipeline } from "./pipeline";
import {
  recordCardFeedback,
  recordOpeningResult,
  applyFeedbackOverrides,
  getUserFeedback,
} from "./feedback";
import type { Card } from "./types";

const cards: Card[] = await Bun.file("./cards.json").json();
const html = await Bun.file("./src/index.html").text();

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

    // SSE streaming endpoint for CoT pipeline
    if (url.pathname === "/api/recommend/stream") {
      const userId = url.searchParams.get("userId");
      const user = users.find((u) => u.id === userId);
      if (!user) {
        return Response.json({ error: "User not found" }, { status: 404 });
      }

      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (event: string, data: unknown) => {
            controller.enqueue(
              encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
            );
          };

          try {
            await runPipeline(user, cards, send);
          } catch (err: any) {
            console.error("Pipeline error:", err);
            send("step_error", { error: err.message || "Pipeline failed" });
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

    // Like/dislike a card
    if (url.pathname === "/api/feedback/card" && req.method === "POST") {
      const body = await req.json() as {
        user_id: string;
        card_id: number;
        action: "like" | "dislike";
        base_recommendation?: any;
      };
      await recordCardFeedback(body.user_id, body.card_id, body.action);

      // If base recommendation provided, recompute overrides
      let updated = null;
      if (body.base_recommendation) {
        updated = applyFeedbackOverrides(body.user_id, body.base_recommendation);
      }
      return Response.json({ ok: true, recommendation: updated });
    }

    // Simulate card opening
    if (url.pathname === "/api/feedback/open-card" && req.method === "POST") {
      const body = await req.json() as {
        user_id: string;
        card_id: number;
        card_name: string;
        kyc_success: boolean;
        topup_success: boolean;
        approval: boolean;
        base_recommendation?: any;
      };

      const result = await recordOpeningResult(
        body.user_id,
        body.card_id,
        body.card_name,
        body.kyc_success,
        body.topup_success,
        body.approval
      );

      let updated = null;
      if (body.base_recommendation) {
        updated = applyFeedbackOverrides(body.user_id, body.base_recommendation);
      }
      return Response.json({ ok: true, result, recommendation: updated });
    }

    // Get feedback history
    if (url.pathname === "/api/feedback/history") {
      const userId = url.searchParams.get("userId");
      if (!userId) return Response.json({ error: "Missing userId" }, { status: 400 });
      return Response.json(getUserFeedback(userId));
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Server running at http://localhost:${server.port}`);
