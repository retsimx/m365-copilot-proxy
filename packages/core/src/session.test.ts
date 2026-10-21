import { describe, it, expect } from "vitest";
import {
  foldStreamText,
  isThrottled,
  classifyBotMessage,
  createBotMessageRouter,
  createAnswerAccumulator,
  shouldAccumulateCard,
} from "./session.js";
import { parseToolCalls } from "./tools.js";
import { MessageUpdate } from "./schemas.js";

/** Replay a sequence of raw M365 frames (deltas as {d}, snapshots as {s}) through
 *  foldStreamText and collect what would be streamed + the final buffered answer. */
function replay(frames: Array<{ d: string } | { s: string }>) {
  let answer = "";
  const emitted: string[] = [];
  for (const f of frames) {
    const next = "d" in f ? answer + f.d : f.s;
    const r = foldStreamText(answer, next);
    answer = r.answer;
    if (r.emit) emitted.push(r.emit);
  }
  return { emitted, streamed: emitted.join(""), answer };
}

describe("foldStreamText", () => {
  it("streams pure token deltas as-is", () => {
    const r = replay([{ d: "Hello" }, { d: ", " }, { d: "world" }]);
    expect(r.emitted).toEqual(["Hello", ", ", "world"]);
    expect(r.answer).toBe("Hello, world");
  });

  it("recovers the head token when it arrives only as a snapshot (the live bug)", () => {
    // M365 delivered "alpha" as a full-text snapshot, then token deltas for the rest.
    const r = replay([
      { s: "alpha" },
      { d: "\nbeta" },
      { d: "\ngamma" },
    ]);
    expect(r.streamed).toBe("alpha\nbeta\ngamma");
    expect(r.answer).toBe("alpha\nbeta\ngamma");
  });

  it("streams the appended suffix when snapshots grow monotonically", () => {
    const r = replay([{ s: "The " }, { s: "The quick " }, { s: "The quick fox" }]);
    expect(r.emitted).toEqual(["The ", "quick ", "fox"]);
    expect(r.answer).toBe("The quick fox");
  });

  it("emits the extending tail of a snapshot exactly once (no duplication)", () => {
    // Deltas gave "Hello wor"; a final snapshot "Hello world" EXTENDS it, so only the
    // "ld" tail is emitted — never the whole snapshot on top of the deltas.
    const r = replay([{ d: "Hello " }, { d: "wor" }, { s: "Hello world" }]);
    expect(r.emitted).toEqual(["Hello ", "wor", "ld"]);
    expect(r.streamed).toBe("Hello world");
    expect(r.answer).toBe("Hello world");
  });

  it("ignores shorter/equal snapshots (no negative-length slice, no re-emit)", () => {
    const r = replay([{ d: "abcdef" }, { s: "abc" }, { s: "abcdef" }]);
    expect(r.emitted).toEqual(["abcdef"]);
    expect(r.answer).toBe("abcdef");
  });

  it("adopts a divergent longer snapshot as authoritative but does not stream it", () => {
    // Deltas streamed "xy"; a later snapshot reveals a different, longer head. We keep
    // the snapshot for the buffered result but must NOT stream it (can't unsend "xy").
    const r = replay([{ d: "xy" }, { s: "ZZZxy extra" }]);
    expect(r.streamed).toBe("xy");
    expect(r.answer).toBe("ZZZxy extra");
    expect(r.answer.startsWith(r.streamed)).toBe(false); // divergence recorded, not streamed
  });
});

