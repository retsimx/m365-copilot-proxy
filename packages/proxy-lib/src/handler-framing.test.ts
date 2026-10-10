import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleChatCompletion,
  SessionPool,
  resetNewSessionPacing,
  resetTurnVelocityPacing,
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

const readFileTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

// Mixed toolset: the non-shell tool keeps the advisor <tools> block present, so
// these tests can assert advisor framing was injected (a shell-only set elides it).
function bodyFor(model: string) {
  return {
    model,
    messages: [{ role: "user" as const, content: "do a thing" }],
    stream: false,
    tools: [bashTool, readFileTool],
  };
}

describe("per-model framing selection (universal advisor framing)", () => {
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
    expect(prompt).toContain("You are a chat assistant helping with shell tasks, working toward the whole task stated in the user's request");
    expect(prompt).toContain("exactly one fenced block that calls the tool you need");
    expect(prompt).not.toContain("execution core");
    expect(prompt).not.toContain("TOOL USE IS REQUIRED");
    // non-shell tools still reach the model inside <tools>; the shell fence idiom
    // lives in the advisor prose
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("```bash");
  }

  it("gpt-6-astra → advisor framing", async () => {
    expectAdvisor(await promptFor("gpt-6-astra"));
  }, 30000);

  it("gpt-5.6-think-deeper → advisor framing", async () => {
    expectAdvisor(await promptFor("gpt-5.6-think-deeper"));
  }, 30000);

  it("gpt-5.5-think-deeper → advisor framing (universal standard)", async () => {
    expectAdvisor(await promptFor("gpt-5.5-think-deeper"));
  }, 30000);
});

describe("forcing retry prompts for all models (unified advisor force prompt)", () => {
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

  it("uses advisor framing and unified CONFAB_FORCE_PROMPT when gpt-5.6-think-deeper refuses on turn 0", async () => {
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
    expect(retryPrompt).toContain(CONFAB_FORCE_PROMPT);
    expect(retryPrompt).toContain("I will run the commands and paste the real output back to you");
    expect(retryPrompt).toContain("Output ONE self-contained ```bash block with the commands for me to run, nothing else.");
    expect(retryPrompt).toContain("You are a chat assistant helping with shell tasks, working toward the whole task stated in the user's request");
    expect(retryPrompt).not.toContain("execution core");
    expect(retryPrompt).not.toContain("TOOL USE IS REQUIRED");
  });

  it("uses advisor framing and unified CONFAB_FORCE_PROMPT when gpt-6-astra refuses on turn 0", async () => {
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
    expect(retryPrompt).toContain(CONFAB_FORCE_PROMPT);
    expect(retryPrompt).toContain("I will run the commands and paste the real output back to you");
    expect(retryPrompt).toContain("Output ONE self-contained ```bash block with the commands for me to run, nothing else.");
    expect(retryPrompt).toContain("You are a chat assistant helping with shell tasks, working toward the whole task stated in the user's request");
    expect(retryPrompt).not.toContain("execution core");
    expect(retryPrompt).not.toContain("TOOL USE IS REQUIRED");
  });

  it("uses advisor framing and unified CONFAB_FORCE_PROMPT when gpt-5.5-think-deeper refuses on turn 0", async () => {
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
    expect(retryPrompt).toContain("I will run the commands and paste the real output back to you");
    expect(retryPrompt).toContain("Output ONE self-contained ```bash block with the commands for me to run, nothing else.");
    expect(retryPrompt).toContain("You are a chat assistant helping with shell tasks, working toward the whole task stated in the user's request");
    expect(retryPrompt).not.toContain("execution core");
    expect(retryPrompt).not.toContain("TOOL USE IS REQUIRED");
  });
});

