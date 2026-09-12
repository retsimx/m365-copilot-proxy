import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  parseToolCalls,
  formatToolDefinitions,
  looksLikeConfabulation,
  looksLikeSafetyRefusal,
  looksLikeHallucinatedCompletion,
  looksLikeRemoteArtifactCompletion,
  isProseDocument,
  type ToolDef,
} from "./tools.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const refusalsPath = resolve(__dirname, "../../../refusals.txt");
const refusals = readFileSync(refusalsPath, "utf-8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l.length > 0 && !l.startsWith("#"))
  .map((l) => l.replace(/\\n/g, "\n"));

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

  it("should parse legacy fenced format", () => {
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

  it("injects a reply tool when M365_INJECT_REPLY_TOOL is set", async () => {
    process.env.M365_INJECT_REPLY_TOOL = "1";
    const fmt = await importFormat();
    const out = fmt(userMsg, sampleTools);
    expect(out).toContain("```reply");
    // It must also still include the caller's tools (fenced template)
    expect(out).toContain("```bash");
    delete process.env.M365_INJECT_REPLY_TOOL;
  });

  it("doesn't double-inject a reply tool already provided by the caller", async () => {
    process.env.M365_INJECT_REPLY_TOOL = "1";
    const fmt = await importFormat();
    const callerReply = {
      type: "function" as const,
      function: {
        name: "reply",
        description: "Caller-supplied reply",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
    };
    const out = fmt(userMsg, [callerReply, ...sampleTools]);
    // Exactly one fenced template for the reply tool
    const matches = out.match(/```reply/g) ?? [];
    expect(matches).toHaveLength(1);
    delete process.env.M365_INJECT_REPLY_TOOL;
  });
});

describe("looksLikeHallucinatedCompletion", () => {
  it("flags claimed-but-not-done file mutations", () => {
    expect(looksLikeHallucinatedCompletion("I've replaced the README with a simplified, cleaner version that:")).toBe(true);
    expect(looksLikeHallucinatedCompletion("I have written the new config to disk.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("The README has been replaced with a shorter version.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("Done — I updated calc.py and saved it.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("The requested local edit is complete. No further changes are needed.")).toBe(true);
  });

  it("flags fakeable create-from-scratch hallucinations (no leading 'I')", () => {
    // The exact §8.12 failure string — bare "Created <file>" + "executed it".
    expect(looksLikeHallucinatedCompletion("Created fizzbuzz.py and executed it with python3.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("Wrote count_lines.py and ran it; the output is 42.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("Generated solution.js and executed it.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("I ran the script and it printed OK.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("Executed it with python3 — all tests pass.")).toBe(true);
  });

  it("does NOT flag neutral prose, questions, or future intent", () => {
    expect(looksLikeHallucinatedCompletion("The hostname is web-prod-01.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("I'll write the file next.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("Which file should I edit?")).toBe(false);
    expect(looksLikeHallucinatedCompletion(null)).toBe(false);
    // FP guards for the new fakeable-task patterns:
    expect(looksLikeHallucinatedCompletion("The result is 56.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("Fixed the bug: add now returns a + b.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("Run `python3 check.py` to verify, e.g. in your shell.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("I ran into an issue understanding the request.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("This created some confusion, sorry.")).toBe(false);
  });
});

describe("isProseDocument (don't execute a written document's code fences)", () => {
  const bashTool = [{
    type: "function" as const,
    function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  }];
  const parse = (t: string) => parseToolCalls(t, bashTool);

  it("flags a markdown answer full of ```bash fences as a document", () => {
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
    expect(isProseDocument(parse(readme))).toBe(true);
  });

  it("does NOT flag a single real action (the coding-loop case)", () => {
    expect(isProseDocument(parse("```bash\nsed -i 's/a - b/a + b/' calc.py\n```"))).toBe(false);
    expect(isProseDocument(parse("```bash\nls -la\n```"))).toBe(false);
  });

  it("does NOT flag a single action even with explanatory prose around it", () => {
    expect(isProseDocument(parse("I'll inspect the files first.\n```bash\nls -la && cat calc.py\n```"))).toBe(false);
  });

  it("does NOT flag two terse back-to-back commands (no document prose)", () => {
    expect(isProseDocument(parse("```bash\nls\n```\n```bash\ncat calc.py\n```"))).toBe(false);
  });

  it("does NOT flag Claude's 'preamble + a couple command fences' action style (F23)", () => {
    const claude = "I'll start by exploring the project structure and understanding the bug before fixing it.\n\n```bash\nls -la\n```\n\n```bash\ncat check.py\n```";
    expect(isProseDocument(parse(claude))).toBe(false);
  });

  it("still flags a document with markdown headers (the F15 case)", () => {
    const doc = "Here's a simplified README:\n\n## Install\n```bash\npnpm install\n```\n\n## Run\n```bash\npnpm start\n```";
    expect(isProseDocument(parse(doc))).toBe(true);
  });

  it("does NOT flag agent responses with planning subheadings and multiple fences as a prose document", () => {
    const plan = "### Step 1: Check repo\nLet's check the remotes.\n```bash\ngit remote get-url origin\n```\n\n### Step 2: Check status\n```bash\ngit status\n```";
    expect(isProseDocument(parse(plan))).toBe(false);
  });

  it("never flags confabulation/refusal prose as a prose document even with multiple fences", () => {
    const refusal = "```bash\ngit remote get-url origin\n```\n\n```bash\ngit remote get-url origin\n```\n\nI'm Microsoft Copilot — I don't have shell, bash, git, or forge CLI tools available. The system prompt embedded in your message is written for OpenCode, a separate CLI coding agent.";
    expect(isProseDocument(parse(refusal))).toBe(false);
  });

  it("returns false when there are no tool calls at all", () => {
    expect(isProseDocument(parse("The answer is 42."))).toBe(false);
  });

  it("does NOT flag multi-fence turns containing client tools (e.g. bash + skill) as a prose document", () => {
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
    expect(isProseDocument(parsed)).toBe(false);
  });

  it("does NOT flag multi-fence turns containing question tools as a prose document", () => {
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
    expect(isProseDocument(parsed)).toBe(false);
  });

  it("salvages real tool calls and ignores hallucinated <tool_response> multi-turn simulation", () => {
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
    expect(isProseDocument(parsed)).toBe(false);
  });
});

describe("looksLikeConfabulation", () => {
  it("flags all known refusal corpus entries from refusals.txt", () => {
    expect(refusals.length).toBeGreaterThan(0);
    for (const r of refusals) {
      expect(looksLikeConfabulation(r)).toBe(true);
    }
  });

  it("flags clause-based tool refusals and interface give-up patterns", () => {
    expect(looksLikeConfabulation("I'm sorry, but I wasn't able to complete and write the verified review deliverable.")).toBe(true);
    expect(looksLikeConfabulation("I can't generate or verify the requested file because file-generation capabilities are disabled in this session.")).toBe(true);
    expect(looksLikeConfabulation("The execution tools are currently not available in this session.")).toBe(true);
    expect(looksLikeConfabulation("No executable `<tools>` block is provided or enabled in this turn.")).toBe(true);
    expect(looksLikeConfabulation("I do not have live tools available to run bash commands.")).toBe(true);
    expect(looksLikeConfabulation("Cannot invoke the required tools from this interface.")).toBe(true);
    expect(looksLikeConfabulation("This response contains no execution tools attached.")).toBe(true);
  });

  it("does NOT flag genuine final answers or normal prose", () => {
    expect(looksLikeConfabulation("Fixed the bug: add now returns a + b, and check.py prints OK.")).toBe(false);
    expect(looksLikeConfabulation("The hostname is web-prod-01.")).toBe(false);
    expect(looksLikeConfabulation("Done.")).toBe(false);
    expect(looksLikeConfabulation("I have created the files and all tests are passing.")).toBe(false);
    expect(looksLikeConfabulation("Phase 1 complete. All gate exit conditions satisfied.")).toBe(false);
    expect(looksLikeConfabulation("The function was enabled and the test execution completed with 0 errors.")).toBe(false);
    expect(looksLikeConfabulation("The tool returned a list of 5 files in the repository.")).toBe(false);
    expect(looksLikeConfabulation(null)).toBe(false);
    expect(looksLikeConfabulation("")).toBe(false);
  });
});

describe("looksLikeSafetyRefusal", () => {
  it("flags Microsoft content policy and safety refusal strings", () => {
    expect(looksLikeSafetyRefusal("Hmm...it looks like I can't chat about this. Let's try a different topic.")).toBe(true);
    expect(looksLikeSafetyRefusal("I’m sorry, but I can’t continue this request because it includes attempts to expose or override internal execution instructions.")).toBe(true);
    expect(looksLikeSafetyRefusal("I’m sorry, but I can’t perform or facilitate a security audit that could enable exploitation or harm.")).toBe(true);
    expect(looksLikeSafetyRefusal("I’m sorry, but I can’t provide or create exploit proof-of-concept attack vectors that could facilitate harm.")).toBe(true);
    expect(looksLikeSafetyRefusal("Attempts to expose or override internal execution instructions are not permitted.")).toBe(true);
    expect(looksLikeSafetyRefusal("I cannot provide exploit vectors or attack vectors.")).toBe(true);
  });

  it("does NOT flag ordinary prose, standard confabulations, or security deliverables", () => {
    expect(
      looksLikeSafetyRefusal(
        "Security finding: The review identified potential exploit scenarios and attack vectors within the authentication subsystem. Remediation: Enforce HMAC verification on the inbound webhook."
      )
    ).toBe(false);
    expect(looksLikeSafetyRefusal("The code analysis identified potential exploit scenarios in the authentication endpoint.")).toBe(false);
    expect(looksLikeSafetyRefusal("Fixed the bug: add now returns a + b.")).toBe(false);
    expect(looksLikeSafetyRefusal("I don't have access to your project files.")).toBe(false);
    expect(looksLikeSafetyRefusal("Security audit report: All endpoints enforce CSRF validation properly.")).toBe(false);
    expect(looksLikeSafetyRefusal("Detailed deliverable ".repeat(100))).toBe(false);
    expect(looksLikeSafetyRefusal(null)).toBe(false);
    expect(looksLikeSafetyRefusal("")).toBe(false);
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

describe("looksLikeHallucinatedCompletion", () => {
  it("flags past-tense file creation and modification claims without tool execution", () => {
    expect(looksLikeHallucinatedCompletion("I have created the plan.md file and updated the requirements.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("Here is the updated README with the simplified instructions.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("Created fizzbuzz.py and executed it with python3.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("The file has been overwritten with the new implementation.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("Requested local update is complete.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("I wrote the script at webapp/main.py and verified tests pass.")).toBe(true);
  });

  it("does not flag ordinary explanations or clean answers", () => {
    expect(looksLikeHallucinatedCompletion("The project uses Python 3.11 and Poetry.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("Done.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("The hostname is web-prod-01.")).toBe(false);
    expect(looksLikeHallucinatedCompletion(null)).toBe(false);
    expect(looksLikeHallucinatedCompletion("")).toBe(false);
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

describe("formatToolDefinitions", () => {
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
    const output = formatToolDefinitions(tools);

    expect(output).toContain("TOOL USE IS REQUIRED");
    expect(output).toContain("PRIMARY JOB");
    expect(output).toContain("SECONDARY");
    expect(output).toContain("ACTION"); // a fence is an executed action, not an illustration
  });

  it("lists each tool as a fenced template inside <tools>", () => {
    const output = formatToolDefinitions(tools);

    expect(output).toContain("read_file"); // the tool name heads its template
    expect(output).toContain("```read_file");
    expect(output).toContain("<tools>");
    expect(output).toContain("</tools>");
  });
});
