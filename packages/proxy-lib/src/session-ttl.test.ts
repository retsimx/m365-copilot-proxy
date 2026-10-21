import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleChatCompletion, SessionPool, resetNewSessionPacing, resetTurnVelocityPacing, resetTurnQueue, resetModelExhaustion } from "./handler.js";
import * as core from "@m365-copilot/core";

/**
 * Session idle-TTL (MAX_IDLE_MS = 30 min) eviction semantics.
 *
 * Two invariants:
 *   1. A conversation with an IN-FLIGHT turn is never reaped, however long the turn takes
 *      (deep-reasoning turns can exceed 30 min). The dashboard's /api/metrics poll calls
 *      getSessionsSnapshot() every 2s, which runs the same reaper.
 *   2. The idle countdown restarts when the turn ENDS, not when it started.
 */

const msgs = [
  { role: "system" as const, content: "sys" },
  { role: "user" as const, content: "hello" },
];

describe("SessionPool idle-TTL eviction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not evict a conversation whose turn is in flight, even after the TTL", () => {
    const pool = new SessionPool();
    const conv = pool.resolve(msgs, undefined, "sess");
    pool.beginTurn(conv);

    // 45 minutes of a single slow reasoning turn.
    vi.setSystemTime(new Date(Date.now() + 45 * 60 * 1000));

    // The dashboard poll reaps here today (getSessionsSnapshot -> evictStale).
    expect(pool.getSessionsSnapshot()).toHaveLength(1);
    expect(pool.size).toBe(1);
    // ...and the next request must land on the SAME remote conversation.
    expect(pool.resolve(msgs, undefined, "sess")).toBe(conv);
  });

  it("restarts the idle countdown when the turn ends, not when it started", () => {
    const pool = new SessionPool();
    const conv = pool.resolve(msgs, undefined, "sess");
    pool.beginTurn(conv);

    vi.setSystemTime(new Date(Date.now() + 25 * 60 * 1000)); // turn ends 25m in
    pool.endTurn(conv);

    // 50m after turn START but only 25m after it ENDED -> still live.
    vi.setSystemTime(new Date(Date.now() + 25 * 60 * 1000));
    expect(pool.size).toBe(1);
    expect(pool.resolve(msgs, undefined, "sess")).toBe(conv);

    // 31m of true idleness -> genuinely stale, evicted as a fresh conversation.
    vi.setSystemTime(new Date(Date.now() + 31 * 60 * 1000));
    const fresh = pool.resolve(msgs, undefined, "sess");
    expect(fresh).not.toBe(conv);
  });

  it("keeps a >TTL turn's session alive for the immediately following turn", () => {
    const pool = new SessionPool();
    const conv = pool.resolve(msgs, undefined, "sess");
    const cid = conv.session.conversationId;
    pool.beginTurn(conv);

    vi.setSystemTime(new Date(Date.now() + 90 * 60 * 1000)); // 90m turn
    pool.endTurn(conv);

    const followUp = pool.resolve(msgs, undefined, "sess");
    expect(followUp).toBe(conv);
    expect(followUp.session.conversationId).toBe(cid);
  });
});

describe("handleChatCompletion marks turns active for the reaper", () => {
  beforeEach(() => {
    resetNewSessionPacing();
    resetTurnVelocityPacing();
    resetTurnQueue();
    resetModelExhaustion();
    vi.restoreAllMocks();
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not evict a conversation while its turn is streaming (long turn)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        await gate; // a turn that takes "45 minutes" (we backdate instead of waiting)
        yield "done";
      },
      fullText: "done",
      hasContent: true,
      throttle: null,
      scores: null,
      turnCount: 1,
    } as any);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: msgs,
      stream: false,
    };

    const inflight = handleChatCompletion(body, pool);
    await Promise.resolve(); // let the turn reach the blocked stream

    // Backdate the activity stamp as if 45 minutes of streaming had elapsed.
    const conv = pool.resolve(body.messages, body.tools);
    conv.lastAccessedAt = Date.now() - 45 * 60 * 1000;

    expect(pool.getSessionsSnapshot()).toHaveLength(1); // dashboard poll must not reap it

    release();
    const res = await inflight;
    expect(res.status).toBe(200);
    expect(pool.resolve(body.messages, body.tools)).toBe(conv);
  });

  it("releases the turn flag and refreshes the idle stamp when the turn finishes", async () => {
    vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      [Symbol.asyncIterator]: async function* () { yield "ok"; },
      fullText: "ok",
      hasContent: true,
      throttle: null,
      scores: null,
      turnCount: 1,
    } as any);

    const pool = new SessionPool();
    const body = { model: "gpt-5.5-think-deeper", messages: msgs, stream: false };

    const res = await handleChatCompletion(body, pool);
    expect(res.status).toBe(200);

    const conv = pool.resolve(body.messages, body.tools);
    expect((conv as any).activeTurns).toBe(0);
    expect(Date.now() - conv.lastAccessedAt).toBeLessThan(1000);
  });
});
