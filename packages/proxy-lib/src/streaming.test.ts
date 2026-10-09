import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Replace core's ModelSession with a scripted fake so we can exercise the handler's
// streaming path with no auth/WebSocket. Everything else in core stays real, except
// `classifyTurnResponse` which we pin to avoid loading the local Gemma model.
const scripted: {
  deltas: string[];
  fullText?: string;
  reasoning?: string[];
  runCalls: number;
} = { deltas: [], runCalls: 0 };

const classify = { value: "DELIVERABLE" };

vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  class FakeModelSession {
    turnCount = 0;
    conversationId = "conv-test";
    reset() {}
    newConversation() { this.conversationId = "conv-test-2"; }
    async refreshAgent() { return false; }
    async run(...args: any[]) {
      scripted.runCalls++;
      const turnOptions = args[4] as { onReasoning?: (t: string) => void } | undefined;
      const deltas = scripted.deltas;
      const full = scripted.fullText ?? deltas.join("");
      const reasoning = scripted.reasoning ?? [];
      const stream = {
        fullText: full,
        hasContent: true,
        images: [],
        throttle: { current: 1, max: 600 },
        contentOrigin: "Claude",
        messageType: null as string | null,
        messageId: "m1",
        scores: null,
        turnCount: 1,
        turnState: "Completed",
        async *[Symbol.asyncIterator]() {
          // Reasoning steps arrive on the wire BEFORE the answer stream.
          for (const r of reasoning) {
            turnOptions?.onReasoning?.(r);
            await Promise.resolve(); // yield to the event loop between steps
          }
          for (const d of deltas) {
            await Promise.resolve(); // yield to the event loop between deltas
            yield d;
          }
        },
      };
      return stream;
    }
  }
  return {
    ...actual,
    ModelSession: FakeModelSession,
    classifyTurnResponse: async () => classify.value,
  };
});

const {
  handleChatCompletion,
  SessionPool,
  ChatCompletionRequest,
  resetNewSessionPacing,
  resetTurnVelocityPacing,
} = await import("./index.js");

const TOOLS = [
  {
    type: "function" as const,
    function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
  },
];

interface DeltaChunk {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{ index: number; id: string; type: string; function: { name: string; arguments: string } }>;
  finish_reason?: string | null;
}

/** Drive one streaming request and return the ordered delta chunks (role chunk excluded). */
async function streamChunks(
  deltas: string[],
  fullText: string | undefined,
  opts: { tools?: unknown[]; reasoning?: string[] } = {},
): Promise<DeltaChunk[]> {
  scripted.deltas = deltas;
  scripted.fullText = fullText;
  scripted.reasoning = opts.reasoning ?? [];
  const body = ChatCompletionRequest.parse({
    model: "m365-copilot",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
    ...(opts.tools ? { tools: opts.tools } : {}),
  });
  const res = await handleChatCompletion(body, new SessionPool());
  expect(res.status).toBe(200);
  const text = await res.text();

  const chunks: DeltaChunk[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    const chunk = JSON.parse(payload);
    const delta = chunk.choices?.[0]?.delta as DeltaChunk | undefined;
    if (delta) chunks.push({ ...delta, finish_reason: chunk.choices[0].finish_reason });
  }
  return chunks;
}

/** Content-only view, kept for the pre-existing non-tool tests. */
async function streamContents(deltas: string[], fullText?: string): Promise<string[]> {
  const chunks = await streamChunks(deltas, fullText);
  return chunks.map(c => c.content).filter((c): c is string => typeof c === "string" && c.length > 0);
}

const nonEmpty = (chunks: DeltaChunk[], key: "content" | "reasoning_content") =>
  chunks.filter((c): c is DeltaChunk & Record<typeof key, string> => typeof c[key] === "string" && (c[key] as string).length > 0);

beforeEach(() => {
  resetNewSessionPacing();
  resetTurnVelocityPacing();
  scripted.runCalls = 0;
  classify.value = "DELIVERABLE";
  delete process.env.M365_NO_TOOL_STREAM;
  delete process.env.M365_NO_REASONING_STREAM;
});

