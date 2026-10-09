import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  deriveFencedSpec,
  renderFencedCall,
  parseFencedToolCalls,
  buildSpecMap,
  createProseStreamGate,
  formatFencedToolDefinitions,
  framingVariantForTone,
  isAdvisorTone,
  FRAMING_VARIANT_NAMES,
  findShellTool,
  nonShellTools,
  hostPlatformNote,
} from "./fenced.js";
import type { ToolDef } from "./tools.js";

const bash: ToolDef = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};
const readFile: ToolDef = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};
const writeFile: ToolDef = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
};
const editFile: ToolDef = {
  type: "function",
  function: {
    name: "edit_file",
    description: "Replace text.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
      required: ["path", "old", "new"],
    },
  },
};

const ALL = [bash, readFile, writeFile, editFile];
const specs = buildSpecMap(ALL);

describe("deriveFencedSpec", () => {
  it("maps a single-param tool's param to the body", () => {
    const s = deriveFencedSpec(readFile);
    expect(s.bodyParam).toBe("path");
    expect(s.headerParams).toEqual([]);
  });

  it("recognizes a named body param and keeps the rest as headers", () => {
    const s = deriveFencedSpec(writeFile);
    expect(s.bodyParam).toBe("content");
    expect(s.headerParams).toEqual(["path"]);
  });

  it("detects an old/new pair as a SEARCH/REPLACE edit", () => {
    const s = deriveFencedSpec(editFile);
    expect(s.editPair).toEqual({ search: "old", replace: "new" });
    expect(s.bodyParam).toBeUndefined();
    expect(s.headerParams).toEqual(["path"]);
  });
});

describe("renderFencedCall", () => {
  it("renders a body-only call with no header", () => {
    const out = renderFencedCall(deriveFencedSpec(bash), { command: "ls -la" });
    expect(out).toBe("```bash\nls -la\n```");
  });

  it("renders header + body separated by a blank line", () => {
    const out = renderFencedCall(deriveFencedSpec(writeFile), { path: "a.py", content: "print(1)" });
    expect(out).toBe("```write_file\npath: a.py\n\nprint(1)\n```");
  });

  it("renders an edit as SEARCH/REPLACE", () => {
    const out = renderFencedCall(deriveFencedSpec(editFile), { path: "a.py", old: "x", new: "y" });
    expect(out).toBe("```edit_file\npath: a.py\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n```");
  });
});

