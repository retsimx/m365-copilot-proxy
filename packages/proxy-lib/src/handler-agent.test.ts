import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleChatCompletion,
  SessionPool,
  resetNewSessionPacing,
  resetTurnVelocityPacing,
  HALLUCINATION_CORRECTION_PROMPT,
  HALLUCINATION_NO_CALL_CORRECTION_PROMPT,
} from "./handler.js";
import * as core from "@m365-copilot/core";

// Minimal fake CopilotStream: yields one text delta + the fields the handler reads.
function stream(text: string, turnCount = 1) {
  return {
    async *[Symbol.asyncIterator]() {
      yield text;
    },
    hasContent: true,
    fullText: text,
    images: [],
    isThrottled: false,
    messageType: undefined,
    contentOrigin: "DeepLeo" as const,
    scores: {},
    turnCount,
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

const body = (model: string, messages: any[]) => ({ model, messages, stream: false, tools: [bashTool] });

describe("agent path: framing selection, one call per turn, hallucination correction", () => {
  let captured: string[] = [];

  beforeEach(() => {
    captured = [];
    process.env.M365_NEW_SESSION_SPACING_MS = "0";
    process.env.M365_SESSION_BUCKET_CAPACITY = "0";
    resetNewSessionPacing();
    resetTurnVelocityPacing();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.M365_NEW_SESSION_SPACING_MS;
    delete process.env.M365_SESSION_BUCKET_CAPACITY;
    vi.restoreAllMocks();
  });

  it("Claude model gets the agent framing (exec-agent opener + one-call + anti-fabrication)", async () => {
    vi.spyOn(core.ModelSession.prototype, "run").mockImplementation(async (t: string) => {
      captured.push(t);
      return stream("```bash\npwd\n```");
    });
    const pool = new SessionPool();
    await handleChatCompletion(body("claude-sonnet-5.5", [{ role: "user", content: "go" }]) as any, pool);
    expect(captured[0]).toContain("You are an execution agent working toward the user's whole objective");
    expect(captured[0]).toContain("Emit exactly ONE tool-call fence per turn");
    expect(captured[0]).toContain("YOU KNOW NOTHING ABOUT THE USER'S MACHINE UNTIL THE HARNESS SHOWS IT TO YOU");
  });

  it("GPT model still gets the advisor framing (unchanged)", async () => {
    vi.spyOn(core.ModelSession.prototype, "run").mockImplementation(async (t: string) => {
      captured.push(t);
      return stream("```bash\npwd\n```");
    });
    const pool = new SessionPool();
    await handleChatCompletion(body("gpt-5.6-think-deeper", [{ role: "user", content: "go" }]) as any, pool);
    expect(captured[0]).toContain("You are a chat assistant helping with shell tasks");
    expect(captured[0]).not.toContain("You are an execution agent working toward");
  });

  it("keeps only the first tool call — on BOTH paths", async () => {
    vi.spyOn(core.ModelSession.prototype, "run").mockImplementation(async (t: string) => {
      captured.push(t);
      return stream("```bash\nls\n```\n\n```bash\ncat x\n```");
    });
    for (const model of ["claude-sonnet-5.5", "gpt-5.6-think-deeper"]) {
      const pool = new SessionPool();
      const res = await handleChatCompletion(body(model, [{ role: "user", content: "go" }]) as any, pool);
      const json: any = await res.json();
      expect(json.choices[0].message.tool_calls.length).toBe(1);
    }
  });

  // NOTE: the two-turn "correction is prepended on the next turn" behaviour is driven
  // by session.turnCount advancing, which the mocked ModelSession.run bypasses (the
  // counter lives on the inner CopilotSession). It is covered by the exported constants
  // below + the live log ("will attach a correction before the real results").
  it("exports the hallucination-correction prompts (fabrication + pure-transcript)", () => {
    expect(HALLUCINATION_CORRECTION_PROMPT).toContain("fabricated tool output");
    expect(HALLUCINATION_CORRECTION_PROMPT).toContain("NEVER author, predict, continue, or simulate a `<tool_output>` block");
    expect(HALLUCINATION_NO_CALL_CORRECTION_PROMPT).toContain("NO valid executable call");
  });
});
