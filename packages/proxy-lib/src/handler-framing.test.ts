import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleChatCompletion,
  SessionPool,
  resetNewSessionPacing,
  resetTurnVelocityPacing,
  ADVISOR_CONFAB_FORCE_PROMPT,
  CONFAB_FORCE_PROMPT,
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

describe("forcing retry prompts for advisor vs baseline tones", () => {
  let captured: string[] = [];

  beforeEach(() => {
    captured = [];
    process.env.M365_NEW_SESSION_SPACING_MS = "0";
    process.env.M365_SESSION_BUCKET_CAPACITY = "0";
    resetNewSessionPacing();
    resetTurnVelocityPacing();
    vi.restoreAllMocks();
    delete process.env.M365_FRAMING_VARIANT;
    delete process.env.M365_FRAMING_FILE;
    delete process.env.M365_ADVISOR_TONES;
    delete process.env.M365_ADVISOR_FRAMING;
  });

  afterEach(() => {
    delete process.env.M365_NEW_SESSION_SPACING_MS;
    delete process.env.M365_SESSION_BUCKET_CAPACITY;
    vi.restoreAllMocks();
  });

  it("uses advisor framing and ADVISOR_CONFAB_FORCE_PROMPT when an advisor tone (gpt-5.6-think-deeper) refuses on turn 0", async () => {
    let callCount = 0;
    vi.spyOn(core.ModelSession.prototype, "run").mockImplementation(async (text: string) => {
      captured.push(text);
      callCount++;
      if (callCount === 1) {
        return {
          async *[Symbol.asyncIterator]() {
            yield "I cannot access files or run shell commands in this environment. Please paste the file contents.";
          },
          hasContent: true,
          fullText: "I cannot access files or run shell commands in this environment. Please paste the file contents.",
          images: [],
          isThrottled: false,
          messageType: undefined,
          contentOrigin: "DeepLeo" as const,
          scores: {},
          turnCount: 1,
          throttle: null,
        } as any;
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield "```bash\nls -la\n```";
        },
        hasContent: true,
        fullText: "```bash\nls -la\n```",
        images: [],
        isThrottled: false,
        messageType: undefined,
        contentOrigin: "DeepLeo" as const,
        scores: {},
        turnCount: 2,
        throttle: null,
      } as any;
    });

    const pool = new SessionPool();
    const res = await handleChatCompletion(bodyFor("gpt-5.6-think-deeper") as any, pool);
    expect(res.status).toBe(200);
    expect(captured.length).toBe(2);

    const retryPrompt = captured[1];
    expect(retryPrompt).toContain(ADVISOR_CONFAB_FORCE_PROMPT);
    expect(retryPrompt).toContain("You write the shell commands; I run them");
    expect(retryPrompt).not.toContain("execution core");
    expect(retryPrompt).not.toContain("TOOL USE IS REQUIRED");
    expect(retryPrompt).not.toContain(CONFAB_FORCE_PROMPT);
  });

  it("uses advisor framing and ADVISOR_CONFAB_FORCE_PROMPT when gpt-6-astra refuses on turn 0", async () => {
    let callCount = 0;
    vi.spyOn(core.ModelSession.prototype, "run").mockImplementation(async (text: string) => {
      captured.push(text);
      callCount++;
      if (callCount === 1) {
        return {
          async *[Symbol.asyncIterator]() {
            yield "I don't have access to tools or files in this conversation. Please paste the code.";
          },
          hasContent: true,
          fullText: "I don't have access to tools or files in this conversation. Please paste the code.",
          images: [],
          isThrottled: false,
          messageType: undefined,
          contentOrigin: "DeepLeo" as const,
          scores: {},
          turnCount: 1,
          throttle: null,
        } as any;
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield "```bash\ncat config.json\n```";
        },
        hasContent: true,
        fullText: "```bash\ncat config.json\n```",
        images: [],
        isThrottled: false,
        messageType: undefined,
        contentOrigin: "DeepLeo" as const,
        scores: {},
        turnCount: 2,
        throttle: null,
      } as any;
    });

    const pool = new SessionPool();
    const res = await handleChatCompletion(bodyFor("gpt-6-astra") as any, pool);
    expect(res.status).toBe(200);
    expect(captured.length).toBe(2);

    const retryPrompt = captured[1];
    expect(retryPrompt).toContain(ADVISOR_CONFAB_FORCE_PROMPT);
    expect(retryPrompt).toContain("You write the shell commands; I run them");
    expect(retryPrompt).not.toContain("execution core");
    expect(retryPrompt).not.toContain("TOOL USE IS REQUIRED");
    expect(retryPrompt).not.toContain(CONFAB_FORCE_PROMPT);
  });

  it("uses baseline framing and CONFAB_FORCE_PROMPT when a non-advisor tone (gpt-5.5-think-deeper) refuses on turn 0", async () => {
    let callCount = 0;
    vi.spyOn(core.ModelSession.prototype, "run").mockImplementation(async (text: string) => {
      captured.push(text);
      callCount++;
      if (callCount === 1) {
        return {
          async *[Symbol.asyncIterator]() {
            yield "I cannot access files or run shell commands in this environment.";
          },
          hasContent: true,
          fullText: "I cannot access files or run shell commands in this environment.",
          images: [],
          isThrottled: false,
          messageType: undefined,
          contentOrigin: "DeepLeo" as const,
          scores: {},
          turnCount: 1,
          throttle: null,
        } as any;
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield "```bash\nls -la\n```";
        },
        hasContent: true,
        fullText: "```bash\nls -la\n```",
        images: [],
        isThrottled: false,
        messageType: undefined,
        contentOrigin: "DeepLeo" as const,
        scores: {},
        turnCount: 2,
        throttle: null,
      } as any;
    });

    const pool = new SessionPool();
    const res = await handleChatCompletion(bodyFor("gpt-5.5-think-deeper") as any, pool);
    expect(res.status).toBe(200);
    expect(captured.length).toBe(2);

    const retryPrompt = captured[1];
    expect(retryPrompt).toContain(CONFAB_FORCE_PROMPT);
    expect(retryPrompt).toContain("execution core");
    expect(retryPrompt).toContain("TOOL USE IS REQUIRED");
    expect(retryPrompt).not.toContain(ADVISOR_CONFAB_FORCE_PROMPT);
    expect(retryPrompt).not.toContain("You write the shell commands; I run them");
  });
});
