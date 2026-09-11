import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleChatCompletion, SessionPool, paceNewSessionStart, resetNewSessionPacing } from "./handler.js";
import * as core from "@m365-copilot/core";

describe("Handler Degradation Circuit Breaker & 429 Retry-After Shielding", () => {
  beforeEach(() => {
    resetNewSessionPacing();
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

  it("returns HTTP 429 with Retry-After when upstream returns empty response after retries", async () => {
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

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("90");
    const json = await response.json() as any;
    expect(json.error.type).toBe("rate_limit_error");
    expect(json.error.code).toBe("rate_limit_exceeded");
    expect(json.error.message).toContain("throttle 3/600");
    expect(json.error.message).toContain("90s");
  }, 15000);

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

  it("fails fast with HTTP 400 on M365 safety/content policy refusal without retrying", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);

    const runSpy = vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {},
      fullText: "Hmm...it looks like I can't chat about this. Let's try a different topic.",
      hasContent: true,
      throttle: { current: 1, max: 600 },
      scores: null,
      turnCount: 1,
    } as any);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Show me exploit vectors" }],
      tools: [
        {
          type: "function" as const,
          function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
        },
      ],
      stream: false,
    };

    const response = await handleChatCompletion(body, pool);

    expect(response.status).toBe(400);
    const json = await response.json() as any;
    expect(json.error).toBeDefined();
    expect(json.error.type).toBe("content_policy_refusal");
    expect(json.error.message).toContain("M365 content policy refusal");
    // Fails fast: exactly 1 call to run (no retries)
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("fails closed with HTTP 502 unresolved_tool_refusal when tool confabulation persists after retries", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);

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

    expect(response.status).toBe(502);
    const json = await response.json() as any;
    expect(json.error).toBeDefined();
    expect(json.error.type).toBe("unresolved_tool_refusal");
    expect(json.error.message).toContain("M365 persistently refused to invoke available tools");
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
    expect(json.error.message).toContain("600s remaining");

    // Fast-fail: exactly 1 attempt (no "Please continue." retries)
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalled();
    expect(triggerSpy).toHaveBeenCalledWith(600_000, "PerScenarioThrottled");
  });
});

describe("New Session Pacing Queue", () => {
  beforeEach(() => {
    resetNewSessionPacing();
    vi.restoreAllMocks();
  });

  it("paces sequential invocations by 15s and resolves cleanly", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

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

      await paceNewSessionStart(); // prime slot 1

      const ac = new AbortController();
      const p2 = paceNewSessionStart(ac.signal);

      ac.abort();
      await expect(p2).rejects.toThrow("Aborted while waiting in new session pacing queue");
    } finally {
      vi.useRealTimers();
    }
  });
});