describe("GraphicArt image frame parsing (§14)", () => {
  // The exact shape captured from a live GUI image turn — the fields zod used to
  // strip. If BotMessage is ever re-tightened, this fails and the image is lost.
  const graphicArtFrame = {
    messages: [
      {
        text: "Loading image",
        contentGenerationProgressList: [
          {
            contentType: "image",
            size: "Xlimage",
            orientation: "Landscape",
            pollUrl: "eyJQb2xsSWQiOiJ4In0=",
            fileToken: "359965a5-6ca9-409d-a4ca-43b0cc9cdf81",
            ImageReferenceUrls: ["https://designerapp.officeapps.live.com/designerapp/document.ashx?path=%2Fx%2FDallEGeneratedImages%2Fdalle-abc.png"],
            status: 2,
          },
        ],
        contentType: "GraphicArt",
        author: "bot",
        messageType: "Progress",
        contentOrigin: "ImageGeneration",
      },
    ],
  };

  it("retains the image payload instead of stripping it", () => {
    const parsed = MessageUpdate.safeParse(graphicArtFrame);
    expect(parsed.success).toBe(true);
    const m = parsed.data!.messages[0] as any;
    expect(m.contentType).toBe("GraphicArt");
    const entry = m.contentGenerationProgressList[0];
    expect(entry.ImageReferenceUrls[0]).toContain("DallEGeneratedImages");
    expect(entry.fileToken).toBe("359965a5-6ca9-409d-a4ca-43b0cc9cdf81");
    expect(entry.status).toBe(2);
  });

  it("still parses an ordinary text bot message with no image fields", () => {
    const parsed = MessageUpdate.safeParse({
      messages: [{ text: "just text", author: "bot", messageType: "Chat" }],
    });
    expect(parsed.success).toBe(true);
    const m = parsed.data!.messages[0] as any;
    expect(m.contentGenerationProgressList).toBeUndefined();
  });
});

describe("BotMessage discriminator retention (design 002 §4.1)", () => {
  it("retains addToChainOfThought through MessageUpdate.safeParse", () => {
    const parsed = MessageUpdate.safeParse({
      messages: [
        { text: "**Inspecting files**\nI will read…", author: "bot", addToChainOfThought: true },
      ],
    });
    expect(parsed.success).toBe(true);
    const m = parsed.data!.messages[0] as any;
    expect(m.addToChainOfThought).toBe(true);
  });

  it("still strips unrelated unknown keys (no schema loosening)", () => {
    const parsed = MessageUpdate.safeParse({
      messages: [{ text: "hi", author: "bot", someUnknownField: 1 }],
    });
    expect(parsed.success).toBe(true);
    expect((parsed.data!.messages[0] as any).someUnknownField).toBeUndefined();
  });
});

describe("classifyBotMessage (design 002 §5)", () => {
  it("routes addToChainOfThought to reasoning, never answer", () => {
    expect(classifyBotMessage({ author: "bot", text: "step", addToChainOfThought: true }))
      .toBe("reasoning");
  });

  it("advances plain bot text with no messageType", () => {
    expect(classifyBotMessage({ author: "bot", text: "answer" })).toBe("answer");
  });

  it("suppresses EarlyProgress and Code control frames", () => {
    expect(classifyBotMessage({ author: "bot", text: "Just a sec…", messageType: "Progress", contentType: "EarlyProgress" })).toBe("suppress");
    expect(classifyBotMessage({ author: "bot", text: "mkdir -p …", contentType: "Code" })).toBe("suppress");
  });

  it("suppresses Disengaged and ordinary messageType'd control frames", () => {
    expect(classifyBotMessage({ author: "bot", text: "I can't help", messageType: "Disengaged" })).toBe("suppress");
    expect(classifyBotMessage({ author: "bot", text: "loading", messageType: "Progress" })).toBe("suppress");
  });

  it("suppresses non-bot and empty messages", () => {
    expect(classifyBotMessage({ author: "user", text: "hi" })).toBe("suppress");
    expect(classifyBotMessage({ author: "bot" })).toBe("suppress");
  });
});

describe("createBotMessageRouter (design 002 §4.2)", () => {
  function makeRouter() {
    const answered: string[] = [];
    const reasoned: string[] = [];
    const route = createBotMessageRouter({
      onAnswer: (t) => answered.push(t),
      onReasoning: (t) => reasoned.push(t),
    });
    return { answered, reasoned, route };
  }

  it("routes CoT to onReasoning and never to the answer stream", () => {
    const { answered, reasoned, route } = makeRouter();
    route({ author: "bot", text: "step one", addToChainOfThought: true, messageId: "m1" });
    route({ author: "bot", text: "the answer", messageId: "m2" });
    expect(reasoned).toEqual(["step one"]);
    expect(answered).toEqual(["the answer"]);
  });

  it("emits a duplicate messageId CoT step exactly once", () => {
    const { reasoned, route } = makeRouter();
    route({ author: "bot", text: "step", addToChainOfThought: true, messageId: "m1" });
    route({ author: "bot", text: "step", addToChainOfThought: true, messageId: "m1" });
    route({ author: "bot", text: "step two", addToChainOfThought: true, messageId: "m2" });
    expect(reasoned).toEqual(["step", "step two"]);
  });

  it("suppresses EarlyProgress/Code from both channels", () => {
    const { answered, reasoned, route } = makeRouter();
    route({ author: "bot", text: "Just a sec…", messageType: "Progress", contentType: "EarlyProgress" });
    route({ author: "bot", text: "mkdir -p …", contentType: "Code" });
    expect(answered).toEqual([]);
    expect(reasoned).toEqual([]);
  });
});