afterEach(() => {
  delete process.env.M365_NO_TOOL_STREAM;
  delete process.env.M365_NO_REASONING_STREAM;
});

describe("incremental streaming (non-tool path)", () => {
  it("forwards deltas as separate chunks, not one buffered blob", async () => {
    const contents = await streamContents(["Hello", ", ", "world", "!"]);
    // Genuinely incremental: each delta is its own chunk.
    expect(contents.length).toBeGreaterThan(1);
    // Lossless and in-order: reconstructs the full answer exactly once.
    expect(contents.join("")).toBe("Hello, world!");
  });

  it("emits the trailing remainder once when the final text outruns the delta stream", async () => {
    // Deltas cover a prefix ("Hello wor"); the authoritative full text is longer —
    // the renderer must send the "ld" tail exactly once, never re-send the prefix.
    const contents = await streamContents(["Hello ", "wor"], "Hello world");
    expect(contents.join("")).toBe("Hello world");
    // No duplicated prefix.
    expect(contents.join("").match(/Hello/g)?.length).toBe(1);
  });
});

describe("tool-path prose streaming (Track A, design §3.3)", () => {
  const fenceDeltas = ["Let me check.\n", "```bash\n", "ls -la\n", "```"];
  const fenceText = fenceDeltas.join("");

  it("streams prose before tool_calls; tool_calls emitted once and unfenced", async () => {
    const chunks = await streamChunks(fenceDeltas, fenceText, { tools: TOOLS });
    const contents = nonEmpty(chunks, "content").map(c => c.content);
    const toolChunks = chunks.filter(c => c.tool_calls);

    // Pre-fence prose streamed live; the fence body never reached the content channel.
    expect(contents.join("")).toBe("Let me check.\n");
    expect(contents.join("")).not.toContain("ls -la");

    // Exactly one tool_calls event, carrying the unfenced shell tool.
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0].tool_calls![0].function.name).toBe("bash");
    expect(toolChunks[0].tool_calls![0].function.arguments).toContain("ls -la");

    // Ordering: all content precedes the tool_calls event.
    const firstTool = chunks.findIndex(c => c.tool_calls);
    const lastContent = chunks.reduce((acc, c, i) => (typeof c.content === "string" && c.content.length > 0 ? i : acc), -1);
    expect(lastContent).toBeGreaterThanOrEqual(0);
    expect(lastContent).toBeLessThan(firstTool);

    // One wire turn — no retries.
    expect(scripted.runCalls).toBe(1);
  });

  it("commit guard skips the confab/hallucination retry once prose has streamed", async () => {
    // A hallucinated completion (no tool call) would normally force 3 retries. Once
    // the prose has streamed, commit-on-stream must leave `kind:"text"` as-is.
    const prose = ["I have created ", "the file config.json ", "with the updated settings."];
    const full = prose.join("");
    const chunks = await streamChunks(prose, full, { tools: TOOLS });
    const contents = nonEmpty(chunks, "content").map(c => c.content);

    expect(contents.join("")).toBe(full);
    // Exactly one run: the retry loop was short-circuited by the commit guard.
    expect(scripted.runCalls).toBe(1);
  });
});

describe("reply-tool answer preservation (design §3.1 / F1)", () => {
  const REPLY_TOOLS = [
    {
      type: "function" as const,
      function: { name: "reply", parameters: { type: "object", properties: { text: { type: "string" } } } },
    },
  ];

  it("does not drop the reply answer when pre-fence prose has streamed", async () => {
    // Regression (F1): the reply tool replaces p.text with the answer extracted
    // from its fence, which is NOT a prefix-extension of the streamed narration.
    // The end-of-turn prefix guard must append it rather than compute an empty tail.
    const deltas = ["Let me answer.\n", "```reply\n", "The actual answer is 42\n", "```"];
    const full = deltas.join("");
    const chunks = await streamChunks(deltas, full, { tools: REPLY_TOOLS });
    const contents = nonEmpty(chunks, "content").map(c => c.content);

    // Narration streamed live, then the reply answer appended exactly once.
    expect(contents.join("")).toBe("Let me answer.\nThe actual answer is 42");
    // The fence framing/body never leaked as raw content.
    expect(contents.join("")).not.toContain("```reply");
    // One wire turn — the reply branch returns directly, no retries.
    expect(scripted.runCalls).toBe(1);
  });
});