describe("parseFencedToolCalls", () => {
  function argsOf(text: string, n = 0) {
    const { calls } = parseFencedToolCalls(text, specs);
    return { calls, args: calls[n] ? JSON.parse(calls[n].function.arguments) : null };
  }

  it("parses a body-only bash call", () => {
    const { calls, args } = argsOf("```bash\nls -la\n```");
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("bash");
    expect(args).toEqual({ command: "ls -la" });
  });

  // Regression: M365 streams a code block's OPENING ``` as a *bare language label
  // line* (no backticks) and emits only the CLOSING ``` literally. Observed live
  // on a 61sol run (2026-10-09 06:39:47): the reconstructed text was
  // `…bounded.\nbash\n<commands>\n``` ` — no opener — so this parsed to 0 tool
  // calls and the turn silently degraded to prose (the model HAD fenced it).
  it("parses M365's label-only opener (bare `bash` line, no opening fence)", () => {
    const text = [
      "The first step is to inventory the inputs and read the grounding briefs. The commands below are read-only and keep output bounded.",
      "bash",
      "cd /home/lewis/Projects/cbc/cbcflow-portal || exit 1",
      "cat CONTEXT.md",
      "```",
    ].join("\n");
    const { calls, leftover } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("bash");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      command: "cd /home/lewis/Projects/cbc/cbcflow-portal || exit 1\ncat CONTEXT.md",
    });
    expect(leftover).toContain("The first step is to inventory");
  });

  // Regression (same class): M365 glues the opening fence to the end of the prose
  // line — `…output limit.```bash` — with no newline before it, so the opener is not
  // at line start and OPEN_FENCE_REGEX misses it. Observed live on the Stage-1
  // remediation turn (2026-10-09 07:42): the model HAD fenced it.
  it("parses M365's glued opener (```bash appended to the prose line)", () => {
    const text = [
      "I'll first read the remediation brief in full, then inventory and size all required inputs so subsequent reads stay complete and within the output limit.```bash",
      "timeout: 30000",
      "cat /tmp/opencode/review/REMEDIATION-BRIEF.md",
      "```",
    ].join("\n");
    const { calls, leftover } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("bash");
    expect(JSON.parse(calls[0].function.arguments).command).toContain("cat /tmp/opencode/review/REMEDIATION-BRIEF.md");
    expect(leftover).toContain("inventory and size all required inputs");
  });

  // Regression (same class): the CLOSING fence glued to the last command with trailing
  // text after it — `wc -l …DECISIONS.md```STATUS: blocked | …`. Observed live. Without
  // this the fence never closes and the trailing STATUS text is swallowed into the command.
  it("parses M365's glued closing fence (``` mid-line with trailing status text)", () => {
    const text = [
      "```bash",
      "wc -l /tmp/opencode/review/remediation/DECISIONS.md```STATUS: blocked | workflow interrupted",
    ].join("\n");
    const { calls, leftover } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments).command).toBe("wc -l /tmp/opencode/review/remediation/DECISIONS.md");
    expect(leftover).toContain("STATUS: blocked");
  });

  // Regression: the closing fence at LINE START with trailing text glued on (no space
  // after the backticks) — `head -n 500\n```STATUS: no files written …`. The earlier
  // mid-line guard (`indexOf > 0`) missed this because the fence is at index 0.
  it("parses M365's closing fence glued at line start (```STATUS: …)", () => {
    const text = [
      "```bash",
      "grep -RInE 'x' src tests 2>/dev/null | head -n 500",
      "```STATUS: no files written | Blocked before deliverable creation | shell execution unavailable",
    ].join("\n");
    const { calls, leftover } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments).command).toBe("grep -RInE 'x' src tests 2>/dev/null | head -n 500");
    expect(leftover).toContain("STATUS: no files written");
  });

  it("round-trips a write_file with a multi-line body", () => {
    const content = "def f():\n    return 1\n\nprint(f())";
    const rendered = renderFencedCall(deriveFencedSpec(writeFile), { path: "f.py", content });
    const { args } = argsOf(rendered);
    expect(args).toEqual({ path: "f.py", content });
  });

  it("round-trips an edit_file SEARCH/REPLACE", () => {
    const rendered = renderFencedCall(deriveFencedSpec(editFile), {
      path: "app.py",
      old: "debug = False",
      new: "debug = True",
    });
    const { args } = argsOf(rendered);
    expect(args).toEqual({ path: "app.py", old: "debug = False", new: "debug = True" });
  });

  it("parses a header body even without the blank separator", () => {
    const { args } = argsOf("```write_file\npath: f.py\nprint(1)\n```");
    expect(args).toEqual({ path: "f.py", content: "print(1)" });
  });

  it("ignores an illustration fence whose lang is not a tool", () => {
    const { calls, leftover } = parseFencedToolCalls("```python\nprint('hi')\n```", specs);
    expect(calls).toHaveLength(0);
    expect(leftover).toContain("print('hi')");
  });

  it("strips matched fences from leftover but keeps real prose", () => {
    const { calls, leftover } = parseFencedToolCalls("Here you go:\n```bash\nls\n```", specs);
    expect(calls).toHaveLength(1);
    expect(leftover).toContain("Here you go");
    expect(leftover).not.toContain("ls\n```");
  });

  it("parses multiple fenced calls", () => {
    const { calls } = parseFencedToolCalls("```read_file\na\n```\n```read_file\nb\n```", specs);
    expect(calls).toHaveLength(2);
  });

  it("drops an edit fence missing SEARCH/REPLACE markers", () => {
    const { calls } = parseFencedToolCalls("```edit_file\npath: a.py\njust some text\n```", specs);
    expect(calls).toHaveLength(0);
  });

  it("handles a body that contains colon-prefixed lines (not misread as headers)", () => {
    const content = "note: this is body text\nmore: lines";
    const rendered = renderFencedCall(deriveFencedSpec(writeFile), { path: "n.txt", content });
    const { args } = argsOf(rendered);
    expect(args.content).toBe(content);
  });

  it("parses a bash script with a heredoc containing nested markdown code fences without premature closing", () => {
    const script = `\`\`\`bash
set -euo pipefail
cd /home/lewis/Projects/gwdc/gwcloud_bilby-44
cat >> docs/gwflow-runbook.md <<'ENDRUNBOOK'

## Cron Deployment

Deploy from the ingest checkout on gwcloud:

\`\`\`bash
cd /opt/gwcloud_bilby_gwosc_ingest
git fetch origin
git status --short --branch
cd gwflow_cron
bash build_docker.sh
\`\`\`

Create persistent host paths:

\`\`\`bash
sudo mkdir -p /opt/staging
sudo touch /opt/log.log
\`\`\`

ENDRUNBOOK
test -s docs/gwflow-runbook.md
grep -q "Cron Deployment" docs/gwflow-runbook.md
\`\`\``;

    const { calls, leftover } = parseFencedToolCalls(script, specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("bash");
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.command).toContain("cat >> docs/gwflow-runbook.md <<'ENDRUNBOOK'");
    expect(args.command).toContain("ENDRUNBOOK");
    expect(args.command).toContain("test -s docs/gwflow-runbook.md");
    expect(leftover.trim()).toBe("");
  });

  it("parses quad-backtick fences enclosing triple-backticks (CommonMark)", () => {
    const text = `\`\`\`\`write_file
path: docs/guide.md

# Guide
Here is some code:
\`\`\`bash
echo "hello"
\`\`\`
\`\`\`\``;

    const { calls, leftover } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("write_file");
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.path).toBe("docs/guide.md");
    expect(args.content).toContain('```bash\necho "hello"\n```');
    expect(leftover.trim()).toBe("");
  });

  it("parses a question tool with JSON array body as an array, not a string", () => {
    const questionTool: ToolDef = {
      type: "function",
      function: {
        name: "question",
        description: "Ask the user questions.",
        parameters: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  question: { type: "string" },
                  options: { type: "array", items: { type: "string" } },
                  multiple: { type: "boolean" },
                },
              },
            },
          },
          required: ["questions"],
        },
      },
    };
    const localSpecs = buildSpecMap([questionTool]);
    const input = `\`\`\`question
[
  {
    "question": "Which workflow?",
    "options": ["A", "B"],
    "multiple": false
  }
]
\`\`\``;

    const { calls } = parseFencedToolCalls(input, localSpecs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("question");
    const args = JSON.parse(calls[0].function.arguments);
    expect(Array.isArray(args.questions)).toBe(true);
    expect(args.questions[0].question).toBe("Which workflow?");
    expect(args.questions[0].header).toBe("Which workflow?");
    expect(args.questions[0].options).toEqual([
      { label: "A", description: "A" },
      { label: "B", description: "B" },
    ]);
  });
});

