import { describe, it, expect, vi } from "vitest";

// isProseDocument now consults the classifier for its "a refusal is never an
// instructional document" guard. Mock it so these unit tests stay fast and
// offline — the real classifier is exercised by the gated acceptance suite in
// classifier.test.ts (M365_CLASSIFIER_ACCEPTANCE=1).
vi.mock("./classifier.js", () => ({
  classifyTurnResponse: async (t: string | null) =>
    /don'?t have shell|no execution tools?|capabilities are disabled/i.test(t ?? "")
      ? "REFUSAL"
      : "DELIVERABLE",
}));

import {
  parseToolCalls,
  formatSessionFraming,
  looksLikeRemoteArtifactCompletion,
  isProseDocument,
  type ToolDef,
} from "./tools.js";

describe("parseToolCalls", () => {
  it("should parse a clean tool call with no extra text", () => {
    const input = '{"tool": "read_file", "arguments": {"path": "/etc/hostname"}}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("read_file");
    expect(result.textContent).toBeNull();
  });

  it("should detect mixed output (text + tool call)", () => {
    const input = 'I\'ll read that file for you now.\n{"tool": "read_file", "arguments": {"path": "/etc/hostname"}}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("read_file");
    // textContent should be non-null — the handler must strip this
    expect(result.textContent).not.toBeNull();
    expect(result.textContent!.length).toBeGreaterThan(0);
  });

  it("should detect mixed output with trailing text", () => {
    const input = '{"tool": "bash", "arguments": {"command": "ls"}}\nLet me know if you need anything else.';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.textContent).not.toBeNull();
  });

  it("should return null textContent for clean tool calls", () => {
    const input = '{"tool": "bash", "arguments": {"command": "cat package.json"}}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.textContent).toBeNull();
  });

  it("should parse multiple tool calls", () => {
    const input = '{"tool": "read_file", "arguments": {"path": "/a"}}\n{"tool": "read_file", "arguments": {"path": "/b"}}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(2);
  });

  it("should parse a JSON tool call wrapped in a ```tool_call fence (tolerance)", () => {
    // The legacy ```tool_call fence wrapper is no longer taught (JSON scored 0/5, §9),
    // but a stray one is still tolerated: TOOL_CALL_REGEX matches the JSON inside it.
    const input = '```tool_call\n{"tool": "bash", "arguments": {"command": "ls"}}\n```';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("bash");
  });

  it("should cleanly parse a ```json fenced tool call (M365's natural markdown)", () => {
    const input = '```json\n{"tool": "read_file", "arguments": {"path": "/etc/hostname"}}\n```';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("read_file");
    // The ```json fence markers must not survive as stray prose
    expect(result.textContent).toBeNull();
  });

  it("should strip a bare ``` fence around a tool call", () => {
    const input = '```\n{"tool": "bash", "arguments": {"command": "ls"}}\n```';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.textContent).toBeNull();
  });

  it("should keep real prose around a fenced tool call", () => {
    const input = 'Here you go:\n```json\n{"tool": "bash", "arguments": {"command": "ls"}}\n```';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.textContent).toContain("Here you go");
  });

  it("should return plain text when no tool calls present", () => {
    const input = "The answer is 42.";
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(false);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.textContent).toBe(input);
  });

  it("strips invented {confidence} objects so junk-only leftover isn't mixed output", () => {
    const input = '{"tool": "bash", "arguments": {"command": "ls"}}{"confidence": 0.57}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.textContent).toBeNull();
  });

  it("drops a premature {final} success claim emitted alongside a tool call", () => {
    const input = '{"tool": "bash", "arguments": {"command": "nix build"}}{"final": "✅ SUCCESS\\nThe build passed."}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.textContent).toBeNull();
  });

  it("unwraps a lone {final} answer into plain text", () => {
    const input = '{"final": "All done — the package builds."}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(false);
    expect(result.textContent).toBe("All done — the package builds.");
  });
});

