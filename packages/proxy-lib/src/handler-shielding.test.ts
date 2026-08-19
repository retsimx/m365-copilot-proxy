import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleChatCompletion, SessionPool } from "./handler.js";
import * as core from "@m365-copilot/core";

describe("Handler Degradation Circuit Breaker & 429 Retry-After Shielding", () => {
  beforeEach(() => {
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
  });

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
});