describe("shell routing (Tier 1)", () => {
  const runCommand: ToolDef = {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };

  it("detects a shell tool under various names", () => {
    expect(findShellTool([bash])?.function.name).toBe("bash");
    expect(findShellTool([runCommand])?.function.name).toBe("run_command");
    expect(findShellTool([readFile, writeFile])).toBeUndefined();
  });

  it("routes a ```bash block to a differently-named shell tool", () => {
    const specs = buildSpecMap([runCommand, readFile]);
    const { calls } = parseFencedToolCalls("```bash\nsed -i 's/a/b/' f.py\n```", specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("run_command");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: "sed -i 's/a/b/' f.py" });
  });

  it("routes ```sh and ```shell aliases too", () => {
    const specs = buildSpecMap([runCommand]);
    expect(parseFencedToolCalls("```sh\nls\n```", specs).calls[0]?.function.name).toBe("run_command");
    expect(parseFencedToolCalls("```shell\nls\n```", specs).calls[0]?.function.name).toBe("run_command");
  });

  it("routes leaked container.* runtime aliases to the harness shell tool", () => {
    const specs = buildSpecMap([runCommand]);
    const { calls } = parseFencedToolCalls("```container.exec\nls -la\n```", specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("run_command");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: "ls -la" });
  });

  it("leaves a dotted/hyphenated info-string that is not a tool in prose", () => {
    // Widening the fence regex to allow . and - must not turn language tags into calls.
    const specs = buildSpecMap([runCommand]);
    expect(parseFencedToolCalls("```objective-c\nint x;\n```", specs).calls).toHaveLength(0);
    expect(parseFencedToolCalls("```asp.net\n<%= x %>\n```", specs).calls).toHaveLength(0);
  });

  it("does not hijack ```bash when a real tool is literally named bash", () => {
    // bash tool present → ```bash maps to it directly (not via alias), name stays bash
    const specs = buildSpecMap([bash, readFile]);
    expect(parseFencedToolCalls("```bash\nls\n```", specs).calls[0]?.function.name).toBe("bash");
  });

  // #7: these were silently demoted to prose, so a model correctly told to use
  // PowerShell produced turns that executed nothing.
  it("routes Windows shell fences to the harness shell tool", () => {
    const specs = buildSpecMap([runCommand]);
    for (const lang of ["powershell", "pwsh", "ps1", "cmd", "bat", "batch"]) {
      const { calls } = parseFencedToolCalls("```" + lang + "\nGet-ChildItem\n```", specs);
      expect(calls, `${lang} should route`).toHaveLength(1);
      expect(calls[0].function.name).toBe("run_command");
      expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: "Get-ChildItem" });
    }
  });
});

