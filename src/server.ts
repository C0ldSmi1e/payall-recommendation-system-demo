import { users } from "./users";
import { runPipeline } from "./pipeline";
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

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Server running at http://localhost:${server.port}`);
