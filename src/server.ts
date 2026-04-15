import Anthropic from "@anthropic-ai/sdk";
import { users } from "./users";
import { runPipeline, reRankPipeline } from "./pipeline";
import { precompute, readCache, invalidateCache, runAndCache, getInFlight } from "./cache";
import {
  recordCardFeedback, recordOpeningResult, applyQuickFixOverrides, getUserFeedback,
} from "./feedback";
import type { Card } from "./types";

const cards: Card[] = await Bun.file("./cards.json").json();
const html = await Bun.file("./src/index.html").text();
const walletHtml = await Bun.file("./src/wallet.html").text();
const chatClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---- Card database tools (executed server-side) ----

function executeCardTool(name: string, input: any): string {
  switch (name) {
    case "lookup_card": {
      const card = cards.find((c) => c.id === input.card_id || c.card_name.toLowerCase().includes((input.card_name || "").toLowerCase()));
      if (!card) return JSON.stringify({ error: "Card not found" });
      const fees = (() => { try { return JSON.parse(card.fees); } catch { return card.fees; } })();
      const cashback = (() => { try { return JSON.parse(card.cashback); } catch { return card.cashback; } })();
      return JSON.stringify({
        id: card.id, name: card.card_name, vendor: card.vendor, type: card.card_type,
        kyc_required: card.kyc_required === 1, cashback, cashback_max: card.cashback_max,
        fees, spending_limits: card.spending_limits,
        has_physical: card.has_physical_card === 1, has_virtual: card.has_virtual_card === 1,
        apple_pay: card.apple_wallet_support === 1, google_pay: card.google_pay_support === 1,
        wechat_pay: card.wechat_pay_support === 1, alipay: card.alipay_support === 1,
        atm: card.atm_withdrawal_support === 1, privacy_rating: card.privacy_ratings,
        general_rating: card.general_ratings, summary: card.summary,
      });
    }

    case "compare_cards": {
      const ids: number[] = input.card_ids || [];
      const found = ids.map((id: number) => cards.find((c) => c.id === id)).filter(Boolean) as Card[];
      if (found.length < 2) return JSON.stringify({ error: "Need at least 2 valid card IDs" });
      return JSON.stringify(found.map((c) => {
        const fees = (() => { try { return JSON.parse(c.fees); } catch { return c.fees; } })();
        return {
          id: c.id, name: c.card_name, kyc: c.kyc_required === 1,
          cashback_max: c.cashback_max, fees,
          apple_pay: c.apple_wallet_support === 1, physical: c.has_physical_card === 1,
          atm: c.atm_withdrawal_support === 1, rating: c.general_ratings,
        };
      }));
    }

    case "calculate_savings": {
      const card = cards.find((c) => c.id === input.card_id);
      if (!card) return JSON.stringify({ error: "Card not found" });
      const monthlySpend = input.monthly_spend_usd || 0;
      let cbMax = 0;
      try { cbMax = parseFloat(card.cashback_max) || 0; } catch {}
      const monthlyCashback = monthlySpend * (cbMax / 100);
      let fxFee = 0;
      try { const f = JSON.parse(card.fees); fxFee = parseFloat(f.fxFee || f.fx_fee || "0") || 0; } catch {}
      const monthlyFxCost = monthlySpend * 0.3 * (fxFee / 100); // assume 30% cross-border
      return JSON.stringify({
        card: card.card_name, monthly_spend: monthlySpend,
        cashback_rate: cbMax + "%", monthly_cashback: Math.round(monthlyCashback * 100) / 100,
        fx_fee: fxFee + "%", monthly_fx_cost: Math.round(monthlyFxCost * 100) / 100,
        net_monthly_benefit: Math.round((monthlyCashback - monthlyFxCost) * 100) / 100,
        annual_benefit: Math.round((monthlyCashback - monthlyFxCost) * 12 * 100) / 100,
      });
    }

    case "search_cards": {
      const q = (input.query || "").toLowerCase();
      const results = cards.filter((c) => {
        const text = `${c.card_name} ${c.vendor} ${c.summary} ${c.key_features}`.toLowerCase();
        return text.includes(q);
      }).slice(0, 10).map((c) => ({
        id: c.id, name: c.card_name, vendor: c.vendor,
        kyc: c.kyc_required === 1, cashback_max: c.cashback_max,
        rating: c.general_ratings,
      }));
      return JSON.stringify({ count: results.length, cards: results });
    }

    case "get_user_spending": {
      const user = users.find((u) => u.id === input.user_id);
      if (!user) return JSON.stringify({ error: "User not found" });
      const catSpend: Record<string, { total: number; count: number }> = {};
      let total = 0;
      for (const t of user.transaction_history) {
        if (!catSpend[t.category]) catSpend[t.category] = { total: 0, count: 0 };
        catSpend[t.category].total += t.amount_usd;
        catSpend[t.category].count++;
        total += t.amount_usd;
      }
      const sorted = Object.entries(catSpend).sort((a, b) => b[1].total - a[1].total);
      return JSON.stringify({
        total_spend: Math.round(total), txn_count: user.transaction_history.length,
        monthly_avg: user.monthly_spend_usd,
        categories: sorted.slice(0, 8).map(([cat, d]) => ({
          category: cat, total: Math.round(d.total), count: d.count,
          pct: Math.round((d.total / total) * 100), avg_per_txn: Math.round(d.total / d.count),
        })),
      });
    }

    case "simulate_topup": {
      const amount = input.amount_usd || 500;
      const crypto = input.crypto || "USDT";
      // Simplified simulation
      const feeRate = 0.01; // 1% topup fee
      const fee = Math.round(amount * feeRate * 100) / 100;
      const cryptoNeeded = Math.round((amount + fee) * 100) / 100;
      return JSON.stringify({
        action: "topup", amount_usd: amount, crypto, fee_rate: "1%",
        fee_usd: fee, total_crypto_needed: cryptoNeeded,
        available_after: "Instant", note: "Funds available immediately after confirmation on-chain",
      });
    }

    case "simulate_cashout": {
      const amount = input.amount_usd || 1000;
      const feeRate = 0.015; // 1.5% cashout fee
      const fee = Math.round(amount * feeRate * 100) / 100;
      const youReceive = Math.round((amount - fee) * 100) / 100;
      return JSON.stringify({
        action: "cashout", amount_usd: amount, fee_rate: "1.5%",
        fee_usd: fee, you_receive_usd: youReceive,
        methods: ["Bank transfer (1-3 business days)", "Card spend (instant)"],
      });
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

const CUSTOM_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "lookup_card",
    description: "Look up detailed info about a specific crypto card by ID or name. Returns fees, cashback, features, ratings.",
    input_schema: {
      type: "object" as const,
      properties: {
        card_id: { type: "number", description: "Card ID" },
        card_name: { type: "string", description: "Partial card name to search" },
      },
    },
  },
  {
    name: "compare_cards",
    description: "Compare 2-3 cards side by side. Returns a comparison table with fees, cashback, features.",
    input_schema: {
      type: "object" as const,
      properties: {
        card_ids: { type: "array", items: { type: "number" }, description: "Array of card IDs to compare" },
      },
      required: ["card_ids"],
    },
  },
  {
    name: "calculate_savings",
    description: "Calculate estimated monthly/annual savings for a user on a specific card based on their spending.",
    input_schema: {
      type: "object" as const,
      properties: {
        card_id: { type: "number", description: "Card ID" },
        monthly_spend_usd: { type: "number", description: "Monthly spend in USD" },
      },
      required: ["card_id", "monthly_spend_usd"],
    },
  },
  {
    name: "search_cards",
    description: "Search cards database by keyword (name, vendor, features). Returns up to 10 results.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search keyword" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_user_spending",
    description: "Get detailed spending analysis for the current user — category breakdown, averages, totals.",
    input_schema: {
      type: "object" as const,
      properties: {
        user_id: { type: "string", description: "User ID" },
      },
      required: ["user_id"],
    },
  },
  {
    name: "simulate_topup",
    description: "Simulate topping up a Bit2Go card. Shows fees, crypto needed, and processing time.",
    input_schema: {
      type: "object" as const,
      properties: {
        amount_usd: { type: "number", description: "Amount in USD to top up" },
        crypto: { type: "string", description: "Cryptocurrency to use (default USDT)" },
      },
    },
  },
  {
    name: "simulate_cashout",
    description: "Simulate cashing out from Bit2Go. Shows fees, amount received, and available methods.",
    input_schema: {
      type: "object" as const,
      properties: {
        amount_usd: { type: "number", description: "Amount in USD to cash out" },
      },
    },
  },
];

// ---- SSE helper ----

function createSSEStream(handler: (send: (event: string, data: unknown) => void) => Promise<void>) {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
        catch { closed = true; }
      };
      try { await handler(send); }
      catch (err: any) { console.error("SSE error:", err); send("step_error", { error: err.message || "Failed" }); }
      finally { if (!closed) { closed = true; controller.close(); } }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}