describe("nonShellTools", () => {
  const runCommand: ToolDef = {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const shell: ToolDef = {
    type: "function",
    function: {
      name: "shell",
      description: "Run a shell command.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };
  const task: ToolDef = {
    type: "function",
    function: {
      name: "task",
      description: "Spawn a subagent.",
      parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    },
  };

  it("filters shell aliases and passes non-shell tools through without mutating input", () => {
    const input = [bash, runCommand, shell, readFile, writeFile, task];
    const out = nonShellTools(input);
    expect(out.map((t) => t.function.name)).toEqual(["read_file", "write_file", "task"]);
    expect(input.map((t) => t.function.name)).toEqual([
      "bash",
      "run_command",
      "shell",
      "read_file",
      "write_file",
      "task",
    ]);
    expect(out).not.toBe(input);
  });
});

describe("hostPlatformNote", () => {
  it("is empty off Windows, so POSIX framing stays byte-for-byte", () => {
    expect(hostPlatformNote(bash, "linux")).toBe("");
    expect(hostPlatformNote(bash, "darwin")).toBe("");
    expect(formatFencedToolDefinitions([bash, readFile])).not.toContain("HOST PLATFORM");
  });

  it("is empty on Windows when the harness gave no shell tool", () => {
    expect(hostPlatformNote(undefined, "win32")).toBe("");
  });

  it("names the platform and overrides every POSIX idiom the framing teaches", () => {
    const note = hostPlatformNote(bash, "win32");
    expect(note).toContain("HOST PLATFORM: Windows");
    expect(note).toContain("```powershell");
    // The specific idioms baseline framing teaches by name must be countermanded.
    for (const posix of ["EOF", "sed -i", "ls", "grep"]) {
      expect(note, `${posix} should be countermanded`).toContain(posix);
    }
    expect(note).toContain("Set-Content");
    expect(note).toContain("Get-ChildItem");
    expect(note).toContain("Select-String");
    // #12: the sandbox the model drifts to when POSIX commands fail.
    expect(note).toContain("/mnt/data");
  });

  it("names the harness's own shell tool rather than assuming `bash`", () => {
    const shell: ToolDef = {
      type: "function",
      function: {
        name: "run_terminal_cmd",
        description: "Run a command.",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    };
    expect(hostPlatformNote(shell, "win32")).toContain("`run_terminal_cmd`");
  });
});

describe("formatFencedToolDefinitions", () => {
  it("lists each non-shell tool as a fenced template inside <tools> with advisor framing", () => {
    const out = formatFencedToolDefinitions(ALL);
    expect(out).toContain("<tools>");
    // The header example legitimately contains ```bash, so assert the shell tool's
    // own <tools> entry (its description) is elided instead.
    expect(out).not.toContain("Run a shell command.");
    expect(out).toContain("```write_file");
    expect(out).toContain("<<<<<<< SEARCH");
    expect(out).toContain("You are a chat assistant helping with shell tasks");
    expect(out).toContain("a single fenced code block opened with the word bash or shell");
    expect(out).not.toContain("execution core");
    expect(out).not.toContain("TOOL USE IS REQUIRED");
  });

  it("elides the shell tool from <tools> for shell-only and mixed toolsets (C6)", () => {
    const shellOnly = formatFencedToolDefinitions([bash]);
    expect(shellOnly).not.toContain("<tools>");
    expect(shellOnly).not.toContain("Run a shell command.");

    const mixed = formatFencedToolDefinitions([bash, readFile, writeFile]);
    expect(mixed).toContain("<tools>");
    expect(mixed).toContain("```write_file");
    expect(mixed).not.toContain("Run a shell command.");
  });

  it("always includes the inline shell header example with params", () => {
    const bashWithHeaders: ToolDef = {
      type: "function",
      function: {
        name: "bash",
        description: "Run a shell command.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeout: { type: "number" },
            workdir: { type: "string" },
          },
          required: ["command"],
        },
      },
    };

    for (const out of [formatFencedToolDefinitions([bashWithHeaders]), formatFencedToolDefinitions([bash])]) {
      expect(out).toContain("The block may start with optional header lines");
      expect(out).toContain("timeout: 30000");
      expect(out).toContain("workdir: /path/to/dir");
    }
  });

  it("derives task tool spec with prompt body and parses multiline prompt body correctly", () => {
    const taskTool: ToolDef = {
      type: "function",
      function: {
        name: "task",
        description: "Spawn a subagent to run tasks.",
        parameters: {
          type: "object",
          properties: {
            description: { type: "string" },
            subagent_type: { type: "string" },
            prompt: { type: "string" },
          },
          required: ["description", "prompt"],
        },
      },
    };

    const taskSpec = deriveFencedSpec(taskTool);
    expect(taskSpec.bodyParam).toBe("prompt");
    expect(taskSpec.headerParams).toEqual(["description", "subagent_type"]);

    const specs = buildSpecMap([taskTool]);
    const input = `\`\`\`task
description: ultrawork-phase1-pm-plan-review
subagent_type: general

You are the PM Agent for ultrawork Phase 1 PLAN, Steps 1-4.
Please review the plan and produce the task board.
\`\`\``;

    const { calls, leftover } = parseFencedToolCalls(input, specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("task");
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.description).toBe("ultrawork-phase1-pm-plan-review");
    expect(args.subagent_type).toBe("general");
    expect(args.prompt).toContain("You are the PM Agent for ultrawork Phase 1 PLAN, Steps 1-4.");
    expect(args.prompt).toContain("Please review the plan and produce the task board.");
    expect(leftover.trim()).toBe("");
  });

  it("parses code fences when the closing fence has inline trailing prose", () => {
    const bashToolWithHeaders: ToolDef = {
      type: "function",
      function: {
        name: "bash",
        description: "Run shell command",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            cwd: { type: "string" },
            timeout: { type: "number" },
          },
          required: ["command"],
        },
      },
    };
    const localSpecs = buildSpecMap([bashToolWithHeaders]);

    const text = `\`\`\`bash
timeout: 30
cwd: /home/lewis/Projects/gwdc/gwcloud_bilby

glab issue list --state opened -R CAS-eResearch/GWDC/gwcloud_bilby 2>&1
\`\`\` in this session. Let me try the \`oc_bash\` tool:oc_bash
timeout: 30
cwd: /home/lewis/Projects/gwdc/gwcloud_bilby

glab issue list --state opened -R CAS-eResearch/GWDC/gwcloud_bilby 2>&1
\`\`\` correctly. Let me fix that.`;

    const { calls } = parseFencedToolCalls(text, localSpecs);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].function.name).toBe("bash");
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.command.trim()).toBe("glab issue list --state opened -R CAS-eResearch/GWDC/gwcloud_bilby 2>&1");
    expect(args.cwd).toBe("/home/lewis/Projects/gwdc/gwcloud_bilby");
    expect(args.timeout).toBe(30);
  });

  it("normalizes todowrite calls missing priority or id", () => {
    const todoTool: ToolDef = {
      type: "function",
      function: {
        name: "todowrite",
        description: "Write or update todos.",
        parameters: {
          type: "object",
          properties: {
            todos: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  content: { type: "string" },
                  status: { type: "string" },
                  priority: { type: "string" },
                },
                required: ["id", "content", "status", "priority"],
              },
            },
          },
          required: ["todos"],
        },
      },
    };

    const todoSpec = deriveFencedSpec(todoTool);
    expect(todoSpec.bodyParam).toBe("todos");

    const specs = buildSpecMap([todoTool]);
    const input = `\`\`\`todowrite
[
  {
    "id": "1",
    "content": "Review GitLab issues 30-46",
    "status": "in_progress"
  },
  {
    "content": "Create task board and ship gates"
  }
]
\`\`\``;

    const { calls } = parseFencedToolCalls(input, specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("todowrite");
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.todos).toHaveLength(2);
    expect(args.todos[0]).toEqual({
      id: "1",
      content: "Review GitLab issues 30-46",
      status: "in_progress",
      priority: "medium",
    });
    expect(args.todos[1]).toEqual({
      id: "2",
      content: "Create task board and ship gates",
      status: "pending",
      priority: "medium",
    });
  });

  it("parses an unclosed tool fence at EOF (stream ends before closing backticks)", () => {
    const text = `Now writing the design doc:
\`\`\`bash
python3 << 'PYEOF'
from pathlib import Path
Path("design.md").write_text("Hello World")
PYEOF`;

    const { calls, leftover } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("bash");
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.command).toContain("Path(\"design.md\").write_text(\"Hello World\")");
    expect(leftover.trim()).toBe("Now writing the design doc:");
  });

  it("sanitizes trailing model stop tags (</parameter></invoke>) on unclosed tool fence at EOF", () => {
    const text = `\`\`\`bash
python3 << 'PYEOF'
print("SAVED")
PYEOF</parameter>
</invoke>`;

    const { calls } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.command).toBe("python3 << 'PYEOF'\nprint(\"SAVED\")\nPYEOF");
  });

  it("parses consecutive tool fences emitted back-to-back without closing backticks", () => {
    const text = `\`\`\`bash
git remote get-url origin
\`\`\`bash
echo test && git remote get-url origin
\`\`\``;

    const { calls } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].function.arguments).command).toBe("git remote get-url origin");
    expect(JSON.parse(calls[1].function.arguments).command).toBe("echo test && git remote get-url origin");
  });

  it("does not split nested markdown fences inside an active heredoc", () => {
    const text = `\`\`\`bash
cat << 'EOF' > README.md
# Project
\`\`\`bash
npm start
\`\`\`
EOF
\`\`\``;

    const { calls } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.command).toContain("# Project");
    expect(args.command).toContain("npm start");
  });
});





