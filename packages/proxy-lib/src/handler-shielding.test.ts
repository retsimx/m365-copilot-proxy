import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  handleChatCompletion,
  SessionPool,
  paceNewSessionStart,
  resetNewSessionPacing,
  paceTurnVelocity,
  resetTurnVelocityPacing,
  resetTurnQueue,
  hasPostFenceContamination,
  turnPaceWait,
  markModelExhausted,
  isModelExhausted,
  resetModelExhaustion,
  type PaceConfig,
} from "./handler.js";
import * as core from "@m365-copilot/core";
import { getNewSessionsInWindow, getTurnsInWindow, resetMetrics } from "./metrics.js";

describe("Handler Degradation Circuit Breaker & 429 Retry-After Shielding", () => {
  beforeEach(() => {
    resetNewSessionPacing();
    resetTurnVelocityPacing();
    resetModelExhaustion();
    vi.restoreAllMocks();
  });

  it("returns HTTP 429 with Retry-After and verbose message when degradation circuit breaker is active", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(true);
    vi.spyOn(core, "getRemainingDegradationCooldownMs").mockReturnValue(45_000);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Hello test" }],
      stream: false,
    };

    const response = await handleChatCompletion(body, pool);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    expect(response.headers.get("Content-Type")).toBe("application/json");

    const json = await response.json() as any;
    expect(json.error).toBeDefined();
    expect(json.error.type).toBe("rate_limit_error");
    expect(json.error.code).toBe("rate_limit_exceeded");
    expect(json.error.message).toContain("45s remaining");
    expect(json.error.message).toContain("Client will retry automatically");
  });

  it("returns HTTP 429 with capped Retry-After (60s) for streaming requests when degradation circuit breaker is active", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(true);
    vi.spyOn(core, "getRemainingDegradationCooldownMs").mockReturnValue(600_000);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Hello test streaming" }],
      stream: true,
    };

    const response = await handleChatCompletion(body, pool);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Content-Type")).toBe("application/json");

    const json = (await response.json()) as any;
    expect(json.error).toBeDefined();
    expect(json.error.type).toBe("rate_limit_error");
    expect(json.error.code).toBe("rate_limit_exceeded");
    expect(json.error.message).toContain("600s remaining");
    expect(json.error.message).toContain("Client will retry automatically");
  });

  it("returns HTTP 502 terminal error when upstream returns empty response after retries", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    vi.spyOn(core, "getRemainingDegradationCooldownMs").mockReturnValue(90_000);

    // Mock ModelSession.prototype.run to simulate empty stream
    vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {},
      fullText: "",
      hasContent: false,
      throttle: { current: 3, max: 600 },
      scores: null,
      turnCount: 1,
    } as any);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Hello test" }],
      stream: false,
    };

    const response = await handleChatCompletion(body, pool);

    // 403 — NON-retryable (the AI SDK retries only 408/409/429/5xx), so the client
    // terminates the turn instead of re-issuing it.
    expect(response.status).toBe(403);
    expect([408, 409, 429]).not.toContain(response.status);
    expect(response.status).toBeLessThan(500);
    expect(response.headers.get("Retry-After")).toBeNull();
    const json = await response.json() as any;
    expect(json.error.type).toBe("model_exhausted");
    expect(json.error.code).toBe("model_quota_exhausted");
    expect(json.error.message).toContain("gpt-5.5-think-deeper");
    expect(json.error.message).toContain("exhausted its daily quota or priority access for today");
    expect(json.error.message).toContain("Please choose another available model or wait until tomorrow");
    expect(json.error.message).toContain("Do not resume this session with this model");
    expect(json.error.message).toContain("throttle 3/600");
  }, 15000);

  it("advises model exhaustion and resets conversation when model receives empty response", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    vi.spyOn(core, "getRemainingDegradationCooldownMs").mockReturnValue(90_000);
    const resetSpy = vi.spyOn(core.ModelSession.prototype, "reset");
    const refreshSpy = vi.spyOn(core.ModelSession.prototype, "refreshAgent");

    vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {},
      fullText: "",
      hasContent: false,
      throttle: null,
      scores: null,
      turnCount: 1,
    } as any);

    const pool = new SessionPool();
    const body = {
      model: "claude-opus-5.5",
      messages: [{ role: "user" as const, content: "Hello test model exhaustion" }],
      stream: false,
    };

    // Pre-populate conversation with sent messages to verify reset
    const preConv = pool.resolve(body.messages, body.tools);
    preConv.sentMessageCount = 1;

    const response = await handleChatCompletion(body, pool);

    expect(response.status).toBe(403);
    expect(response.headers.get("Retry-After")).toBeNull();
    const json = (await response.json()) as any;
    expect(json.error.type).toBe("model_exhausted");
    expect(json.error.code).toBe("model_quota_exhausted");
    expect(json.error.message).toContain("claude-opus-5.5");
    expect(json.error.message).toContain("exhausted its daily quota or priority access for today");
    expect(json.error.message).toContain("Please choose another available model or wait until tomorrow");
    expect(json.error.message).toContain("Do not resume this session with this model");

    const conv = pool.resolve(body.messages, body.tools);
    expect(conv.sentMessageCount).toBe(0);
    expect(resetSpy).toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
  }, 15000);

  it("short-circuits a model already known exhausted with an immediate non-retryable 403 and NO upstream turn", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    const runSpy = vi.spyOn(core.ModelSession.prototype, "run");

    // A previous request marked this model exhausted (daily quota).
    markModelExhausted("claude-opus-5.5");

    const pool = new SessionPool();
    const body = {
      model: "claude-opus-5.5",
      messages: [{ role: "user" as const, content: "one more try" }],
      stream: true, // even a streaming request gets a NON-streamed 403
    };

    const response = await handleChatCompletion(body, pool);

    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const json = (await response.json()) as any;
    expect(json.error.type).toBe("model_exhausted");
    expect(json.error.code).toBe("model_quota_exhausted");
    // The whole point: on the retry we send ZERO traffic to Microsoft.
    expect(runSpy).not.toHaveBeenCalled();
  });

  // ---- exhaustion short-circuit: the cases the happy path doesn't cover ----

  const emptyStream = () => ({
    [Symbol.asyncIterator]: async function* () {},
    fullText: "",
    hasContent: false,
    throttle: { current: 3, max: 600 },
    scores: null,
    turnCount: 1,
  } as any);
  const contentStream = (text: string) => ({
    [Symbol.asyncIterator]: async function* () { yield text; },
    fullText: text,
    hasContent: true,
    throttle: { current: 1, max: 600 },
    scores: null,
    turnCount: 1,
  } as any);
  const chatReq = (model: string) => ({
    model,
    messages: [{ role: "user" as const, content: "hi" }],
    stream: false,
  });

  it("M365_EXHAUSTION_TTL_SEC=0 disables the short-circuit (never marks)", () => {
    const orig = process.env.M365_EXHAUSTION_TTL_SEC;
    process.env.M365_EXHAUSTION_TTL_SEC = "0";
    try {
      markModelExhausted("m");
      expect(isModelExhausted("m")).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.M365_EXHAUSTION_TTL_SEC;
      else process.env.M365_EXHAUSTION_TTL_SEC = orig;
    }
  });

  it("the block lifts lazily after M365_EXHAUSTION_TTL_SEC (no timer)", () => {
    const orig = process.env.M365_EXHAUSTION_TTL_SEC;
    process.env.M365_EXHAUSTION_TTL_SEC = "60";
    vi.useFakeTimers();
    try {
      const t0 = 1_700_000_000_000;
      vi.setSystemTime(t0);
      markModelExhausted("m");
      expect(isModelExhausted("m")).toBe(true);
      vi.setSystemTime(t0 + 59_000);
      expect(isModelExhausted("m")).toBe(true); // still within the TTL
      vi.setSystemTime(t0 + 60_000);
      expect(isModelExhausted("m")).toBe(false); // lazily purged on access
      expect(isModelExhausted("m")).toBe(false); // and stays clean
    } finally {
      vi.useRealTimers();
      if (orig === undefined) delete process.env.M365_EXHAUSTION_TTL_SEC;
      else process.env.M365_EXHAUSTION_TTL_SEC = orig;
    }
  });

  it("a transient empty that recovers on the retry does NOT mark exhaustion", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    let calls = 0;
    vi.spyOn(core.ModelSession.prototype, "run").mockImplementation(
      async () => (++calls === 1 ? emptyStream() : contentStream("recovered")),
    );
    const response = await handleChatCompletion(chatReq("claude-sonnet-5.5") as any, new SessionPool());
    expect(response.status).toBe(200);
    expect(calls).toBe(2); // exactly one retry
    expect(isModelExhausted("claude-sonnet-5.5")).toBe(false);
  }, 15000);

  it("does NOT block a DIFFERENT model (the block is per-model)", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    markModelExhausted("claude-opus-5.5");
    const runSpy = vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue(contentStream("ok"));
    const response = await handleChatCompletion(chatReq("claude-sonnet-5.5") as any, new SessionPool());
    expect(response.status).toBe(200);
    expect(runSpy).toHaveBeenCalled();
    expect(isModelExhausted("claude-opus-5.5")).toBe(true); // untouched
  }, 15000);

  it("first exhaustion marks the model; the NEXT request short-circuits with zero upstream turns", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    const runSpy = vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue(emptyStream());
    const pool = new SessionPool();

    const r1 = await handleChatCompletion(chatReq("claude-sonnet-5.5") as any, pool);
    expect(r1.status).toBe(403);
    expect(isModelExhausted("claude-sonnet-5.5")).toBe(true);
    const attempts1 = runSpy.mock.calls.length;
    expect(attempts1).toBeGreaterThan(1); // it retried (MAX_RETRIES) before marking

    const r2 = await handleChatCompletion(chatReq("claude-sonnet-5.5") as any, pool);
    expect(r2.status).toBe(403);
    expect(runSpy.mock.calls.length).toBe(attempts1); // ZERO new upstream turns on the retry
  }, 20000);

  it("preserves the exhausted error type/code in the in-stream error chunk (not a generic upstream_error)", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    vi.spyOn(core, "getRemainingDegradationCooldownMs").mockReturnValue(90_000);

    // Empty upstream reply (e.g. daily model quota / priority access exhausted) on a
    // streaming request — the HTTP status is committed to 200 up front, so the failure
    // must be surfaced as an in-stream error chunk that keeps the specific type/code.
    vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {},
      fullText: "",
      hasContent: false,
      throttle: { current: 33, max: 600 },
      scores: null,
      turnCount: 1,
    } as any);

    const pool = new SessionPool();
    const body = {
      model: "claude-sonnet-5.5",
      messages: [{ role: "user" as const, content: "Hello streaming exhaustion" }],
      stream: true,
    };

    const response = await handleChatCompletion(body, pool);

    // Status is committed to 200 before the turn's outcome is known (early-flush SSE).
    expect(response.status).toBe(200);

    const text = await response.text();
    const errorChunk = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .filter((payload) => payload !== "[DONE]")
      .map((payload) => JSON.parse(payload))
      .find((chunk) => chunk.error);

    expect(errorChunk).toBeDefined();
    // The specific exhaustion signal must survive — NOT flattened to `upstream_error`.
    expect(errorChunk.error.type).toBe("model_exhausted");
    expect(errorChunk.error.code).toBe("model_quota_exhausted");
    expect(errorChunk.error.message).toContain("exhausted its daily quota or priority access for today");
  }, 20000);

  it("returns HTTP 429 when conversation quota limit is reached (600/600)", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);

    vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {},
      fullText: "",
      hasContent: false,
      throttle: { current: 600, max: 600 },
      scores: null,
      turnCount: 600,
    } as any);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Hello test" }],
      stream: false,
    };

    const response = await handleChatCompletion(body, pool);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    const json = await response.json() as any;
    expect(json.error.type).toBe("rate_limit_error");
    expect(json.error.code).toBe("rate_limit_exceeded");
    expect(json.error.message).toContain("600/600 messages used in this conversation");
  });

  it("returns HTTP 200 with the refusal text when tool confabulation persists after retries", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    vi.spyOn(core, "classifyTurnResponse").mockResolvedValue("REFUSAL");

    const runSpy = vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {},
      fullText: "I can't generate or verify the requested file because file-generation capabilities are disabled in this session.",
      hasContent: true,
      throttle: { current: 1, max: 600 },
      scores: null,
      turnCount: 1,
    } as any);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Run the tests" }],
      tools: [
        {
          type: "function" as const,
          function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
        },
      ],
      stream: false,
    };

    const response = await handleChatCompletion(body, pool);

    expect(response.status).toBe(200);
    const json = await response.json() as any;
    const content: string = json.choices[0].message.content;
    expect(content).toContain("I can't generate or verify the requested file");
    // Every attempt is separated by an explicit marker.
    expect(content).toContain("--- REFUSAL DETECTED - RETRY 1/3 ---");
    expect(content).toContain("--- REFUSAL DETECTED - RETRY 2/3 ---");
    expect(content).toContain("--- REFUSAL DETECTED - RETRY 3/3 ---");
    // Attempted initial turn + 3 retries = 4 runs total
    expect(runSpy).toHaveBeenCalledTimes(4);
  }, 15000);

  it("fails fast with HTTP 429 when copilotStream.isThrottled is true, arming degradation backoff and performing no retries", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    const triggerSpy = vi.spyOn(core, "triggerDegradationBackoff").mockImplementation(() => {});

    const mockStream: any = {
      [Symbol.asyncIterator]: async function* () {},
      fullText: "",
      hasContent: false,
      throttle: null,
      scores: null,
      turnCount: 0,
      turnState: "Failed",
      result: {
        value: "Throttled",
        errorCode: "PerScenarioThrottled",
        message: "Rate limit exceeded for scenario",
      },
      isThrottled: true,
    };

    const runSpy = vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue(mockStream);
    const resetSpy = vi.spyOn(core.ModelSession.prototype, "reset");

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-quick",
      messages: [{ role: "user" as const, content: "Test prompt" }],
      stream: false,
    };

    const response = await handleChatCompletion(body, pool);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    const json = (await response.json()) as any;
    expect(json.error).toBeDefined();
    expect(json.error.type).toBe("rate_limit_error");
    expect(json.error.code).toBe("rate_limit_exceeded");
    expect(json.error.message).toContain("1800s remaining");

    // Fast-fail: exactly 1 attempt (no "Please continue." retries)
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalled();
    expect(triggerSpy).toHaveBeenCalledWith(1_800_000, "PerScenarioThrottled");
  });

  it("fails fast with HTTP 429 when copilotStream errorCode is PerUserThrottled, arming 1200s cooldown by default", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    const triggerSpy = vi.spyOn(core, "triggerDegradationBackoff").mockImplementation(() => {});

    const mockStream: any = {
      [Symbol.asyncIterator]: async function* () {},
      fullText: "",
      hasContent: false,
      throttle: null,
      scores: null,
      turnCount: 0,
      turnState: "Failed",
      result: {
        value: "Throttled",
        errorCode: "PerUserThrottled",
        message: "Rate limit exceeded for user",
      },
      isThrottled: true,
    };

    const runSpy = vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue(mockStream);
    const resetSpy = vi.spyOn(core.ModelSession.prototype, "reset");

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-quick",
      messages: [{ role: "user" as const, content: "Test prompt" }],
      stream: false,
    };

    const response = await handleChatCompletion(body, pool);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    const json = (await response.json()) as any;
    expect(json.error).toBeDefined();
    expect(json.error.type).toBe("rate_limit_error");
    expect(json.error.code).toBe("rate_limit_exceeded");
    expect(json.error.message).toContain("1200s remaining");

    // Fast-fail: exactly 1 attempt (no "Please continue." retries)
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalled();
    expect(triggerSpy).toHaveBeenCalledWith(1_200_000, "PerUserThrottled");
  });

  it("respects custom M365_USER_THROTTLE_PROBE_SEC environment variable when PerUserThrottled", async () => {
    const origUserCooldown = process.env.M365_USER_THROTTLE_PROBE_SEC;
    try {
      process.env.M365_USER_THROTTLE_PROBE_SEC = "2400";
      vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
      const triggerSpy = vi.spyOn(core, "triggerDegradationBackoff").mockImplementation(() => {});

      const mockStream: any = {
        [Symbol.asyncIterator]: async function* () {},
        fullText: "",
        hasContent: false,
        throttle: null,
        scores: null,
        turnCount: 0,
        turnState: "Failed",
        result: {
          value: "Throttled",
          errorCode: "PerUserThrottled",
          message: "Rate limit exceeded for user",
        },
        isThrottled: true,
      };

      vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue(mockStream);
      vi.spyOn(core.ModelSession.prototype, "reset");

      const pool = new SessionPool();
      const body = {
        model: "gpt-5.5-quick",
        messages: [{ role: "user" as const, content: "Test prompt" }],
        stream: false,
      };

      const response = await handleChatCompletion(body, pool);
      expect(response.status).toBe(429);
      expect(triggerSpy).toHaveBeenCalledWith(2_400_000, "PerUserThrottled");
    } finally {
      if (origUserCooldown !== undefined) {
        process.env.M365_USER_THROTTLE_PROBE_SEC = origUserCooldown;
      } else {
        delete process.env.M365_USER_THROTTLE_PROBE_SEC;
      }
    }
  });
});