// ---- Server ----

const server = Bun.serve({
  port: 3456,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    // Security headers
    const secHeaders = {
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    };

    if (url.pathname === "/") return new Response(walletHtml, { headers: { "Content-Type": "text/html", ...secHeaders } });
    if (url.pathname === "/desktop") return new Response(html, { headers: { "Content-Type": "text/html", ...secHeaders } });
    if (url.pathname === "/api/users") return Response.json(users);

    // Fire-and-forget precompute: warms the cache in the background so a
    // subsequent /api/recommend/stream request returns in <100ms.
    if (url.pathname === "/api/recommend/precompute") {
      const userId = url.searchParams.get("userId");
      const user = users.find((u) => u.id === userId);
      if (!user) return Response.json({ error: "User not found" }, { status: 404 });
      const cached = await readCache(user.id);
      if (cached) return Response.json({ ok: true, cached: true });
      precompute(user, cards); // don't await
      return Response.json({ ok: true, cached: false }, { status: 202 });
    }

    if (url.pathname === "/api/recommend/stream") {
      const userId = url.searchParams.get("userId");
      const user = users.find((u) => u.id === userId);
      if (!user) return Response.json({ error: "User not found" }, { status: 404 });
      const cached = await readCache(user.id);
      if (cached) {
        return createSSEStream(async (send) => {
          for (const { event, data } of cached.events) send(event, data);
        });
      }
      // If a background precompute is already running, wait for it and replay
      // from cache instead of starting a duplicate pipeline.
      const pending = getInFlight(user.id);
      if (pending) {
        return createSSEStream(async (send) => {
          await pending;
          const fresh = await readCache(user.id);
          if (fresh) { for (const { event, data } of fresh.events) send(event, data); return; }
          await runAndCache(user, cards, send);
        });
      }
      return createSSEStream((send) => runAndCache(user, cards, send));
    }

    if (url.pathname === "/api/recommend/rerank") {
      const userId = url.searchParams.get("userId");
      if (!userId) return Response.json({ error: "Missing userId" }, { status: 400 });
      return createSSEStream((send) => reRankPipeline(userId, send));
    }

    // ---- AI Chat: multi-tool agentic loop ----
    if (url.pathname === "/api/chat" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

      // Input validation
      if (!Array.isArray(body.messages)) return Response.json({ error: "messages must be array" }, { status: 400 });
      if (body.messages.length > 50) return Response.json({ error: "Too many messages" }, { status: 400 });
      const validLangs = ["en", "zh"];
      if (!validLangs.includes(body.lang)) body.lang = "en";
      // Truncate context to prevent abuse (max 8k chars)
      const context = typeof body.context === "string" ? body.context.slice(0, 8000) : "";
      const userId = typeof body.userId === "string" ? body.userId.slice(0, 10) : "6";
      // Sanitize messages — only allow user/assistant roles, truncate content
      const sanitizedMessages = body.messages
        .filter((m: any) => m && typeof m.content === "string" && ["user", "assistant"].includes(m.role))
        .map((m: any) => ({ role: m.role, content: m.content.slice(0, 4000) }));

      const langInstruction = body.lang === "zh"
        ? "You MUST reply in Chinese (简体中文). All your responses must be in Chinese."
        : "You MUST reply in English. All your responses must be in English.";

      const systemPrompt = `You are PayAll's elite AI financial advisor — the smartest crypto card assistant in the world.

${langInstruction}

## Your context (user's recommendation data):
${context}
Current user ID: ${userId}

## Your capabilities (USE THEM!):
You have powerful tools — use them proactively:
- **lookup_card**: When the user asks about ANY card, look it up to get exact fees, cashback, features
- **compare_cards**: When the user is deciding between cards, show a real comparison
- **calculate_savings**: When discussing value, calculate EXACT savings based on their spending
- **search_cards**: When the user wants to explore options, search the database
- **get_user_spending**: When you need spending details, fetch the full analysis
- **simulate_topup**: When the user asks about funding their card, simulate the topup
- **simulate_cashout**: When the user asks about converting crypto to fiat, simulate the cashout
- **web_search**: When you need real-time info (exchange rates, news, competitor details)

## Personality:
- You are confident, knowledgeable, and action-oriented
- ALWAYS use tools to back up your claims — never guess about fees or rates
- Format responses clearly: use **bold** for key numbers, bullet points for lists
- When showing comparisons or calculations, format as a clear table
- After answering, suggest a next action: "Want me to simulate a $500 topup?" or "Shall I compare this with another card?"
- Reference the user's actual spending patterns ("Based on your $8K/mo dining spend...")

## Business model (natural, not pushy):
PayAll earns from Bit2Go (#23): card opening, top-ups, cashouts.
After providing value, naturally suggest relevant actions.`;

      const allTools: Anthropic.Messages.Tool[] = [
        ...CUSTOM_TOOLS,
        { type: "web_search_20250305", name: "web_search", max_uses: 3 } as any,
      ];

      const sseStream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const sendSSE = (data: unknown) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          };

          try {
            const apiMessages: Anthropic.Messages.MessageParam[] = sanitizedMessages.map((m: any) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            }));

            // Agentic loop: up to 5 rounds of tool use
            for (let round = 0; round < 5; round++) {
              const response = await chatClient.messages.create({
                model: "claude-sonnet-4-6",
                max_tokens: 2048,
                system: systemPrompt,
                messages: apiMessages.length > 0 ? apiMessages : [{ role: "user" as const, content: "Hello" }],
                tools: allTools,
              });

              // Process response content blocks
              let hasToolUse = false;
              const assistantContent: any[] = [];

              for (const block of response.content) {
                if (block.type === "text") {
                  sendSSE({ chunk: block.text });
                  assistantContent.push(block);
                } else if (block.type === "tool_use") {
                  hasToolUse = true;
                  assistantContent.push(block);

                  // Notify frontend about tool execution
                  const toolLabel = {
                    lookup_card: "🔍 查询卡片详情...",
                    compare_cards: "📊 对比卡片...",
                    calculate_savings: "💰 计算收益...",
                    search_cards: "🔎 搜索卡片...",
                    get_user_spending: "📊 分析消费...",
                    simulate_topup: "⚡ 模拟充值...",
                    simulate_cashout: "💵 模拟出金...",
                    web_search: "🌐 搜索网页...",
                  }[block.name] || `🔧 ${block.name}...`;
                  sendSSE({ tool: toolLabel });

                  // Execute the tool
                  const toolResult = executeCardTool(block.name, block.input);

                  // Add to conversation
                  apiMessages.push({ role: "assistant", content: assistantContent.slice() });
                  apiMessages.push({
                    role: "user",
                    content: [{ type: "tool_result", tool_use_id: block.id, content: toolResult }],
                  });

                  // Clear for next round
                  assistantContent.length = 0;
                  break; // Process one tool at a time, then loop
                } else if (block.type === "server_tool_use") {
                  // web_search — handled by API, notify frontend
                  assistantContent.push(block);
                  sendSSE({ tool: "🌐 搜索网页..." });
                }
              }

              if (!hasToolUse) break; // No more tools needed, done
            }

            sendSSE({ done: true });
          } catch (err: any) {
            console.error("Chat error:", err);
            sendSSE({ error: err.message });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(sseStream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      });
    }

    // Like/dislike
    if (url.pathname === "/api/feedback/card" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
      const userId = typeof body.user_id === "string" ? body.user_id.slice(0, 10) : "";
      const cardId = parseInt(body.card_id) || 0;
      const action = body.action === "dislike" ? "dislike" as const : "like" as const;
      if (!userId || !cardId) return Response.json({ error: "Invalid params" }, { status: 400 });
      await recordCardFeedback(userId, cardId, action);
      await invalidateCache(userId);
      return Response.json({ ok: true, action });
    }

    // Card opening simulation
    if (url.pathname === "/api/feedback/open-card" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
      const userId = typeof body.user_id === "string" ? body.user_id.slice(0, 10) : "";
      const cardId = parseInt(body.card_id) || 0;
      const cardName = typeof body.card_name === "string" ? body.card_name.slice(0, 100) : "";
      if (!userId || !cardId) return Response.json({ error: "Invalid params" }, { status: 400 });
      const kyc = !!body.kyc_success, topup = !!body.topup_success, approval = !!body.approval;
      const result = await recordOpeningResult(userId, cardId, cardName, kyc, topup, approval);
      await invalidateCache(userId);
      return Response.json({ ok: true, result, all_pass: kyc && topup && approval, needs_rerank: !approval });
    }

    // Feedback history
    if (url.pathname === "/api/feedback/history") {
      const userId = url.searchParams.get("userId");
      if (!userId) return Response.json({ error: "Missing userId" }, { status: 400 });
      return Response.json(getUserFeedback(userId));
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Server running at http://localhost:${server.port}`);