describe("advisor framing", () => {
  const TOOLS = [bash, readFile];

  it("frames the model as a chat assistant that writes commands, not an executor", () => {
    const out = formatFencedToolDefinitions(TOOLS);
    expect(out).toContain("You are a chat assistant helping with shell tasks");
    expect(out).toContain("a single fenced code block opened with the word bash or shell");
    expect(out).toContain("I run it and paste the real output back");
    // still presents the non-shell tools + shell idiom so the fences route
    expect(out).toContain("<tools>");
    expect(out).toContain("```bash");
  });

  it("omits every agentic pressure that makes Astra refuse", () => {
    const out = formatFencedToolDefinitions(TOOLS);
    for (const banned of [
      "execution core",
      "real shell",
      "TOOL USE IS REQUIRED",
      "PRIMARY JOB",
      "automated agent",
      "runtime",
    ]) {
      expect(out, `advisor must not contain "${banned}"`).not.toContain(banned);
    }
  });

  it("is registered as the universal variant", () => {
    expect(FRAMING_VARIANT_NAMES).toEqual(["advisor"]);
  });
});

describe("framingVariantForTone", () => {
  it("returns advisor for all tones universally", () => {
    expect(framingVariantForTone("Gpt_6_Astra")).toBe("advisor");
    expect(framingVariantForTone("Gpt_5_6_Reasoning")).toBe("advisor");
    expect(framingVariantForTone("Gpt_5_5_Reasoning")).toBe("advisor");
    expect(framingVariantForTone("magic")).toBe("advisor");
    expect(framingVariantForTone("Claude_Sonnet")).toBe("advisor");
  });
});