describe("New Session Pacing Queue", () => {
  beforeEach(() => {
    resetNewSessionPacing();
    resetTurnVelocityPacing();
    vi.restoreAllMocks();
  });

  it("paces sequential invocations by 15s and resolves cleanly", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      resetNewSessionPacing();

      // Call 1: immediate (delay 0)
      const p1 = paceNewSessionStart();
      const delay1 = await p1;
      expect(delay1).toBe(0);

      // Call 2: scheduled 15s later
      const p2 = paceNewSessionStart();
      let p2Resolved = false;
      p2.then(() => {
        p2Resolved = true;
      });
      expect(p2Resolved).toBe(false);

      // Advance by 15s
      now += 15_000;
      await vi.advanceTimersByTimeAsync(15_000);
      const delay2 = await p2;
      expect(delay2).toBe(15_000);
      expect(p2Resolved).toBe(true);

      // Call 3: scheduled another 15s later
      const p3 = paceNewSessionStart();
      let p3Resolved = false;
      p3.then(() => {
        p3Resolved = true;
      });
      expect(p3Resolved).toBe(false);

      now += 15_000;
      await vi.advanceTimersByTimeAsync(15_000);
      const delay3 = await p3;
      expect(delay3).toBe(15_000);
      expect(p3Resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetNewSessionPacing resets the schedule timestamp", async () => {
    vi.useFakeTimers();
    try {
      let now = 5000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      resetNewSessionPacing();

      const delay1 = await paceNewSessionStart();
      expect(delay1).toBe(0);

      // Reset
      resetNewSessionPacing();

      // Next call should have 0 delay because pacing schedule was reset
      const delay2 = await paceNewSessionStart();
      expect(delay2).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts when signal is cancelled while in pacing queue", async () => {
    vi.useFakeTimers();
    try {
      let now = 1000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      resetNewSessionPacing();

      await paceNewSessionStart(); // prime slot 1

      const ac = new AbortController();
      const p2 = paceNewSessionStart(ac.signal);

      ac.abort();
      await expect(p2).rejects.toThrow("Aborted while waiting in new session pacing queue");
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows 10 sessions to burst with only 15s micro-stagger between consecutive starts", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      resetNewSessionPacing();

      const delays: number[] = [];
      const promises = Array.from({ length: 10 }, (_, i) =>
        paceNewSessionStart().then((d) => {
          delays[i] = d;
        })
      );

      // Yield to microtasks so delay 0 resolves
      await Promise.resolve();
      expect(delays[0]).toBe(0);

      // Each subsequent session i is staggered by exactly i * 15s
      for (let i = 1; i < 10; i++) {
        expect(delays[i]).toBeUndefined();
        now += 15_000;
        await vi.advanceTimersByTimeAsync(15_000);
        expect(delays[i]).toBe(i * 15_000);
      }

      await Promise.all(promises);
      expect(delays).toEqual([
        0,
        15_000,
        30_000,
        45_000,
        60_000,
        75_000,
        90_000,
        105_000,
        120_000,
        135_000,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces token refill wait (~150s) when bucket capacity of 10 is exhausted on session 11", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      resetNewSessionPacing();

      // Exhaust all 10 tokens in burst at t=10_000
      const burstPromises = Array.from({ length: 10 }, () => paceNewSessionStart());

      // Call 11 at t=10_000: bucket is empty (0 tokens remaining)
      let p11Resolved = false;
      let delay11 = 0;
      const p11 = paceNewSessionStart().then((d) => {
        p11Resolved = true;
        delay11 = d;
      });

      // Session 11 cannot resolve before token refill interval (150s = 150_000ms)
      expect(p11Resolved).toBe(false);

      // Advance by 135s (when session 10 dispatched) — session 11 must still be pending
      now += 135_000;
      await vi.advanceTimersByTimeAsync(135_000);
      expect(p11Resolved).toBe(false);

      // Advance remaining 15s to reach 150s total from start
      now += 15_000;
      await vi.advanceTimersByTimeAsync(15_000);
      await p11;
      expect(p11Resolved).toBe(true);
      expect(delay11).toBe(150_000);

      await Promise.all(burstPromises);
    } finally {
      vi.useRealTimers();
    }
  });

  it("continuously replenishes tokens over time (advancing 300s replenishes 2 tokens)", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      resetNewSessionPacing();

      // Exhaust all 10 tokens in burst at t=10_000
      const initialBurst = Array.from({ length: 10 }, () => paceNewSessionStart());
      // Advance by 300s (300_000ms), resolving all 10 initial sessions and replenishing floor(300000 / 150000) = 2 tokens.
      now += 300_000;
      await vi.advanceTimersByTimeAsync(300_000);
      await Promise.all(initialBurst);

      // Next session at t=310_000 consumes token 1 of 2: delay should be 0ms
      const delay1 = await paceNewSessionStart();
      expect(delay1).toBe(0);

      // Next session at t=310_000 consumes token 2 of 2: only delayed by 15s micro-stagger, not token refill
      let p2Resolved = false;
      const p2 = paceNewSessionStart().then((d) => {
        p2Resolved = true;
        return d;
      });
      expect(p2Resolved).toBe(false);
      now += 15_000;
      await vi.advanceTimersByTimeAsync(15_000);
      const delay2 = await p2;
      expect(p2Resolved).toBe(true);
      expect(delay2).toBe(15_000);

      // Third session at t=325_000 has 0 tokens left: must wait for the next token refill (~150s - 15s = 135s)
      let p3Resolved = false;
      const p3 = paceNewSessionStart().then((d) => {
        p3Resolved = true;
        return d;
      });
      expect(p3Resolved).toBe(false);

      // Advance by 134s: still waiting
      now += 134_000;
      await vi.advanceTimersByTimeAsync(134_000);
      expect(p3Resolved).toBe(false);

      // Advance by 1s (reaching 135s since start of third session): resolves
      now += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      const delay3 = await p3;
      expect(p3Resolved).toBe(true);
      expect(delay3).toBe(135_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts when signal is cancelled while waiting for token refill", async () => {
    vi.useFakeTimers();
    try {
      let now = 1000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      resetNewSessionPacing();

      // Exhaust 10 tokens in burst
      Array.from({ length: 10 }, () => paceNewSessionStart());

      const ac = new AbortController();
      const p11 = paceNewSessionStart(ac.signal);

      ac.abort();
      await expect(p11).rejects.toThrow("Aborted while waiting in new session pacing queue");
    } finally {
      vi.useRealTimers();
    }
  });

});


describe("Hidden upstream attempt accounting", () => {
  const originalEnv = {
    minTurnSpacing: process.env.M365_MIN_TURN_SPACING_MS,
    newSessionSpacing: process.env.M365_NEW_SESSION_SPACING_MS,
    sessionCapacity: process.env.M365_SESSION_BUCKET_CAPACITY,
  };

  beforeEach(() => {
    process.env.M365_MIN_TURN_SPACING_MS = "0";
    process.env.M365_NEW_SESSION_SPACING_MS = "0";
    process.env.M365_SESSION_BUCKET_CAPACITY = "10";
    resetNewSessionPacing();
    resetTurnVelocityPacing();
    resetMetrics();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalEnv.minTurnSpacing === undefined) delete process.env.M365_MIN_TURN_SPACING_MS;
    else process.env.M365_MIN_TURN_SPACING_MS = originalEnv.minTurnSpacing;
    if (originalEnv.newSessionSpacing === undefined) delete process.env.M365_NEW_SESSION_SPACING_MS;
    else process.env.M365_NEW_SESSION_SPACING_MS = originalEnv.newSessionSpacing;
    if (originalEnv.sessionCapacity === undefined) delete process.env.M365_SESSION_BUCKET_CAPACITY;
    else process.env.M365_SESSION_BUCKET_CAPACITY = originalEnv.sessionCapacity;
    vi.restoreAllMocks();
  });

  it("charges a turn and fresh-session permit for a Disengaged recovery attempt", async () => {
    const streams = [
      {
        async *[Symbol.asyncIterator]() {},
        fullText: "",
        hasContent: false,
        images: [],
        isThrottled: false,
        messageType: "Disengaged",
        contentOrigin: "DeepLeo",
        scores: {},
        turnCount: 1,
        throttle: null,
      },
      {
        async *[Symbol.asyncIterator]() { yield ["```bash", "pwd", "```"].join("\n"); },
        fullText: ["```bash", "pwd", "```"].join("\n"),
        hasContent: true,
        images: [],
        isThrottled: false,
        messageType: undefined,
        contentOrigin: "DeepLeo",
        scores: {},
        turnCount: 1,
        throttle: null,
      },
    ] as any[];
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    const runSpy = vi.spyOn(core.ModelSession.prototype, "run")
      .mockImplementation(async () => streams.shift() as any);

    const response = await handleChatCompletion({
      model: "gpt-5.6-think-deeper",
      messages: [{ role: "user" as const, content: "inspect the project" }],
      stream: false,
      tools: [{
        type: "function",
        function: {
          name: "bash",
          description: "Run a command",
          parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        },
      }],
    } as any, new SessionPool());

    expect(response.status).toBe(200);
    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(getTurnsInWindow(3_600_000)).toBe(2);
    expect(getNewSessionsInWindow(3_600_000)).toBe(2);
  });

  it("charges an additional governed turn when ModelSession requests a transport reconnect", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    vi.spyOn(core.ModelSession.prototype, "run").mockImplementation(async (_text, _model, _signal, _agent, options: any) => {
      await options.beforeReconnectAttempt();
      return {
        async *[Symbol.asyncIterator]() { yield "ok"; },
        fullText: "ok",
        hasContent: true,
        images: [],
        isThrottled: false,
        messageType: undefined,
        contentOrigin: "DeepLeo",
        scores: {},
        turnCount: 1,
        throttle: null,
      } as any;
    });

    const response = await handleChatCompletion({
      model: "gpt-5.6-think-deeper",
      messages: [{ role: "user" as const, content: "hello" }],
      stream: false,
    }, new SessionPool());

    expect(response.status).toBe(200);
    expect(getTurnsInWindow(3_600_000)).toBe(2);
    expect(getNewSessionsInWindow(3_600_000)).toBe(1);
  });
});

describe("Two-layer Velocity Governor (paceTurnVelocity)", () => {
  const PACE_ENV = [
    "M365_MIN_TURN_SPACING_MS",
    "M365_SUSTAINED_WINDOW_MS",
    "M365_SUSTAINED_MAX_TURNS",
    "M365_BURST_WINDOW_MS",
    "M365_BURST_MAX_TURNS",
    "M365_PACE_BURST_ALLOWANCE",
    "M365_PACE_CEILING_MS",
  ];
  let saved: Record<string, string | undefined>;
  let savedStateFile: string | undefined;
  let tmpStateFile: string;

  beforeEach(() => {
    saved = {};
    for (const k of PACE_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    // Keep the debounced state-save from clobbering the real proxy-state.json.
    savedStateFile = process.env.M365_STATE_FILE;
    tmpStateFile = join(tmpdir(), `m365-pace-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    process.env.M365_STATE_FILE = tmpStateFile;
    resetTurnVelocityPacing();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    for (const k of PACE_ENV) { if (saved[k] !== undefined) process.env[k] = saved[k]; else delete process.env[k]; }
    if (savedStateFile !== undefined) process.env.M365_STATE_FILE = savedStateFile;
    else delete process.env.M365_STATE_FILE;
    try { if (existsSync(tmpStateFile)) unlinkSync(tmpStateFile); } catch {}
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Dispatch `n` turns back-to-back under sustained queued demand and return each
   *  dispatch time relative to the injected base clock. Must be called with fake timers active. */
  async function runSustainedTurns(n: number): Promise<number[]> {
    const base = 1_000_000;
    vi.setSystemTime(base);
    const times: number[] = [];
    const promises: Promise<number>[] = [];
    for (let i = 0; i < n; i++) {
      promises.push(paceTurnVelocity().then(() => { times.push(Date.now()); }));
    }
    await vi.advanceTimersByTimeAsync(n * 60_000);
    await Promise.all(promises);
    return times.map((t) => t - base);
  }

  // --- load-bearing landing-time property ---
  it("lands the 111th turn at the 60 min window boundary (GCRA front-loads a bounded burst)", async () => {
    vi.useFakeTimers();
    const times = await runSustainedTurns(111);
    expect(times).toHaveLength(111);
    const turn110 = times[109];
    const turn111 = times[110];
    // eslint-disable-next-line no-console
    console.log(`[pacing] turn110=${Math.round(turn110)}ms turn111=${Math.round(turn111)}ms`);
    // GCRA + a 6-turn burst allowance front-loads up to 7 turns at min-spacing, so the
    // 110th turn can land before the naive (110·T) point — but still inside the window.
    expect(turn110).toBeGreaterThanOrEqual(3_300_000);
    expect(turn110).toBeLessThanOrEqual(3_600_000);
    // The 111th turn cannot dispatch before the sustained window boundary.
    expect(turn111).toBeGreaterThanOrEqual(3_590_000);
    expect(turn111).toBeLessThanOrEqual(3_600_000);
  });

  // --- hard sustained cap ---
  it("never admits more than 110 dispatches in any 3_600_000 ms window", async () => {
    vi.useFakeTimers();
    const times = await runSustainedTurns(160);
    let max = 0;
    for (let i = 0; i < times.length; i++) {
      let c = 0;
      for (let j = i; j < times.length && times[j] - times[i] < 3_600_000; j++) c++;
      if (c > max) max = c;
    }
    // eslint-disable-next-line no-console
    console.log(`[pacing] max dispatches in 3_600_000ms = ${max}`);
    expect(max).toBeLessThanOrEqual(110);
    expect(times[110]).toBeGreaterThanOrEqual(3_600_000);
  });

  // --- hard burst cap ---
  it("never admits more than 8 dispatches in any 60_000 ms window", async () => {
    vi.useFakeTimers();
    const times = await runSustainedTurns(160);
    let max = 0;
    for (let i = 0; i < times.length; i++) {
      let c = 0;
      for (let j = i; j < times.length && times[j] - times[i] < 60_000; j++) c++;
      if (c > max) max = c;
    }
    // eslint-disable-next-line no-console
    console.log(`[pacing] max dispatches in 60_000ms = ${max}`);
    expect(max).toBeLessThanOrEqual(8);
  });

  // --- smoothness: ramp to T then hold it (no fast/slow chatter) ---
  it("paces smoothly: intervals ramp to the sustainable rate and then hold it", async () => {
    vi.useFakeTimers();
    const times = await runSustainedTurns(25);
    const intervals = times.slice(1, 21).map((t, i) => t - times[i]);
    const T = 3_600_000 / 110;
    for (let i = 1; i < intervals.length; i++) {
      // non-decreasing up to the sustainable interval (3 ms tolerance for ceil rounding)
      expect(intervals[i]).toBeGreaterThanOrEqual(intervals[i - 1] - 3);
      // never overshoots the sustainable pace (no cliff / no big spike within T)
      expect(intervals[i]).toBeLessThanOrEqual(T + 3);
    }
    // the tail settles at the sustainable interval
    for (const iv of intervals.slice(-5)) {
      expect(iv).toBeGreaterThanOrEqual(T - 3);
      expect(iv).toBeLessThanOrEqual(T + 3);
    }
  });

  // --- bursty idle goes fast; sustained queue paces ---
  it("lets an idle-separated flurry through instantly but paces a sustained back-to-back queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    const idleDelays: number[] = [];
    for (let i = 0; i < 5; i++) {
      idleDelays.push(await paceTurnVelocity());
      vi.advanceTimersByTime(10 * 60_000);
    }
    expect(idleDelays).toEqual([0, 0, 0, 0, 0]);

    resetTurnVelocityPacing();
    vi.setSystemTime(2_000_000);
    expect(await paceTurnVelocity()).toBe(0); // first of the sustained burst is immediate

    const p = paceTurnVelocity();
    let pacedDelay = -1;
    p.then((d) => { pacedDelay = d; });
    await Promise.resolve();
    expect(pacedDelay).toBe(-1); // second turn waits
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pacedDelay).toBeGreaterThan(0);
  });

  it("aborts and rejects when the signal is cancelled during the paced wait", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    await paceTurnVelocity(); // first turn immediate
    const ac = new AbortController();
    const p = paceTurnVelocity(ac.signal); // will wait

    ac.abort();
    await expect(p).rejects.toThrow("Aborted while waiting in turn velocity queue");
  });

  it("resetTurnVelocityPacing clears history so a fresh window starts unpaced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);

    expect(await paceTurnVelocity()).toBe(0); // first turn immediate
    const p2 = paceTurnVelocity();
    let d2 = -1;
    p2.then((d) => { d2 = d; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(d2).toBeGreaterThan(0); // history exists, second turn is paced

    resetTurnVelocityPacing();
    expect(await paceTurnVelocity()).toBe(0); // fresh window, unpaced
  });
});

describe("turnPaceWait (pure function)", () => {
  const cfg: PaceConfig = {
    windowMs: 3_600_000,
    maxTurns: 110,
    burstWindowMs: 60_000,
    burstMaxTurns: 8,
    burstAllowance: 6,
    minSpacingMs: 1_500,
  };

  it("returns the exact sustained drain-wait when the 60m window is full", () => {
    const now = 10_000_000;
    // 110 timestamps spanning the last 3_500_000 ms: oldest drains at now + 100_000.
    const ts = Array.from({ length: 110 }, (_, i) => now - 3_500_000 + i * 1000);
    const r = turnPaceWait(ts, now, now - 1000, 0, cfg);
    expect(r.waitMs).toBe(100_000);
    expect(r.cause).toBe("sustained-window");
  });

  it("returns the exact burst drain-wait when the 60s window is full", () => {
    const now = 5_000_000;
    // 8 timestamps inside 60s: the oldest drains at now + 52_000.
    const ts = Array.from({ length: 8 }, (_, i) => now - 8_000 + i * 100);
    const r = turnPaceWait(ts, now, now - 100, 0, cfg);
    expect(r.waitMs).toBe(52_000);
    expect(r.cause).toBe("burst-window");
  });

  it("returns 0 and cause 'ready' for an empty log with a spent GCRA schedule", () => {
    const r = turnPaceWait([], 1_000_000, 0, 0, cfg);
    expect(r.waitMs).toBe(0);
    expect(r.cause).toBe("ready");
  });
});

describe("Dual-Engine Classifier Integration in Handler", () => {
  let origSpacing: string | undefined;
  beforeEach(() => {
    origSpacing = process.env.M365_MIN_TURN_SPACING_MS;
    process.env.M365_MIN_TURN_SPACING_MS = "0";
    resetNewSessionPacing();
    resetTurnVelocityPacing();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (origSpacing !== undefined) {
      process.env.M365_MIN_TURN_SPACING_MS = origSpacing;
    } else {
      delete process.env.M365_MIN_TURN_SPACING_MS;
    }
  });

  it("immediately returns HTTP 200 with deliverable text and zero retries when classified as DELIVERABLE (Deliverable Bypass)", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    const classifySpy = vi.spyOn(core, "classifyTurnResponse").mockResolvedValue("DELIVERABLE");

    const deliverableText =
      "STATUS: PASS\nOUTPUT: /tmp/audit.md\nNOTE: Security verdict is VULNERABLE because session-authenticated mutation contract tests do not enforce CSRF checks.";

    const runSpy = vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {},
      fullText: deliverableText,
      hasContent: true,
      throttle: { current: 1, max: 600 },
      scores: null,
      turnCount: 1,
    } as any);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Run security audit and produce verdict" }],
      tools: [
        {
          type: "function" as const,
          function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
        },
      ],
      stream: false,
    };

    const response = await handleChatCompletion(body, pool);

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    expect(json.choices[0].message.content).toBe(deliverableText);
    expect(classifySpy).toHaveBeenCalledWith(deliverableText);
    // Deliverable bypass: exactly 1 run (ZERO confabulation retries)
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("attempts confabulation retries with CONFAB_FORCE_PROMPT and returns HTTP 200 with separated attempts when refusal persists (Refusal Retry)", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    const classifySpy = vi.spyOn(core, "classifyTurnResponse").mockResolvedValue("REFUSAL");

    const refusalText =
      "I apologize, but I will not generate the requested script. Please run the commands on your end.";

    const runSpy = vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {},
      fullText: refusalText,
      hasContent: true,
      throttle: { current: 1, max: 600 },
      scores: null,
      turnCount: 1,
    } as any);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Write review deliverable" }],
      tools: [
        {
          type: "function" as const,
          function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
        },
      ],
      stream: false,
    };

    const response = await handleChatCompletion(body, pool);

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    const content: string = json.choices[0].message.content;
    expect(content).toContain(refusalText);
    expect(content).toContain("--- REFUSAL DETECTED - RETRY 1/3 ---");
    expect(content).toContain("--- REFUSAL DETECTED - RETRY 2/3 ---");
    expect(content).toContain("--- REFUSAL DETECTED - RETRY 3/3 ---");

    // Initial turn + 3 retries = 4 runs total
    expect(runSpy).toHaveBeenCalledTimes(4);
    // Verify that retries sent CONFAB_FORCE_PROMPT
    const retryCallArg = runSpy.mock.calls[1][0];
    expect(retryCallArg).toContain("I will run the commands and paste the real output back to you");
    expect(retryCallArg).toContain("Output ONE self-contained ```bash block");
    expect(classifySpy).toHaveBeenCalledWith(refusalText);
  });

  it("triggers confabulation retries and returns HTTP 200 when report claims tools are unavailable (Dual Check Defense-in-Depth)", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    const classifySpy = vi.spyOn(core, "classifyTurnResponse").mockResolvedValue("REFUSAL");

    const reportRefusal =
      "STATUS: FAILED\nNOTES: No executable bash or file-writing tool is available in this session to perform the required actions.";

    const runSpy = vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {},
      fullText: reportRefusal,
      hasContent: true,
      throttle: { current: 1, max: 600 },
      scores: null,
      turnCount: 1,
    } as any);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Execute task and generate code" }],
      tools: [
        {
          type: "function" as const,
          function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
        },
      ],
      stream: false,
    };

    const response = await handleChatCompletion(body, pool);

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    const content: string = json.choices[0].message.content;
    expect(content).toContain(reportRefusal);
    expect(content).toContain("--- REFUSAL DETECTED - RETRY 1/3 ---");

    // Initial turn + 3 retries = 4 runs total
    expect(runSpy).toHaveBeenCalledTimes(4);
    const retryCallArg = runSpy.mock.calls[1][0];
    expect(retryCallArg).toContain("I will run the commands and paste the real output back to you");
    expect(retryCallArg).toContain("Output ONE self-contained ```bash block");
  });

  it("refusal-then-success retry yields content with the REFUSAL separator between attempts (JSON)", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    const classifySpy = vi.spyOn(core, "classifyTurnResponse")
      .mockResolvedValueOnce("REFUSAL")
      .mockResolvedValue("DELIVERABLE");

    const refusalText = "I can't access the files in this session.";
    const successText = "STATUS: PASS\nAll tests green.";

    const runSpy = vi.spyOn(core.ModelSession.prototype, "run")
      .mockResolvedValueOnce({
        [Symbol.asyncIterator]: async function* () {},
        fullText: refusalText,
        hasContent: true,
        throttle: { current: 1, max: 600 },
        scores: null,
        turnCount: 1,
      } as any)
      .mockResolvedValue({
        [Symbol.asyncIterator]: async function* () {},
        fullText: successText,
        hasContent: true,
        throttle: { current: 1, max: 600 },
        scores: null,
        turnCount: 1,
      } as any);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Check the files" }],
      tools: [
        {
          type: "function" as const,
          function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
        },
      ],
      stream: false,
    };

    const response = await handleChatCompletion(body, pool);

    expect(response.status).toBe(200);
    const json = (await response.json()) as any;
    const content: string = json.choices[0].message.content;
    const separator = "\n\n--- REFUSAL DETECTED - RETRY 1/3 ---\n\n";
    expect(content).toContain(separator);
    expect(content.indexOf(refusalText)).toBeLessThan(content.indexOf(separator));
    expect(content.indexOf(separator)).toBeLessThan(content.indexOf(successText));
    expect(content).toBe(`${refusalText}${separator}${successText}`);
    // Initial turn + 1 retry.
    expect(runSpy).toHaveBeenCalledTimes(2);
    expect(classifySpy).toHaveBeenCalled();
  });

  it("refusal-then-success retry streams the REFUSAL separator at the boundary (SSE)", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    vi.spyOn(core, "classifyTurnResponse")
      .mockResolvedValueOnce("REFUSAL")
      .mockResolvedValue("DELIVERABLE");

    const refusalText = "I can't access the files in this session.";
    const successText = "STATUS: PASS\nAll tests green.";
    const stream = (text: string) => ({
      async *[Symbol.asyncIterator]() { yield text; },
      fullText: text,
      hasContent: true,
      images: [],
      throttle: { current: 1, max: 600 },
      contentOrigin: "DeepLeo",
      scores: null,
      turnCount: 1,
    } as any);

    const runSpy = vi.spyOn(core.ModelSession.prototype, "run")
      .mockResolvedValueOnce(stream(refusalText))
      .mockResolvedValue(stream(successText));

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Check the files" }],
      tools: [
        {
          type: "function" as const,
          function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
        },
      ],
      stream: true,
    };

    const response = await handleChatCompletion(body, pool);
    expect(response.status).toBe(200);

    const raw = await response.text();
    let contents = "";
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      const chunk = JSON.parse(payload);
      const delta = chunk.choices?.[0]?.delta;
      if (delta && typeof delta.content === "string") contents += delta.content;
    }

    const separator = "\n\n--- REFUSAL DETECTED - RETRY 1/3 ---\n\n";
    expect(contents).toBe(`${refusalText}${separator}${successText}`);
    // The streamed refusal is not duplicated by the end-of-turn remainder.
    expect(contents.match(/I can't access the files/g)?.length).toBe(1);
    expect(runSpy).toHaveBeenCalledTimes(2);
  });
});

