import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleChatCompletion,
  SessionPool,
  resetNewSessionPacing,
  resetTurnVelocityPacing,
} from "./handler.js";
import * as core from "@m365-copilot/core";

// A fake CopilotStream: async-iterable yielding one text delta, plus the fields the
// handler reads after the loop. Enough for a non-stream turn to return HTTP 200.
function fakeStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield "ok";
    },
    hasContent: true,
    fullText: "ok",
    images: [],
    isThrottled: false,
    messageType: undefined,
    contentOrigin: "DeepLeo" as const,
    scores: {},
    turnCount: 1,
    throttle: null,
  } as any;
}

const bashTool = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};

function bodyFor(model: string) {
  return {
    model,
    messages: [{ role: "user" as const, content: "do a thing" }],
    stream: false,
    tools: [bashTool],
  };
}

describe("per-model framing selection (GPT-6 Astra)", () => {
  let captured: string[] = [];

  beforeEach(() => {
    captured = [];
    // Disable session pacing so the integration test is deterministic/fast.
    process.env.M365_NEW_SESSION_SPACING_MS = "0";
    process.env.M365_SESSION_BUCKET_CAPACITY = "0";
    resetNewSessionPacing();
    resetTurnVelocityPacing();
    vi.restoreAllMocks();
    delete process.env.M365_FRAMING_VARIANT;
    delete process.env.M365_FRAMING_FILE;
    delete process.env.M365_ASTRA_FRAMING;
    vi.spyOn(core.ModelSession.prototype, "run").mockImplementation(async (text: string) => {
      captured.push(text);
      return fakeStream();
    });
  });

  afterEach(() => {
    delete process.env.M365_NEW_SESSION_SPACING_MS;
    delete process.env.M365_SESSION_BUCKET_CAPACITY;
    vi.restoreAllMocks();
  });

  it(
    "sends the advisor framing (not the agentic baseline) for gpt-6-astra",
    async () => {
      const pool = new SessionPool();
      const started = Date.now();
      const res = await handleChatCompletion(bodyFor("gpt-6-astra") as any, pool);
      const elapsed = Date.now() - started;
      expect(res.status, `status ${res.status} after ${elapsed}ms`).toBeLessThan(400);
      expect(captured.length).toBeGreaterThan(0);

      const prompt = captured[0];
      expect(prompt).toContain("chat assistant");
      expect(prompt).toContain("make no tool calls");
      expect(prompt).not.toContain("execution core");
      expect(prompt).not.toContain("TOOL USE IS REQUIRED");
      // the tools still reach the model so the fence routes to the shell
      expect(prompt).toContain("<tools>");
      expect(prompt).toContain("```bash");
    },
    30000,
  );

  it(
    "sends the baseline framing for gpt-5.6-think-deeper (control)",
    async () => {
      const pool = new SessionPool();
      const res = await handleChatCompletion(bodyFor("gpt-5.6-think-deeper") as any, pool);
      expect(res.status).toBeLessThan(400);
      expect(captured.length).toBeGreaterThan(0);

      const prompt = captured[0];
      expect(prompt).toContain("execution core");
      expect(prompt).toContain("TOOL USE IS REQUIRED");
      expect(prompt).not.toContain("make no tool calls");
    },
    30000,
  );
});
