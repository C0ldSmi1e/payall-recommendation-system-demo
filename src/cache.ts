import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { User, Card, SendFn } from "./types";
import { runPipeline } from "./pipeline";

const CACHE_DIR = "./data/rec-cache";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Events we replay to SSE clients on cache hit. Includes the `plan` event and
// one `step_done` per pipeline step, followed by `pipeline_done`. This lets the
// frontend progress bar fill to 100% without any LLM calls.
interface CachedEvents {
  ts: number;
  events: Array<{ event: string; data: unknown }>;
}

// Track in-flight precomputes so concurrent calls don't kick off duplicate pipelines.
const inFlight = new Map<string, Promise<void>>();

export function getInFlight(userId: string): Promise<void> | undefined {
  return inFlight.get(userId);
}

function pathFor(userId: string) {
  return `${CACHE_DIR}/${userId}.json`;
}

async function ensureDir() {
  if (!existsSync(CACHE_DIR)) await mkdir(CACHE_DIR, { recursive: true });
}

export async function readCache(userId: string): Promise<CachedEvents | null> {
  const p = pathFor(userId);
  if (!existsSync(p)) return null;
  try {
    const cached = (await Bun.file(p).json()) as CachedEvents;
    if (Date.now() - cached.ts > TTL_MS) return null;
    return cached;
  } catch {
    return null;
  }
}

async function writeCache(userId: string, events: CachedEvents["events"]) {
  await ensureDir();
  const payload: CachedEvents = { ts: Date.now(), events };
  await Bun.write(pathFor(userId), JSON.stringify(payload));
}

export async function invalidateCache(userId: string) {
  const p = pathFor(userId);
  if (existsSync(p)) {
    try { await Bun.file(p).delete?.(); } catch {}
    try { await Bun.$`rm -f ${p}`.quiet(); } catch {}
  }
}

// Runs the full pipeline while capturing every SSE event. On `pipeline_done`
// the captured sequence is written to disk. `send` can optionally forward
// events to a live client (stream endpoint cold path). When called as a
// background precompute, `send` is a no-op.
export async function runAndCache(
  user: User,
  cards: Card[],
  send: SendFn = () => {},
): Promise<void> {
  const captured: CachedEvents["events"] = [];
  const capturingSend: SendFn = (event, data) => {
    captured.push({ event, data });
    send(event, data);
  };
  await runPipeline(user, cards, capturingSend);
  // Only cache if pipeline produced a final recommendation.
  if (captured.some((e) => e.event === "pipeline_done")) {
    await writeCache(user.id, captured);
  }
}

// Fire-and-forget: dedupe concurrent precomputes, swallow errors.
export function precompute(user: User, cards: Card[]): Promise<void> {
  const existing = inFlight.get(user.id);
  if (existing) return existing;
  const p = runAndCache(user, cards)
    .catch((err) => { console.error(`[precompute] ${user.id}:`, err.message); })
    .finally(() => { inFlight.delete(user.id); });
  inFlight.set(user.id, p);
  return p;
}