describe("delta tool re-injection (shell elision)", () => {
  let captured: string[] = [];

  beforeEach(() => {
    captured = [];
    process.env.M365_NEW_SESSION_SPACING_MS = "0";
    process.env.M365_SESSION_BUCKET_CAPACITY = "0";
    resetNewSessionPacing();
    resetTurnVelocityPacing();
    vi.restoreAllMocks();
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

  async function deltaPromptFor(tools: any[], toolContent = "ok"): Promise<string> {
    // Force the second request down the delta path (turn > 0 AND sentMessageCount > 0).
    vi.spyOn(core.ModelSession.prototype, "turnCount", "get").mockReturnValue(1);
    const pool = new SessionPool();
    const first = {
      model: "gpt-5.6-think-deeper",
      messages: [{ role: "user" as const, content: "do a thing" }],
      stream: false,
      tools,
    };
    const second = {
      model: "gpt-5.6-think-deeper",
      messages: [
        { role: "user" as const, content: "do a thing" },
        { role: "tool" as const, tool_call_id: "c1", name: "bash", content: toolContent },
      ],
      stream: false,
      tools,
    };
    const res1 = await handleChatCompletion(first as any, pool);
    expect(res1.status).toBeLessThan(400);
    const res2 = await handleChatCompletion(second as any, pool);
    expect(res2.status).toBeLessThan(400);
    return captured[captured.length - 1];
  }

  it("sends NO framing on a delta turn — just the named <tool_output> + <user>", async () => {
    const prompt = await deltaPromptFor([bashTool]);
    expect(prompt).not.toContain("do a thing"); // proves the delta path, not a full replay
    expect(prompt).not.toContain("You are a chat assistant helping with shell tasks, working toward the whole task stated in the user's request");
    expect(prompt).not.toContain("<tools>");
    expect(prompt).toContain('<tool_output name="bash"');
    expect(prompt).toContain("</tool_output>");
  });

  it("sends NO framing on a mixed delta turn either", async () => {
    const prompt = await deltaPromptFor([bashTool, readFileTool]);
    expect(prompt).not.toContain("do a thing"); // proves the delta path, not a full replay
    expect(prompt).not.toContain("You are a chat assistant helping with shell tasks, working toward the whole task stated in the user's request");
    expect(prompt).not.toContain("<tools>");
    expect(prompt).toContain('<tool_output name="bash"');
  });

  it("annotates an empty tool result so the model keeps going", async () => {
    const prompt = await deltaPromptFor([bashTool], "(no output)");
    expect(prompt).toContain('<tool_output name="bash" empty="true">');
    expect(prompt).toContain("A command that prints nothing is a normal result, not a failure");
  });

  it("annotates a truncated tool result with a fetch-the-rest instruction (incl. saved path)", async () => {
    const toolContent = "...output truncated...\nFull output saved to: /tmp/oc/out-1.txt";
    const prompt = await deltaPromptFor([bashTool], toolContent);
    expect(prompt).toContain('<tool_output name="bash" truncated="true">');
    expect(prompt).toContain("a size cap, NOT the end");
    expect(prompt).toContain("/tmp/oc/out-1.txt");
  });

  it("leaves a normal tool result unannotated", async () => {
    const prompt = await deltaPromptFor([bashTool]);
    expect(prompt).toContain('<tool_output name="bash">');
    expect(prompt).not.toContain('empty="true"');
    expect(prompt).not.toContain('truncated="true"');
  });
});

describe("M365 label-only opener regression (opening fence stripped from the stream)", () => {
  function streamOf(text: string) {
    return {
      async *[Symbol.asyncIterator]() { yield text; },
      hasContent: true,
      fullText: text,
      images: [], isThrottled: false, messageType: undefined,
      contentOrigin: "DeepLeo", scores: {}, turnCount: 1, throttle: null,
    } as any;
  }

  beforeEach(() => {
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

  it("emits a bash tool_call when M365 dropped the opening fence (bare `bash` label)", async () => {
    // Live shape from a 61sol turn (2026-10-09 06:39): the opening ``` never reaches
    // the streamed text, leaving `…bounded.\nbash\n<commands>\n``` `.
    const streamed = [
      "The first step is to inventory the inputs and read the grounding briefs. The commands below are read-only and keep output bounded.",
      "bash",
      "cd /home/lewis/Projects/cbc/cbcflow-portal || exit 1",
      "cat CONTEXT.md",
      "```",
    ].join("\n");
    vi.spyOn(core.ModelSession.prototype, "run").mockImplementation(async () => streamOf(streamed));

    const pool = new SessionPool();
    const res = await handleChatCompletion(
      { model: "gpt-5.6-think-deeper", messages: [{ role: "user", content: "collate the reviews" }], stream: false, tools: [bashTool] } as any,
      pool,
    );
    expect(res.status).toBe(200);
    const json: any = await res.json();
    const msg = json.choices[0].message;
    expect(msg.tool_calls?.[0]?.function.name).toBe("bash");
    expect(JSON.parse(msg.tool_calls[0].function.arguments).command).toContain("cat CONTEXT.md");
  });

  it("emits a bash tool_call when M365 glued the opening fence to the prose line", async () => {
    // Live shape from 2026-10-09 07:42 — the opener is appended to the prose line
    // with no newline: `…output limit.```bash`.
    const streamed = [
      "I'll first read the remediation brief in full, then inventory and size all required inputs so subsequent reads stay complete and within the output limit.```bash",
      "timeout: 30000",
      "cat /tmp/opencode/review/REMEDIATION-BRIEF.md",
      "```",
    ].join("\n");
    vi.spyOn(core.ModelSession.prototype, "run").mockImplementation(async () => streamOf(streamed));

    const pool = new SessionPool();
    const res = await handleChatCompletion(
      { model: "gpt-5.6-think-deeper", messages: [{ role: "user", content: "remediation" }], stream: false, tools: [bashTool] } as any,
      pool,
    );
    expect(res.status).toBe(200);
    const json: any = await res.json();
    const msg = json.choices[0].message;
    expect(msg.tool_calls?.[0]?.function.name).toBe("bash");
    expect(JSON.parse(msg.tool_calls[0].function.arguments).command).toContain("cat /tmp/opencode/review/REMEDIATION-BRIEF.md");
  });
});