describe("Priority FIFO Turn Gatekeeper", () => {
  let origSpacing: string | undefined;

  beforeEach(() => {
    origSpacing = process.env.M365_MIN_TURN_SPACING_MS;
    delete process.env.M365_MIN_TURN_SPACING_MS; // default to 1500ms
    resetTurnVelocityPacing();
    resetTurnQueue();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (origSpacing !== undefined) {
      process.env.M365_MIN_TURN_SPACING_MS = origSpacing;
    } else {
      delete process.env.M365_MIN_TURN_SPACING_MS;
    }
  });

  it("enforces Priority FIFO ordering: priority retry jumps ahead of un-dispatched normal turns", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      const order: string[] = [];

      // Turn 1: initial turn, dispatches immediately
      const p1 = paceTurnVelocity().then(() => order.push("turn1_normal"));
      await p1;
      expect(order).toEqual(["turn1_normal"]);

      // Turn 2: queued normal turn (needs 1500ms spacing)
      const p2 = paceTurnVelocity(undefined, { priority: false }).then(() => order.push("turn2_normal"));
      // Turn 3: another queued normal turn
      const p3 = paceTurnVelocity(undefined, { priority: false }).then(() => order.push("turn3_normal"));

      // Turn 4: priority retry (forcing retry) -> jumps ahead of turn 3 (and behind in-flight turn 2)
      const p4 = paceTurnVelocity(undefined, { priority: true }).then(() => order.push("turn4_priority"));

      // Advance 1500ms: turn 2 (in-flight at head) finishes
      now += 1500;
      await vi.advanceTimersByTimeAsync(1500);
      expect(order).toEqual(["turn1_normal", "turn2_normal"]);

      // Advance 1500ms: turn 4 (priority) must resolve BEFORE turn 3!
      now += 1500;
      await vi.advanceTimersByTimeAsync(1500);
      expect(order).toEqual(["turn1_normal", "turn2_normal", "turn4_priority"]);

      // Advance 1500ms: turn 3 resolves last
      now += 1500;
      await vi.advanceTimersByTimeAsync(1500);
      expect(order).toEqual(["turn1_normal", "turn2_normal", "turn4_priority", "turn3_normal"]);

      await Promise.all([p1, p2, p3, p4]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maintains FIFO ordering among multiple priority retries ahead of normal turns", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      const order: string[] = [];

      // Turn 1: active at head
      const p1 = paceTurnVelocity().then(() => order.push("t1"));
      await p1;

      // Normal turns queued
      const pNorm1 = paceTurnVelocity(undefined, { priority: false }).then(() => order.push("normal1"));
      const pNorm2 = paceTurnVelocity(undefined, { priority: false }).then(() => order.push("normal2"));

      // Two priority turns queued: prio1 then prio2
      const pPrio1 = paceTurnVelocity(undefined, { priority: true }).then(() => order.push("prio1"));
      const pPrio2 = paceTurnVelocity(undefined, { priority: true }).then(() => order.push("prio2"));

      // Advance t1 spacing: normal1 finishes (was active)
      now += 1500;
      await vi.advanceTimersByTimeAsync(1500);
      expect(order).toEqual(["t1", "normal1"]);

      // Next must be prio1
      now += 1500;
      await vi.advanceTimersByTimeAsync(1500);
      expect(order).toEqual(["t1", "normal1", "prio1"]);

      // Next must be prio2
      now += 1500;
      await vi.advanceTimersByTimeAsync(1500);
      expect(order).toEqual(["t1", "normal1", "prio1", "prio2"]);

      // Finally normal2
      now += 1500;
      await vi.advanceTimersByTimeAsync(1500);
      expect(order).toEqual(["t1", "normal1", "prio1", "prio2", "normal2"]);

      await Promise.all([p1, pNorm1, pNorm2, pPrio1, pPrio2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces live recalculation: concurrent turns serialize and respect minimum turn spacing", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      const timestamps: number[] = [];
      const p1 = paceTurnVelocity().then(() => timestamps.push(now));
      const p2 = paceTurnVelocity().then(() => timestamps.push(now));
      const p3 = paceTurnVelocity().then(() => timestamps.push(now));

      await p1;
      expect(timestamps).toEqual([10_000]);

      now += 1500;
      await vi.advanceTimersByTimeAsync(1500);
      expect(timestamps).toEqual([10_000, 11_500]);

      now += 1500;
      await vi.advanceTimersByTimeAsync(1500);
      expect(timestamps).toEqual([10_000, 11_500, 13_000]);

      await Promise.all([p1, p2, p3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles abort signal in queue cleanly without deadlocking subsequent turns", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      const events: string[] = [];

      const p1 = paceTurnVelocity().then(() => events.push("p1_done"));
      await p1;
      expect(events).toEqual(["p1_done"]);

      const ac2 = new AbortController();
      const p2 = paceTurnVelocity(ac2.signal).then(
        () => events.push("p2_done"),
        (err) => events.push(`p2_aborted:${err.message}`),
      );

      const p3 = paceTurnVelocity().then(() => events.push("p3_done"));

      // Abort p2 while it is waiting in queue
      ac2.abort();
      await p2;
      expect(events).toContain("p2_aborted:Aborted while waiting in turn velocity queue");

      // Advance timer for p3 to dispatch
      now += 1500;
      await vi.advanceTimersByTimeAsync(1500);
      expect(events).toContain("p3_done");

      await Promise.all([p1, p2, p3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects immediately if signal is already aborted when calling paceTurnVelocity", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(paceTurnVelocity(ac.signal)).rejects.toThrow("Aborted while waiting in turn velocity queue");
  });
});

describe("hasPostFenceContamination (post-fence abort guard)", () => {
  const guardSpecs = core.buildSpecMap([
    { type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
    { type: "function", function: { name: "write_file", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } } },
  ] as any);

  it("does not flag a clean single call", () => {
    expect(hasPostFenceContamination("I'll inspect it.\n\n```bash\npwd && ls -la .\n```\n")).toBe(false);
  });

  it("does not flag a result-opener string INSIDE a call body", () => {
    expect(hasPostFenceContamination("```bash\ngrep -n '<tool_output' src/*.ts\n```\n")).toBe(false);
  });

  it("flags a self-authored result opener after the fence", () => {
    expect(hasPostFenceContamination("```bash\npwd\n```\n\n<tool_output>\n/home/x\n</tool_output>\n")).toBe(true);
  });

  it("flags a self-authored <assistant> role tag (simulated transcript)", () => {
    expect(hasPostFenceContamination("```bash\npwd\n```\n\n<assistant>\nnext turn\n")).toBe(true);
  });

  it("flags non-whitespace continuation after the closing fence", () => {
    expect(hasPostFenceContamination("```bash\npwd\n```\nGood, now I know the directory.\n")).toBe(true);
  });

  it("flags a SECOND tool-call fence (we run at most one)", () => {
    expect(hasPostFenceContamination("```bash\nls\n```\n\n```bash\ncat x\n```\n")).toBe(true);
  });

  it("does NOT flag a bash heredoc writing a file that contains a code fence", () => {
    const text = "```bash\ncat > /tmp/r.md <<'EOF'\n# Report\n\n```ts\np = 1\n```\nEOF\n```\n";
    expect(hasPostFenceContamination(text)).toBe(false);
  });

  it("does NOT flag a ```<tool> line inside a fence body (opaque body)", () => {
    expect(hasPostFenceContamination("```bash\ncat > f <<'EOF'\n```bash\nnpm start\n```\nEOF\n```\n")).toBe(false);
  });

  it("does NOT flag a ``` inside a quoted shell argument (data, not a glued closing fence)", () => {
    // Regression (2026-10-12 19:07:43Z, cid c3f86119): the model verified a report with
    // `grep -q '```suggestion' "$OUT"`. Pass 2 of restoreM365Fences split the quoted
    // backticks out as M365's glued closing fence, so the guard saw a spurious close
    // followed by `suggestion' "$OUT"` and aborted a legitimate verification turn.
    const text = [
      "I'll verify the complete artefact before finalising.",
      "```bash",
      "OUT=/tmp/report.md",
      "grep -q '```suggestion' \"$OUT\"",
      "printf 'ok\\n'",
      "```",
    ].join("\n");
    expect(hasPostFenceContamination(text, guardSpecs)).toBe(false);
  });

  it("does NOT flag a write body containing a nested code fence (all tools)", () => {
    const text = [
      "```write_file",
      "path: result.md",
      "",
      "# QA Result",
      "",
      "Actual file content:",
      "",
      "```python",
      "class AuditableModel(models.Model):",
      "    class Meta:",
      "        abstract = True",
      "```",
      "",
      "## MORE CONTENT AFTER THE PYTHON BLOCK",
      "This should be preserved.",
      "```",
      "",
    ].join("\n");
    expect(hasPostFenceContamination(text, guardSpecs)).toBe(false);
  });

  // Regression (2026-10-17): same class as above but the embedded block opens with a
  // BARE ``` (no language). The guard mistook that opener for the tool call's closer
  // and aborted the turn mid-write, truncating the file.
  it("does NOT flag a write body whose nested code fence opens BARE (no language)", () => {
    const text = [
      "```write_file",
      "path: result.md",
      "",
      "# Result",
      "",
      "Programmatic diff run inside the fixtures directory:",
      "",
      "```",
      "a111 -> b222: NetworkSNR 10.5 -> 11.0",
      "```",
      "",
      "## MORE CONTENT AFTER THE BARE BLOCK",
      "This should be preserved.",
      "```",
      "",
    ].join("\n");
    expect(hasPostFenceContamination(text, guardSpecs)).toBe(false);
  });

  // Regression (2026-10-17 live, freebsd K-8 task-2, cid 95e5e391): the guard runs on the
  // GROWING buffer after every streamed delta, NOT on the finished message. A `write` body
  // that embeds a bare ``` block makes the guard see the opener while its matching closer has
  // not arrived yet — full-text lookahead cannot help mid-stream. The guard mistook the opener
  // for the tool close and aborted on the first content line of the block, truncating the file
  // (the model then re-wrote it, which read as "forgetting" its own write). The full-text test
  // above passes; only this prefix-by-prefix sweep catches the real defect.
  it("never fires at ANY streamed prefix of a write body containing a bare fenced block", () => {
    const text = [
      "I'll write the deliverable now.",
      "",
      "```write_file",
      "path: result.md",
      "",
      "# Result",
      "",
      "`git diff --stat` in the worktree:",
      "",
      "```",
      " M sys/kern/kern_hibernate.c | 415 ++++-",
      "```",
      "",
      "## MORE CONTENT AFTER THE BARE BLOCK",
      "This must be preserved.",
      "```",
      "",
    ].join("\n");

    const lines = text.split("\n");
    let acc = "";
    for (let i = 0; i < lines.length; i++) {
      acc += (i > 0 ? "\n" : "") + lines[i];
      expect(
        hasPostFenceContamination(acc, guardSpecs),
        `guard fired mid-stream at line ${i}: ${JSON.stringify(lines[i])}`,
      ).toBe(false);
    }
  });

  it("does NOT flag a non-tool code fence (```c) followed by prose — only tool fences are calls", () => {
    // Regression: the model wrote a prose analysis containing a ```c block (no call).
    // The guard's own-line regex matched ANY fence, latched onto the ```c as the
    // "call", then aborted the prose after it (log 2026-10-11, ownline-lang:c).
    const text = [
      "Now I have a clear picture of the code. The inner loop is:",
      "```c",
      "while ((m = TAILQ_FIRST(&fl[oind].pl)) != NULL) {",
      "```",
      "When the loop finishes, the barrier is armed.",
    ].join("\n");
    expect(hasPostFenceContamination(text, guardSpecs)).toBe(false);
  });

  it("does NOT flag a bare ``` fence followed by prose", () => {
    const text = ["A note:", "```", "plain text block", "```", "more prose"].join("\n");
    expect(hasPostFenceContamination(text, guardSpecs)).toBe(false);
  });

  it("does not flag prose before the fence", () => {
    expect(hasPostFenceContamination("Let me ground myself first.\n\n```bash\npwd\n```")).toBe(false);
  });

  it("does not flag a heredoc write whose body contains a nested code fence when the opener is GLUED to prose", () => {
    // Regression: the model glued the opening fence to the prose line —
    // `...required path.```bash` — and wrote a heredoc whose body embeds a ```c
    // block. The guard's own-line opener regex missed the glued opener, latched
    // onto the INNER ```c block as the "tool fence", then flagged the content
    // after it as contamination and aborted a legitimate write (log 2026-10-12
    // 07:01:00Z, `result-security-audit-pr-27`).
    const text = [
      "I'll write the audit to the required path.```bash",
      "cat > /tmp/audit.md <<'EOF'",
      "# Audit",
      "",
      "```c",
      "if (x == 0) {",
      "```",
      "",
      "more content",
    ].join("\n");
    const specs = core.buildSpecMap([
      { type: "function" as const, function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } },
    ]);
    expect(hasPostFenceContamination(text, specs)).toBe(false);
  });

  it("does not flag a heredoc write whose body contains a nested code fence (own-line opener)", () => {
    const text = [
      "I'll write the audit to the required path.",
      "```bash",
      "cat > /tmp/audit.md <<'EOF'",
      "# Audit",
      "",
      "```c",
      "if (x == 0) {",
      "```",
      "",
      "more content",
    ].join("\n");
    expect(hasPostFenceContamination(text)).toBe(false);
  });
});

