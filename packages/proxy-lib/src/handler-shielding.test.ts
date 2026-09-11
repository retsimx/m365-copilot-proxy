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
  });
});