describe("createAnswerAccumulator — no output accepted after the Stop frame", () => {
  it("accumulates and streams deltas normally before stop()", () => {
    const emitted: string[] = [];
    const acc = createAnswerAccumulator((e) => emitted.push(e));
    // advance() takes the NEXT FULL TEXT (answer + delta), as session.run calls it.
    acc.advance("Here is the ");
    acc.advance("Here is the result.");
    expect(acc.answer).toBe("Here is the result.");
    expect(emitted.join("")).toBe("Here is the result.");
    expect(acc.hasContent).toBe(true);
    expect(acc.stopped).toBe(false);
  });

  it("drops every frame after stop() — the post-Stop M365 UI text never reaches the answer", () => {
    const emitted: string[] = [];
    const acc = createAnswerAccumulator((e) => emitted.push(e));
    acc.advance("```bash\ngrep -n foo sys/conf.h\n```");

    acc.stop(); // caller aborted / post-fence guard fired → Stop frame sent

    // M365 keeps emitting after the Stop (its own UI text); none of it may be kept.
    acc.advance("\n\n<tool");
    acc.advance("\n\nYou have stopped this conversation.");
    acc.advance("\n\nYou have stopped this conversation.");

    expect(acc.answer).toBe("```bash\ngrep -n foo sys/conf.h\n```");
    expect(emitted.join("")).toBe("```bash\ngrep -n foo sys/conf.h\n```");
    expect(acc.stopped).toBe(true);
  });

  it("hasContent stays false when only post-stop frames arrive", () => {
    const acc = createAnswerAccumulator(() => {});
    acc.stop();
    acc.advance("You have stopped this conversation.");
    expect(acc.answer).toBe("");
    expect(acc.hasContent).toBe(false);
  });

  it("stop() is idempotent", () => {
    const acc = createAnswerAccumulator(() => {});
    acc.stop();
    acc.stop();
    expect(acc.stopped).toBe(true);
  });
});

describe("shouldAccumulateCard (cursor-addressed block cards)", () => {
  it("routes a cursor-addressed plain answer card to the card accumulator", () => {
    expect(shouldAccumulateCard({ author: "bot", text: "```shell", messageId: "m1" }, true)).toBe(true);
  });

  it("never routes without a cursor — a full-message snapshot keeps the fold path", () => {
    expect(shouldAccumulateCard({ author: "bot", text: "```shell", messageId: "m1" }, false)).toBe(false);
  });

  it("never routes reasoning, Code or EarlyProgress frames", () => {
    expect(shouldAccumulateCard({ author: "bot", text: "step", messageId: "m", addToChainOfThought: true }, true)).toBe(false);
    expect(shouldAccumulateCard({ author: "bot", text: "Coding and executing", messageId: "m", contentType: "Code" }, true)).toBe(false);
    expect(shouldAccumulateCard({ author: "bot", text: "Just a sec…", messageId: "m", contentType: "EarlyProgress" }, true)).toBe(false);
    expect(shouldAccumulateCard({ author: "bot", text: "progress", messageId: "m", messageType: "Progress" }, true)).toBe(false);
  });

  it("requires a message id and text", () => {
    expect(shouldAccumulateCard({ author: "bot", text: "x" }, true)).toBe(false);
    expect(shouldAccumulateCard({ author: "bot", messageId: "m" }, true)).toBe(false);
    expect(shouldAccumulateCard({ author: "user", text: "x", messageId: "m" }, true)).toBe(false);
  });
});