describe("reasoning SSE (Track B, design §4.3)", () => {
  it("emits reasoning_content chunks before content on the non-tool path", async () => {
    const chunks = await streamChunks(["Hello", "!"], "Hello!", {
      reasoning: ["**Thinking**\n", "I will greet.\n"],
    });
    const reasoning = nonEmpty(chunks, "reasoning_content").map(c => c.reasoning_content);
    const contents = nonEmpty(chunks, "content").map(c => c.content);

    expect(reasoning.join("")).toBe("**Thinking**\nI will greet.\n");
    expect(contents.join("")).toBe("Hello!");

    const lastReasoning = chunks.reduce((acc, c, i) => (typeof c.reasoning_content === "string" && c.reasoning_content.length > 0 ? i : acc), -1);
    const firstContent = chunks.findIndex(c => typeof c.content === "string" && c.content.length > 0);
    expect(lastReasoning).toBeGreaterThanOrEqual(0);
    expect(lastReasoning).toBeLessThan(firstContent);
  });

  it("emits reasoning_content before tool_calls on the tool path", async () => {
    const deltas = ["Let me check.\n", "```bash\n", "ls -la\n", "```"];
    const chunks = await streamChunks(deltas, deltas.join(""), {
      tools: TOOLS,
      reasoning: ["Planning the shell call.\n"],
    });
    const reasoningIdx = chunks.findIndex(c => typeof c.reasoning_content === "string" && c.reasoning_content.length > 0);
    const firstTool = chunks.findIndex(c => c.tool_calls);
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningIdx).toBeLessThan(firstTool);
  });

  it("emits a repeated reasoning step exactly once across runBuffered retries (F3)", async () => {
    // Disable prose streaming so streamedProse stays false and the confab/hallucination
    // retry loop actually re-runs the model; each attempt re-emits the same CoT step.
    process.env.M365_NO_TOOL_STREAM = "1";
    const prose = ["I have created ", "the file config.json ", "with the updated settings."];
    const chunks = await streamChunks(prose, prose.join(""), {
      tools: TOOLS,
      reasoning: ["Inspecting files.\n"],
    });
    const reasoning = nonEmpty(chunks, "reasoning_content").map(c => c.reasoning_content);

    // Sanity: retries did happen.
    expect(scripted.runCalls).toBeGreaterThan(1);
    // The same CoT step is surfaced once, not once per retry attempt.
    expect(reasoning).toEqual(["Inspecting files.\n"]);
  });
});

describe("kill switches (design §2 / §6)", () => {
  it("M365_NO_TOOL_STREAM=1 restores the fully-buffered tool path (prose only at end)", async () => {
    process.env.M365_NO_TOOL_STREAM = "1";
    const deltas = ["Let me check.\n", "```bash\n", "ls -la\n", "```"];
    const chunks = await streamChunks(deltas, deltas.join(""), { tools: TOOLS });

    const contents = nonEmpty(chunks, "content").map(c => c.content).join("");
    const toolChunks = chunks.filter(c => c.tool_calls);
    // Fully buffered: the prose isn't streamed live, but it *is* forwarded (before
    // the tool_calls) so a client still sees the model's line before the fence.
    expect(contents).toBe("Let me check.");
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0].tool_calls![0].function.name).toBe("bash");
  });

  it("M365_NO_REASONING_STREAM=1 suppresses reasoning chunks but keeps content", async () => {
    process.env.M365_NO_REASONING_STREAM = "1";
    const chunks = await streamChunks(["Hello", "!"], "Hello!", {
      reasoning: ["**Thinking**\n"],
    });

    expect(nonEmpty(chunks, "reasoning_content")).toHaveLength(0);
    expect(nonEmpty(chunks, "content").map(c => c.content).join("")).toBe("Hello!");
  });
});