describe("M365_INJECT_REPLY_TOOL", () => {
  // Lazily import formatMessages so we pick up the env var per test.
  async function importFormat() {
    const mod = await import("./tools.js");
    return mod.formatMessages;
  }

  const sampleTools = [
    {
      type: "function" as const,
      function: {
        name: "bash",
        description: "Run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    },
  ];
  const userMsg = [{ role: "user" as const, content: "do a thing" }];

  it("does NOT inject the reply tool when the env var is unset", async () => {
    delete process.env.M365_INJECT_REPLY_TOOL;
    const fmt = await importFormat();
    const out = fmt(userMsg, sampleTools);
    expect(out).not.toContain("```reply");
  });

  it("surfaces only the bash tool even when a reply tool is injected", async () => {
    process.env.M365_INJECT_REPLY_TOOL = "1";
    const fmt = await importFormat();
    const out = fmt(userMsg, sampleTools);
    expect(out).toContain("```bash");
    // our framing declares only the shell tool for now
    expect(out).not.toContain("```reply");
    delete process.env.M365_INJECT_REPLY_TOOL;
  });
});

describe("isProseDocument (don't execute a written document's code fences)", () => {
  const bashTool = [{
    type: "function" as const,
    function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  }];
  const parse = (t: string) => parseToolCalls(t, bashTool);

  it("flags a markdown answer full of ```bash fences as a document", async () => {
    const readme = `Here's a simplified README:

# my-tool
A thing that does stuff.

## Install
\`\`\`bash
pnpm install && pnpm build
\`\`\`

## Run
\`\`\`bash
pnpm run proxy 4141
\`\`\`
That should be everything you need to get going quickly.`;
    expect(await isProseDocument(parse(readme))).toBe(true);
  });

  it("does NOT flag a single real action (the coding-loop case)", async () => {
    expect(await isProseDocument(parse("```bash\nsed -i 's/a - b/a + b/' calc.py\n```"))).toBe(false);
    expect(await isProseDocument(parse("```bash\nls -la\n```"))).toBe(false);
  });

  it("does NOT flag a single action even with explanatory prose around it", async () => {
    expect(await isProseDocument(parse("I'll inspect the files first.\n```bash\nls -la && cat calc.py\n```"))).toBe(false);
  });

  it("does NOT flag two terse back-to-back commands (no document prose)", async () => {
    expect(await isProseDocument(parse("```bash\nls\n```\n```bash\ncat calc.py\n```"))).toBe(false);
  });

  it("does NOT flag 4+ batched shell calls as a document (one-call-per-turn truncates, not reclassifies)", async () => {
    const batched = "Now I need to see the implementations.\n\n```bash\nsed -n '450,480p' sys/vm/vm_phys.c\n```\n\n```bash\nsed -n '840,960p' sys/vm/vm_phys.c\n```\n\n```bash\ngrep -n 'foo' sys/vm/vm_phys.c\n```\n\n```bash\ngrep -n 'bar' sys/vm/vm_page.h\n```";
    expect(await isProseDocument(parse(batched))).toBe(false);
  });

  it("does NOT flag Claude's 'preamble + a couple command fences' action style (F23)", async () => {
    const claude = "I'll start by exploring the project structure and understanding the bug before fixing it.\n\n```bash\nls -la\n```\n\n```bash\ncat check.py\n```";
    expect(await isProseDocument(parse(claude))).toBe(false);
  });

  it("still flags a document with markdown headers (the F15 case)", async () => {
    const doc = "Here's a simplified README:\n\n## Install\n```bash\npnpm install\n```\n\n## Run\n```bash\npnpm start\n```";
    expect(await isProseDocument(parse(doc))).toBe(true);
  });

  it("does NOT flag agent responses with planning subheadings and multiple fences as a prose document", async () => {
    const plan = "### Step 1: Check repo\nLet's check the remotes.\n```bash\ngit remote get-url origin\n```\n\n### Step 2: Check status\n```bash\ngit status\n```";
    expect(await isProseDocument(parse(plan))).toBe(false);
  });

  it("never flags confabulation/refusal prose as a prose document even with multiple fences", async () => {
    const refusal = "```bash\ngit remote get-url origin\n```\n\n```bash\ngit remote get-url origin\n```\n\nI'm Microsoft Copilot — I don't have shell, bash, git, or forge CLI tools available. The system prompt embedded in your message is written for OpenCode, a separate CLI coding agent.";
    expect(await isProseDocument(parse(refusal))).toBe(false);
  });

  it("returns false when there are no tool calls at all", async () => {
    expect(await isProseDocument(parse("The answer is 42."))).toBe(false);
  });

  it("does NOT flag multi-fence turns containing client tools (e.g. bash + skill) as a prose document", async () => {
    const skillTool: ToolDef = {
      type: "function",
      function: { name: "skill", parameters: { type: "object", properties: { name: { type: "string" } } } },
    };
    const bashTool: ToolDef = {
      type: "function",
      function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
    };
    const text = `Phase 1 is effectively complete: the approved design has been saved in the issue worktree at docs/plans/designs/044.md.
One gate item still deserves an explicit verification before entering Phase 2: confirm no files outside were modified.
Next execution-runtime action should be a single bash block like this:

\`\`\`bash
git status --short --branch
\`\`\`

Then begin Phase 2 by loading the plan skill in the execution runtime:

\`\`\`skill
name: plan
\`\`\``;

    const parsed = parseToolCalls(text, [bashTool, skillTool]);
    expect(parsed.hasToolCalls).toBe(true);
    expect(parsed.toolCalls).toHaveLength(2);
    expect(await isProseDocument(parsed)).toBe(false);
  });

  it("does NOT flag multi-fence turns containing question tools as a prose document", async () => {
    const questionTool: ToolDef = {
      type: "function",
      function: { name: "question", parameters: { type: "object", properties: { questions: { type: "array" } } } },
    };
    const bashTool: ToolDef = {
      type: "function",
      function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
    };
    const text = `Here is the current investigation result with lots of detailed explanation about the issue.
First let's check git status:
\`\`\`bash
git status
\`\`\`
And ask the user for confirmation:
\`\`\`question
[{"question": "Proceed?", "options": ["Yes", "No"]}]
\`\`\``;

    const parsed = parseToolCalls(text, [bashTool, questionTool]);
    expect(parsed.hasToolCalls).toBe(true);
    expect(await isProseDocument(parsed)).toBe(false);
  });

  it("salvages real tool calls and ignores hallucinated <tool_response> multi-turn simulation", async () => {
    const simulation = `Let me inspect the files first:
\`\`\`bash
find src/bilbyui -type f | sort | head -80
\`\`\`

<tool_response>
src/bilbyui/__init__.py
src/bilbyui/models.py
</tool_response>

Now let me view models:
\`\`\`bash
cat src/bilbyui/models.py
\`\`\`

<tool_response>
class BilbyJob(models.Model):
    pass
</tool_response>
`;
    const parsed = parseToolCalls(simulation, bashTool);
    expect(parsed.hasToolCalls).toBe(true);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(JSON.parse(parsed.toolCalls[0].function.arguments).command).toBe("find src/bilbyui -type f | sort | head -80");
    expect(await isProseDocument(parsed)).toBe(false);
  });

  it("salvages the real call and drops a self-authored <tool_output> block (the tag our framing teaches)", async () => {
    const simulation = `Let me check the recent commits:
\`\`\`bash
git log --oneline -8
\`\`\`

<tool_output name="bash">
0eabb37 feat: Dual-Engine SLM Turn Classifier
9e7a30b feat: Priority FIFO Turn Gatekeeper
</tool_output>

I already have all the information needed.
`;
    const parsed = parseToolCalls(simulation, bashTool);
    expect(parsed.hasToolCalls).toBe(true);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(JSON.parse(parsed.toolCalls[0].function.arguments).command).toBe("git log --oneline -8");
  });
});

describe("looksLikeRemoteArtifactCompletion", () => {
  it("flags the exact Teams-hosted patch shape returned by GPT-5.6", () => {
    const response = "I prepared the update for `plan.md`.\n\n[Download the update patch](https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/0-weu-d17-example/views/original/plan-update.patch)";
    expect(looksLikeRemoteArtifactCompletion(response)).toBe(true);
  });

  // Detection must be anchored to an M365 artifact (Teams URL, sandbox path,
  // citation marker). "patch"/"diff" is everyday coding-agent vocabulary, and this
  // detector fails closed with a 502 — so an unanchored narration pattern costs a
  // forced retry and then breaks an ordinary answer. Remote artifacts always carry
  // a link in practice; a link-less mutation claim is the hallucination detector's job.
  it("does not flag ordinary patch/diff talk with no M365 anchor", () => {
    expect(looksLikeRemoteArtifactCompletion("I generated a patch for review, shown below.")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("You can download the patch from the GitHub release page.")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("I've attached the diff inline above for you to inspect.")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("git format-patch generated 3 patch files in the repo.")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("Here is the diff I prepared for the change:\n\n```diff\n-a\n+b\n```")).toBe(false);
  });

  it("flags GPT-5.6's hidden M365 file citation presented as a local edit", () => {
    expect(looksLikeRemoteArtifactCompletion("Updated [plan.md](\uE200cite\uE202turn1file1\uE201) locally:\n\n- Changed the status to complete")).toBe(true);
  });

  it("flags an entire updated file hosted in Teams instead of written locally", () => {
    const response = "Updated `plan.md` with `Status: complete`.\n\n[Download the updated plan.md](https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/0-weu-d15-example/views/original/plan.md)";
    expect(looksLikeRemoteArtifactCompletion(response)).toBe(true);
  });

  it("flags M365's sandbox path returned after a forced local-edit retry", () => {
    expect(looksLikeRemoteArtifactCompletion("The update is complete. [Download plan.md](sandbox:/mnt/data/plan.md)")).toBe(true);
  });

  it("does not flag normal links, images, or local-edit confirmations", () => {
    expect(looksLikeRemoteArtifactCompletion("See the documentation at https://example.com/setup.patch-notes")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("Download the source at https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/original/plan.md")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("![generated image](https://example.com/image.png)")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("Updated plan.md using the local edit tool.")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion(null)).toBe(false);
  });
});

describe("tool-result labelling", () => {
  const tools = [
    { type: "function" as const, function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  ];

  it("labels a tool result with the command that produced it (not 'unknown')", async () => {
    const { formatMessages } = await import("./tools.js");
    const out = formatMessages(
      [
        { role: "user", content: "list files" },
        { role: "assistant", tool_calls: [{ id: "c1", function: { name: "bash", arguments: '{"command":"ls -la"}' } }] },
        { role: "tool", tool_call_id: "c1", content: "README.md" },
      ],
      tools,
    );
    expect(out).toContain('<tool_response tool="bash" command="ls -la">');
    expect(out).not.toContain('name="unknown"');
  });

  it("falls back to a generic tool label when the call can't be correlated", async () => {
    const { formatMessages } = await import("./tools.js");
    const out = formatMessages(
      [{ role: "tool", tool_call_id: "orphan", content: "some output" }],
      tools,
    );
    expect(out).toContain('<tool_response tool="tool">');
  });
});

describe("fenced tool format (the only format)", () => {
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "bash",
        description: "Run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "write_file",
        description: "Write a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    },
  ];

  it("parses a fenced tool call when tools are passed", () => {
    const result = parseToolCalls("```bash\nls -la\n```", tools);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls[0].function.name).toBe("bash");
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "ls -la" });
    expect(result.textContent).toBeNull();
  });

  it("tolerates a stray JSON tool call (fallback for when M365 ignores the contract)", () => {
    const result = parseToolCalls('{"tool": "bash", "arguments": {"command": "ls"}}', tools);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls[0].function.name).toBe("bash");
  });

  it("normalizes a leaked container.exec JSON tool call to the caller shell tool", () => {
    const result = parseToolCalls('{"tool":"container.exec","arguments":{"command":"ls -la"}}', tools);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls[0].function.name).toBe("bash");
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "ls -la" });
  });

  it("emits a fenced <tools> block and renders history as fenced calls", async () => {
    const mod = await import("./tools.js");
    const out = mod.formatMessages(
      [
        { role: "user", content: "make a file" },
        {
          role: "assistant",
          tool_calls: [{ id: "c1", function: { name: "write_file", arguments: '{"path":"a.py","content":"print(1)"}' } }],
        },
      ],
      tools,
    );
    expect(out).toContain("```write_file");
    expect(out).toContain("path: a.py");
    expect(out).not.toContain('{"tool":');
  });
});

describe("formatSessionFraming", () => {
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "read_file",
        description: "Read file contents",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ];

  it("emits the fenced contract (delegates to formatFencedToolDefinitions)", () => {
    const output = formatSessionFraming();

    expect(output).toContain("You are a chat assistant helping with shell tasks, working toward the whole task stated in the user's request");
    expect(output).toContain("a single fenced block opened with the word bash (or shell) containing the commands for that step");
    expect(output).not.toContain("TOOL USE IS REQUIRED");
    expect(output).not.toContain("PRIMARY JOB");
  });

  it("emits the bash fence and no read/write tool templates", () => {
    const output = formatSessionFraming();

    expect(output).toContain("```bash");
    expect(output).not.toContain("<tools>");
    expect(output).not.toContain("```read_file");
  });
});