describe("createAnswerAccumulator — cursor-addressed card starts (split delivery)", () => {
  // Live 2026-10-20 (issue-autopilot SCM subagent, cid d1bf2be4): M365 opens each
  // block as its own card — a cursor-addressed MessageUpdate carrying that card's first
  // bytes ("```", "```shell\nech") followed by writeAtCursor deltas. Feeding the card
  // text to the whole-answer fold dropped it whenever it was shorter than the prose
  // already accumulated, so the block lost its opener ("…verdict.edit\npath:") or its
  // opener AND part of its first line ("…verdict.o \"=== PLAN").
  it("keeps a block card's opening bytes when the card text is shorter than the prose", () => {
    const emitted: string[] = [];
    const acc = createAnswerAccumulator((e) => emitted.push(e));

    acc.advanceCard("prose-card", "Now let me read the plan");
    acc.advance(acc.answer + " JSON and the verdict.");
    acc.advanceCard("block-card", "```shell\nech");
    acc.advance(acc.answer + 'o "=== PLAN" && cat plan.json');
    acc.advance(acc.answer + "\n```");

    expect(acc.answer).toBe(
      'Now let me read the plan JSON and the verdict.\n\n```shell\necho "=== PLAN" && cat plan.json\n```',
    );
    expect(emitted.join("")).toBe(acc.answer);
  });

  it("separates the first card from nothing and later cards by one newline", () => {
    const acc = createAnswerAccumulator(() => {});
    acc.advanceCard("a", "First paragraph.");
    acc.advanceCard("b", "```bash\nls\n```");
    acc.advanceCard("c", "Trailing line.");
    expect(acc.answer).toBe("First paragraph.\n\n```bash\nls\n```\n\nTrailing line.");
  });

  it("does not add a second newline when the answer already ends with one", () => {
    const acc = createAnswerAccumulator(() => {});
    acc.advanceCard("a", "Paragraph.\n");
    acc.advanceCard("b", "```bash\nls\n```");
    expect(acc.answer).toBe("Paragraph.\n\n```bash\nls\n```");
  });

  it("extends the same card without duplicating what was already streamed", () => {
    const emitted: string[] = [];
    const acc = createAnswerAccumulator((e) => emitted.push(e));
    acc.advanceCard("a", "```bash");
    acc.advance(acc.answer + "\nls -la");
    acc.advanceCard("a", "```bash\nls -la\n```");
    expect(acc.answer).toBe("```bash\nls -la\n```");
    expect(emitted.join("")).toBe("```bash\nls -la\n```");
  });

  it("keeps streamed text when a same-card snapshot is a shorter rewrite", () => {
    const acc = createAnswerAccumulator(() => {});
    acc.advanceCard("a", "The first phrasing of the line.");
    acc.advanceCard("a", "The first phrasing");
    expect(acc.answer).toBe("The first phrasing of the line.");
  });

  it("ignores card frames after stop()", () => {
    const acc = createAnswerAccumulator(() => {});
    acc.advanceCard("a", "kept");
    acc.stop();
    acc.advanceCard("a", "kept and more");
    acc.advanceCard("b", "new card");
    expect(acc.answer).toBe("kept");
  });

  it("produces text that parses as one tool call (end-to-end shape)", () => {
    const acc = createAnswerAccumulator(() => {});
    acc.advanceCard("prose", "Reading the plan now.");
    acc.advanceCard("block", "```");
    acc.advance(acc.answer + "bash\nwc -l plan.json");
    acc.advance(acc.answer + "\n```");

    const bashTool = {
      type: "function" as const,
      function: {
        name: "bash",
        description: "Run a shell command.",
        parameters: { type: "object" as const, properties: { command: { type: "string" } } },
      },
    };
    const parsed = parseToolCalls(acc.answer, [bashTool]);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].function.name).toBe("bash");
    expect(JSON.parse(parsed.toolCalls[0].function.arguments).command).toBe("wc -l plan.json");
  });
});

describe("isThrottled", () => {
  it("returns true when errorCode is PerUserThrottled", () => {
    expect(isThrottled({ errorCode: "PerUserThrottled" })).toBe(true);
  });

  it("returns true when errorCode is PerScenarioThrottled", () => {
    expect(isThrottled({ errorCode: "PerScenarioThrottled" })).toBe(true);
  });

  it("returns true when value is Throttled", () => {
    expect(isThrottled({ value: "Throttled" })).toBe(true);
  });

  it("returns true when turnState is Failed and value is Throttled", () => {
    expect(isThrottled({ value: "Throttled" }, "Failed")).toBe(true);
  });

  it("returns false for normal non-throttled results", () => {
    expect(isThrottled({ value: "Success" })).toBe(false);
    expect(isThrottled(null)).toBe(false);
    expect(isThrottled(undefined)).toBe(false);
  });
});