describe("createProseStreamGate (design 002 §3.2)", () => {
  it("streams each delta eagerly at token granularity (no line buffering)", () => {
    const gate = createProseStreamGate(specs);
    expect(gate.push("Hello")).toBe("Hello");
    expect(gate.push(", ")).toBe(", ");
    expect(gate.push("world")).toBe("world");
    expect(gate.sealed).toBe(false);
  });

  it("seals on a known tool fence and emits nothing after seal", () => {
    const gate = createProseStreamGate(specs);
    expect(gate.push("Let me check:\n")).toBe("Let me check:\n");
    expect(gate.push("```bash\n")).toBe("");
    expect(gate.sealed).toBe(true);
    expect(gate.push("ls -la\n")).toBe("");
    expect(gate.push("```\n")).toBe("");
  });

  it("does NOT seal on an unknown fence (```python) — keeps streaming it", () => {
    const gate = createProseStreamGate(specs);
    expect(gate.push("Example:\n")).toBe("Example:\n");
    expect(gate.push("```python\n")).toBe("```python\n");
    expect(gate.push("print('hi')\n")).toBe("print('hi')\n");
    expect(gate.push("```\n")).toBe("```\n");
    expect(gate.sealed).toBe(false);
  });

  it("reconstitutes exactly the pre-fence prefix", () => {
    const gate = createProseStreamGate(specs);
    let out = "";
    out += gate.push("Here you go");
    out += gate.push(":\n");
    out += gate.push("```bash\n");
    out += gate.push("ls\n```");
    const prefix = "Here you go:\n";
    expect(out).toBe(prefix);
    expect(gate.sealed).toBe(true);
  });

  it("streams a partial opener split across deltas, then seals (accepted leak)", () => {
    const gate = createProseStreamGate(specs);
    expect(gate.push("``")).toBe("``");
    expect(gate.push("`bash\n")).toBe("");
    expect(gate.sealed).toBe(true);
    expect(gate.push("ls\n")).toBe("");
  });

  it("seals only at the first tool fence, not on earlier prose fences", () => {
    const gate = createProseStreamGate(specs);
    let out = "";
    out += gate.push("A ```python block, then a real one:\n");
    out += gate.push("```bash\n");
    expect(out).toBe("A ```python block, then a real one:\n");
    expect(gate.sealed).toBe(true);
  });
});

describe("isAdvisorTone", () => {
  it("returns true for all tones universally", () => {
    expect(isAdvisorTone("Gpt_6_Astra")).toBe(true);
    expect(isAdvisorTone("Gpt_5_6_Reasoning")).toBe(true);
    expect(isAdvisorTone("gpt_6_astra")).toBe(true);
    expect(isAdvisorTone("GPT_6_ASTRA")).toBe(true);
    expect(isAdvisorTone("Gpt_5_5_Reasoning")).toBe(true);
    expect(isAdvisorTone("magic")).toBe(true);
    expect(isAdvisorTone("Claude_Sonnet")).toBe(true);
    expect(isAdvisorTone()).toBe(true);
  });
});
