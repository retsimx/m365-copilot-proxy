import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleChatCompletion,
  SessionPool,
  paceNewSessionStart,
  resetNewSessionPacing,
  paceTurnVelocity,
  resetTurnVelocityPacing,
  resetTurnQueue,
  TRUNCATION_SURRENDER_FORCE_PROMPT,
} from "./handler.js";
import * as core from "@m365-copilot/core";

describe("Handler Degradation Circuit Breaker & 429 Retry-After Shielding", () => {
  beforeEach(() => {
    resetNewSessionPacing();
    resetTurnVelocityPacing();
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

  it("respects custom M365_USER_THROTTLE_COOLDOWN_SEC environment variable when PerUserThrottled", async () => {
    const origUserCooldown = process.env.M365_USER_THROTTLE_COOLDOWN_SEC;
    try {
      process.env.M365_USER_THROTTLE_COOLDOWN_SEC = "2400";
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
        process.env.M365_USER_THROTTLE_COOLDOWN_SEC = origUserCooldown;
      } else {
        delete process.env.M365_USER_THROTTLE_COOLDOWN_SEC;
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


describe("Sliding-Window Velocity Governor (paceTurnVelocity)", () => {
  let origSpacing: string | undefined;
  beforeEach(() => {
    origSpacing = process.env.M365_MIN_TURN_SPACING_MS;
    process.env.M365_MIN_TURN_SPACING_MS = "0";
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

  it("resolves immediately with 0ms delay for turns 1 to 29", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    for (let i = 1; i <= 29; i++) {
      const delay = await paceTurnVelocity();
      expect(delay).toBe(0);
      now += 1000;
    }
  });

  it("enforces soft elastic spacing (3s, 6s, 9s, 12s, 15s) for turns 30 to 34", async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      // Execute 30 turns to populate the burst window up to burstSoft (30)
      for (let i = 1; i <= 30; i++) {
        const delay = await paceTurnVelocity();
        expect(delay).toBe(0);
        now += 1000;
      }

      // Turns with burstCount 30..34 receive progressive soft spacing:
      // excess * 3000ms -> 3s, 6s, 9s, 12s, 15s
      const expectedDelays = [3000, 6000, 9000, 12000, 15000];
      for (const expectedDelay of expectedDelays) {
        const p = paceTurnVelocity();
        let resolved = false;
        p.then(() => {
          resolved = true;
        });
        expect(resolved).toBe(false);

        now += expectedDelay;
        await vi.advanceTimersByTimeAsync(expectedDelay);

        const delay = await p;
        expect(resolved).toBe(true);
        expect(delay).toBe(expectedDelay);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("incurs burst drain delay on turn 35", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      // Run 30 turns with 0 delay (t = 10_000, 11_000, ..., 39_000)
      for (let i = 1; i <= 30; i++) {
        const delay = await paceTurnVelocity();
        expect(delay).toBe(0);
        now += 1000;
      }

      // Run 5 turns with soft spacing (burstCount 30..34)
      for (let count = 30; count <= 34; count++) {
        const spacing = (count - 30 + 1) * 3000;
        const p = paceTurnVelocity();
        now += spacing;
        await vi.advanceTimersByTimeAsync(spacing);
        await p;
      }

      // Now burstCount === 35 (burstMax is 35)
      // oldestBurst is at t = 10_000
      // burstWindowMs = 600_000
      // drainDelay = (10_000 + 600_000) - now
      const oldestBurst = 10_000;
      const expectedDrainDelay = Math.max(1000, (oldestBurst + 600_000) - now);

      const p35 = paceTurnVelocity();
      let p35Resolved = false;
      p35.then(() => {
        p35Resolved = true;
      });
      expect(p35Resolved).toBe(false);

      now += expectedDrainDelay;
      await vi.advanceTimersByTimeAsync(expectedDrainDelay);

      const delay35 = await p35;
      expect(p35Resolved).toBe(true);
      expect(delay35).toBe(expectedDrainDelay);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies graduated resistance (5s..25s) when 60m count reaches 90 turns", async () => {
    vi.useFakeTimers();
    try {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      // Space 89 turns by 21s across ~31 minutes
      // In any 10-minute window (600s), there are at most 28 turns (< 30 burstSoft), so all resolve with 0ms
      for (let i = 0; i < 89; i++) {
        now = 1_000_000 + i * 21_000;
        const delay = await paceTurnVelocity();
        expect(delay).toBe(0);
      }

      // Advance by 650s: all 89 prior turns are now older than the 10m burst window (> 600s),
      // but well within the 60m sustained window (< 3600s)
      now += 650_000;

      // Turn brings sustainedCount from 89 to 90
      const delay89 = await paceTurnVelocity();
      expect(delay89).toBe(0);

      // Now sustainedCount is 90!
      // Progress = (90 - 90 + 1) / (120 - 90) = 1 / 30
      // Expected delay: Math.round(5000 + (1 / 30) * 20000) = 5667 ms
      const expectedDelay90 = Math.round(5000 + (1 / 30) * 20000);
      expect(expectedDelay90).toBe(5667);
      expect(expectedDelay90).toBeGreaterThanOrEqual(5000);
      expect(expectedDelay90).toBeLessThanOrEqual(25000);

      const p90 = paceTurnVelocity();
      let p90Resolved = false;
      p90.then(() => {
        p90Resolved = true;
      });
      expect(p90Resolved).toBe(false);

      now += expectedDelay90;
      await vi.advanceTimersByTimeAsync(expectedDelay90);

      const delay90 = await p90;
      expect(p90Resolved).toBe(true);
      expect(delay90).toBe(expectedDelay90);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts and rejects when signal is cancelled while in pacing wait", async () => {
    vi.useFakeTimers();
    try {
      let now = 10_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);

      // Run 30 turns so the next call triggers soft spacing
      for (let i = 1; i <= 30; i++) {
        await paceTurnVelocity();
        now += 1000;
      }

      const ac = new AbortController();
      const p = paceTurnVelocity(ac.signal);

      ac.abort();
      await expect(p).rejects.toThrow("Aborted while waiting in turn velocity queue");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetTurnVelocityPacing resets state and clears history", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);

    for (let i = 1; i <= 30; i++) {
      const delay = await paceTurnVelocity();
      expect(delay).toBe(0);
      now += 1000;
    }

    resetTurnVelocityPacing();

    const delay = await paceTurnVelocity();
    expect(delay).toBe(0);
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

  it("attempts confabulation retries with CONFAB_FORCE_PROMPT and fails closed with HTTP 502 when refusal persists (Refusal Retry & Fail-Closed)", async () => {
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

    expect(response.status).toBe(502);
    const json = (await response.json()) as any;
    expect(json.error).toBeDefined();
    expect(json.error.type).toBe("unresolved_tool_refusal");
    expect(json.error.message).toContain("M365 persistently refused to invoke available tools");
    expect(json.error.message).toContain(refusalText);

    // Initial turn + 3 retries = 4 runs total
    expect(runSpy).toHaveBeenCalledTimes(4);
    // Verify that retries sent CONFAB_FORCE_PROMPT
    const retryCallArg = runSpy.mock.calls[1][0];
    expect(retryCallArg).toContain("Emit ONE fenced tool block this turn");
    expect(classifySpy).toHaveBeenCalledWith(refusalText);
  });

  it("triggers confabulation retries and fails closed if persistent when report claims tools are unavailable (Dual Check Defense-in-Depth)", async () => {
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

    expect(response.status).toBe(502);
    const json = (await response.json()) as any;
    expect(json.error).toBeDefined();
    expect(json.error.type).toBe("unresolved_tool_refusal");
    expect(json.error.message).toContain("M365 persistently refused to invoke available tools");
    expect(json.error.message).toContain(reportRefusal);

    // Initial turn + 3 retries = 4 runs total
    expect(runSpy).toHaveBeenCalledTimes(4);
    const retryCallArg = runSpy.mock.calls[1][0];
    expect(retryCallArg).toContain("Emit ONE fenced tool block this turn");
  });

  it("forces a retry with TRUNCATION_SURRENDER_FORCE_PROMPT on truncation surrender and fails closed with HTTP 502 if persistent", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);

    const surrenderText =
      "STATUS: FAIL\nOUTPUT_FILE: /tmp/results/result-audit.md\nSIZE_BYTES: 0\nSPECIFICS: The required report was not written or verified because the execution environment did not permit a further bash tool call after the initial inspection output was truncated.";

    const runSpy = vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {},
      fullText: surrenderText,
      hasContent: true,
      throttle: { current: 1, max: 600 },
      scores: null,
      turnCount: 1,
    } as any);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Run audit and write report" }],
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
    const json = (await response.json()) as any;
    expect(json.error).toBeDefined();
    expect(json.error.type).toBe("unresolved_tool_refusal");
    expect(json.error.message).toContain("M365 persistently refused to invoke available tools");
    expect(json.error.message).toContain(surrenderText);

    // Initial turn + 3 retries = 4 runs total
    expect(runSpy).toHaveBeenCalledTimes(4);
    // Verify that retries sent TRUNCATION_SURRENDER_FORCE_PROMPT
    const retryCallArg = runSpy.mock.calls[1][0];
    expect(retryCallArg).toContain(TRUNCATION_SURRENDER_FORCE_PROMPT);
    expect(retryCallArg).toContain("CORRECTION: The execution session has NOT ended");
  });

  it("forces a retry with TRUNCATION_SURRENDER_FORCE_PROMPT on truncation surrender and recovers when model emits a tool call", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);

    const surrenderText =
      "STATUS: FAIL\nOUTPUT_FILE: /tmp/out.txt\nCOMMAND: unavailable because the execution tool session ended after returning truncated inspection output\nERROR: no bash tool is available in the current turn to inspect the saved output and write or verify the required artifact";

    const toolCallText = "```bash\nhead -n 20 /tmp/out.txt\n```";

    const runSpy = vi.spyOn(core.ModelSession.prototype, "run")
      .mockResolvedValueOnce({
        [Symbol.asyncIterator]: async function* () {},
        fullText: surrenderText,
        hasContent: true,
        throttle: { current: 1, max: 600 },
        scores: null,
        turnCount: 1,
      } as any)
      .mockResolvedValueOnce({
        [Symbol.asyncIterator]: async function* () {},
        fullText: toolCallText,
        hasContent: true,
        throttle: { current: 1, max: 600 },
        scores: null,
        turnCount: 2,
      } as any);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Inspect output" }],
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
    expect(json.choices[0].message.tool_calls).toBeDefined();
    expect(json.choices[0].message.tool_calls.length).toBe(1);
    expect(json.choices[0].message.tool_calls[0].function.name).toBe("bash");
    expect(json.choices[0].message.tool_calls[0].function.arguments).toContain("head -n 20 /tmp/out.txt");

    expect(runSpy).toHaveBeenCalledTimes(2);
    const retryCallArg = runSpy.mock.calls[1][0];
    expect(retryCallArg).toContain(TRUNCATION_SURRENDER_FORCE_PROMPT);
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

