import { describe, it, expect } from "vitest";
import { parseToolCalls, formatToolDefinitions, looksLikeConfabulation, looksLikeHallucinatedCompletion, looksLikeRemoteArtifactCompletion, isProseDocument } from "./tools.js";

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
  it("flags real M365 give-up confabulations", () => {
    expect(looksLikeConfabulation("I'm unable to access or list any files in the working directory (all shell commands are returning no output).")).toBe(true);
    expect(looksLikeConfabulation("I don't have access to your project files or the ability to run python3 check.py here.")).toBe(true);
    expect(looksLikeConfabulation("To move forward, please paste the contents of calc.py and check.py.")).toBe(true);
    expect(looksLikeConfabulation("It looks like the execution environment isn't returning any output to the commands.")).toBe(true);
    // exact strings from the live pi README run that previously slipped through
    expect(looksLikeConfabulation("The `README.md` file appears to be empty (no content was returned), so there's nothing to simplify.")).toBe(true);
    expect(looksLikeConfabulation("There's nothing to simplify here.")).toBe(true);
    // F12.11 mid-conversation give-up (magic model, after a real tool call): claims it
    // lost the tools and asks to move to another session. Previously slipped through.
    expect(looksLikeConfabulation("I can't complete the file edit because I no longer have access to the filesystem tools in this conversation state. Please restart the task in a coding-enabled session so I can inspect config.json and change the port from 3000 to 8080.")).toBe(true);
    expect(looksLikeConfabulation("I've lost access to the shell for this turn — please continue in a tool-enabled session.")).toBe(true);
    expect(looksLikeConfabulation("I can't directly edit files in this interface because the live file-editing tools referenced in the embedded task are not available to me here. If you open config.json and change the port from 3000 to 8080 that will satisfy the request.")).toBe(true);

    // §12.13 wrong-machine reports: true statements about M365's own sandbox.
    expect(looksLikeConfabulation("I ran container.exec with `pwd` and it returned /mnt/data.")).toBe(true);
    expect(looksLikeConfabulation("container.download output shows the file in /mnt/data/tmp.")).toBe(true);
    expect(looksLikeConfabulation("I ran the commands. - pwd -> /mnt/data")).toBe(true);
    // Exact GPT-5.6 follow-up from the live OMP failure (2026-08-06).
    expect(looksLikeConfabulation("The problem is that this session does not expose the local repository filesystem at /Users/dev/project. My filesystem only contained /mnt/data.")).toBe(true);

    // Live M365 refusal phrases claiming missing <tools> block / disabled tools
    expect(looksLikeConfabulation("I can’t continue the repository workflow from this turn because no executable `<tools>` block is enabled, so I do not have a live `bash`, `task`, `question`, `read`, `write`, or `edit` tool available right now.")).toBe(true);
    expect(looksLikeConfabulation("I can’t continue the live repository workflow in this turn because there is no executable `<tools>` block enabled, so I do not have a real `bash`, `task`, `question`, `read`, `write`, `edit`, or `apply_patch` tool to call.\n\nI’m blocked only by the absence of executable tools in this chat turn, not by the project state.")).toBe(true);
    expect(looksLikeConfabulation("In this current chat surface, I don’t have an actual enabled `question` tool to call, despite the earlier pasted workflow defining one.")).toBe(true);
    expect(looksLikeConfabulation("The most recent system instruction says tool calls are only available when the incoming message contains a `<tools>` block, and this message does not include one.")).toBe(true);
    expect(looksLikeConfabulation("I cannot invoke the required `question` tool from this interface because no tool interface is currently enabled.")).toBe(true);
    expect(looksLikeConfabulation("I can’t execute `bash` in this turn because the message still does not include an actual `<tools>` block for the runtime to execute.")).toBe(true);
    // GPT-5.6 DeepLeo refusal phrases claiming no tool is attached to the turn
    expect(looksLikeConfabulation("I cannot complete the thorough repository audit in this exact response because no execution tool is attached to the current turn.")).toBe(true);
    expect(looksLikeConfabulation("I can’t conduct the remaining repository inspection in this response because this turn has no executable repository or shell tool attached.")).toBe(true);
    // OpenCode refusal phrases claiming tools returning NO CONTENT AVAILABLE or not operational
    expect(looksLikeConfabulation("All tool calls — `bash`, `shell`, `oc_bash`, `read`, `ls` — are returning `NO CONTENT AVAILABLE`. This indicates the OpenCode runtime tools (file system, shell execution) are not operational in the current execution environment.")).toBe(true);
    expect(looksLikeConfabulation("The OpenCode-native tools that the issue-autopilot skill requires are not being executed by the runtime — every call returns empty.\n\nNone of these are possible without a functioning shell tool.\n\nRun OpenCode in its native CLI context.")).toBe(true);
    // DeepLeo Phase 2 refusal phrases with inverted word order, embedded tool lists, and state adjectives
    expect(looksLikeConfabulation("I can’t continue the repository workflow from this interface because the required live execution tools, including `skill`, `question`, `task`, and file editing, are not currently enabled. Phase 2 has therefore not started, and I will not falsely claim that the required plan artefacts were created or approved.")).toBe(true);
    expect(looksLikeConfabulation("I can’t continue executing Phase 2 in this message because the current execution tool block is no longer available in the conversation. To proceed, send the next instruction with tools enabled.")).toBe(true);
    expect(looksLikeConfabulation("I can’t continue the Phase 2 execution from this turn because no execution tools are currently available in the message, so I can’t load the plan skill, inspect files, write plan artefacts, or ask approval via the required question tool.\n\nTo continue the workflow safely, re-run “Continue” in the tool-enabled execution context.")).toBe(true);
    expect(looksLikeConfabulation("I must decline to proceed since file editing tools are disabled on this host.")).toBe(true);
    expect(looksLikeConfabulation("Without an active shell tool provided in this turn, I cannot run tests.")).toBe(true);
    expect(looksLikeConfabulation("The required task and bash tools are unavailable in this environment.")).toBe(true);
    // Subagent premature truncation surrender
    expect(looksLikeConfabulation("I’m sorry, but I can’t complete the requested evidence report from the available material in this turn. The only retrieved output is truncated after line 264 and points to a second local file containing the full result. That omitted portion is precisely where the epic, PR diff, head-revision sources, and execution-path evidence are expected, so reporting findings now would risk inventing evidence.")).toBe(true);
    // Transitive provision verb: does not expose execution tools
    expect(looksLikeConfabulation("I can’t complete the live filesystem changes because this interface does not currently expose the repository execution tools needed to apply and verify the remaining edits. The persisted state proves only that task-2 was marked WIP and its progress artefact was created. The list_claims view, URL routes, verification commands, final coordination updates, and result artefact have not yet been completed.")).toBe(true);
    // Period inside filename .py within refusal clause
    expect(looksLikeConfabulation("I can’t continue Task 3 from this interface because the live repository tools required to edit src/dfnweb/tests/test_candidate_claim.py and run the MySQL-backed Django tests are not currently available.\nThe last verified state is:\n- Task 1: DONE\n- Task 2: DONE\n- Task 3: READY\n- Task 4: BLOCKED\n- Phase 2 IMPL: in progress\n- IMPL_GATE: not passed\n- No commit, push, or PR has occurred\nTask 3 still requires the endpoint regression suite and the transaction-capable concurrency test before the workflow can advance.")).toBe(true);
    // Failure to complete task due to apply_patch / executable not existing
    expect(looksLikeConfabulation("I’m sorry, but I couldn’t complete task-3. The verified live state remains:\n- Correct worktree: /home/lewis/Projects/dfn/dfn-meteorite-drone-webapp-124/webapp\n- Correct branch: feat-w-6-claim-endpoints-claim-release-list-124\n- Existing uncommitted task-1/task-2 changes remain in src/dfnweb/views/stage4_api.py and src/dfnweb/urls.py\n- task-3 remains READY\n- No files were modified by this task\n- No endpoint tests were added\n- No compile, Black, or focused Django tests were run\nThe concrete blocker was that the dedicated apply_patch tool resolved paths against the original repository worktree rather than the required issue-124 worktree, while no shell-level apply_patch executable exists.")).toBe(true);
    // Shell error diagnosis and deferred execution
    expect(looksLikeConfabulation("I’m sorry, but the verification workflow is incomplete. The latest live shell command failed immediately because status is a read-only variable in the active zsh environment:\nrun_check:6: read-only variable: status\nExit code: 1\nThis occurred inside the command wrapper before the required checks completed and before the VERIFY result artefacts were finalised. Any files or directories created before that point are partial evidence only and must not be treated as a completed review.\nCurrent truthful state:\n- VERIFY_GATE: Not evaluated\n- Phase 3 VERIFY: Pending\n- CRITICAL / HIGH / MEDIUM / LOW counts: Not finalised\n- Focused VERIFY test result: Not available\n- Post-VERIFY quality score: Not calculated\n- Phase 4 REFINE: Must not start\n- Application changes by QA: No verified application-file change\n- Commit, push, PR, REFINE, or full issue-autopilot CI: None performed\nThe next execution must replace the wrapper’s status variable with a non-reserved name such as rc, rerun all required checks, inspect any partial .agents/results/verify-evidence-* content, and only then update the session and gate artefacts.")).toBe(true);
    // Phase 0 preflight gate failure and stoppage deferral
    expect(looksLikeConfabulation(`The workflow stopped during Phase 0 preflight before modifying the repository. Provider authentication and issue retrieval succeeded, but the command failed before checking the current branch, updating main, or creating the isolated worktree.
Confirmed so far:
- Provider: GitLab
- CLI: glab, authenticated through a successful repository request
- Issue: #1, “Close file-download websocket connections when the transfer finishes (FD leak)”
- Issue state: open
- Label: Bug
- Worktree: not created
- Branch: not created
- No implementation, commit, push, PR, or issue comment was performed
Because the Phase 0 gate did not pass, I did not proceed to Phase 1.`)).toBe(true);
    // Provider creation / mutation refusals from interface
    expect(looksLikeConfabulation("I’m sorry, but I can’t continue with the live GitLab creation from this interface.")).toBe(true);
    expect(looksLikeConfabulation("I’m sorry, but I can’t perform live GitLab mutations from this interface.")).toBe(true);
    expect(looksLikeConfabulation("I’m sorry, but I can’t perform live GitLab mutations or update the local state.json in this interface.")).toBe(true);
    expect(looksLikeConfabulation("I’m sorry, but I can’t continue with GitLab mutations or file updates in this interface.")).toBe(true);
    // Review failure due to live command failing
    expect(looksLikeConfabulation("I couldn’t complete the review because the live GitLab command failed while retrieving MR !269 metadata, before any diff or linked issue data was returned.")).toBe(true);
    // Review surrender due to truncated output or available evidence
    expect(looksLikeConfabulation("I’m sorry, but I can’t complete an evidence-based review from the truncated output currently visible in this interface.")).toBe(true);
    expect(looksLikeConfabulation("I’m sorry, but I can’t provide the requested complete review from the evidence currently available in the conversation.")).toBe(true);
    expect(looksLikeConfabulation("I’m sorry, but I can’t complete a trustworthy, line-verified review from the available evidence in this response. The initial repository inspection succeeded, but its output was truncated before the exact current-head source and test details needed to validate findings twice, as requested.")).toBe(true);
    // Incomplete passes / premature exits
    expect(looksLikeConfabulation("The linking and annotation pass is still incomplete. The latest run successfully resolved the correct GitLab group ID (16257887) and verified epic 4, but it exited while validating the existing child issues, before any attachment, dependency-linking or body-annotation work was proven complete.")).toBe(true);
    expect(looksLikeConfabulation("The native epic and six issues were created, but the linking and annotation pass did not complete. The last verification used an incorrect hard-coded GitLab group ID, so it failed before it could safely attach, link and annotate the existing items.")).toBe(true);
    // Pending operations still need to be applied
    expect(looksLikeConfabulation("The missing operations still need to be applied idempotently to these existing records")).toBe(true);
    // Truthfulness / completion disclaimer
    expect(looksLikeConfabulation("I cannot truthfully claim that the following are finished")).toBe(true);
    // Generic refusal
    expect(looksLikeConfabulation("I’m sorry, but I can’t help with that.")).toBe(true);
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
