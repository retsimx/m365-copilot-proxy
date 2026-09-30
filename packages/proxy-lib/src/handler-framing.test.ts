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

describe("per-model framing selection (GPT refusal-prone tones)", () => {
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
    delete process.env.M365_ADVISOR_TONES;
    delete process.env.M365_ADVISOR_FRAMING;
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

  async function promptFor(model: string): Promise<string> {
    const pool = new SessionPool();
    const res = await handleChatCompletion(bodyFor(model) as any, pool);
    expect(res.status).toBeLessThan(400);
    expect(captured.length).toBeGreaterThan(0);
    return captured[0];
  }

  function expectAdvisor(prompt: string) {
    expect(prompt).toContain("You write the shell commands; I run them");
    expect(prompt).toContain("Do not make any tool calls");
    expect(prompt).not.toContain("execution core");
    expect(prompt).not.toContain("TOOL USE IS REQUIRED");
    // the tools still reach the model so the fence routes to the shell
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("```bash");
  }

  function expectBaseline(prompt: string) {
    expect(prompt).toContain("execution core");
    expect(prompt).toContain("TOOL USE IS REQUIRED");
    expect(prompt).not.toContain("Do not make any tool calls");
  }

  it("gpt-6-astra → advisor framing", async () => {
    expectAdvisor(await promptFor("gpt-6-astra"));
  }, 30000);

  it("gpt-5.6-think-deeper → advisor framing", async () => {
    expectAdvisor(await promptFor("gpt-5.6-think-deeper"));
  }, 30000);

  it("gpt-5.5-think-deeper → baseline framing (deliberately unchanged)", async () => {
    expectBaseline(await promptFor("gpt-5.5-think-deeper"));
  }, 30000);
});
