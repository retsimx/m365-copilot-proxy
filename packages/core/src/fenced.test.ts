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
  findShellTool,
  hostPlatformNote,
} from "./fenced.js";
import { parseToolCalls } from "./tools.js";
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

// The <tools> block must document the harness's OWN parameter name and must accept the
// other harnesses' spelling as a header alias. Regression: the block hardcoded `filePath`
// (pi's name) while OpenCode v2 declares `path` — every native `read`/`write`/`edit` fence
// emitted as instructed then failed schema validation (read → `{}`, write leaked the header
// into the body). Bug 20261018.
describe("cross-harness file parameter names", () => {
  const T = (name: string, props: Record<string, { type: string }>, req: string[]): ToolDef => ({
    type: "function", function: { name, description: "d", parameters: { type: "object", properties: props, required: req } },
  });
  // OpenCode v2 schemas (verified against the opencode binary).
  const opencode = [
    T("read", { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, ["path"]),
    T("write", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
    T("edit", { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" }, replaceAll: { type: "boolean" } }, ["path", "oldString", "newString"]),
    T("bash", { command: { type: "string" }, workdir: { type: "string" }, timeout: { type: "number" } }, ["command"]),
  ];
  const pi = [
    T("read", { filePath: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, ["filePath"]),
    T("write", { filePath: { type: "string" }, content: { type: "string" } }, ["filePath", "content"]),
    T("edit", { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, ["filePath", "oldString", "newString"]),
  ];
  const argsOf = (r: { calls: { function: { arguments: string } }[] }) =>
    JSON.parse(r.calls[0].function.arguments);

  it("documents OpenCode's `path`, never a hardcoded `filePath`", () => {
    const out = formatFencedToolDefinitions("agent", opencode);
    expect(out).toContain("path: <the file to read>");
    expect(out).toContain("path: <the file to create or replace>");
    expect(out).toContain("path: <the file to change>");
    expect(out).toContain("`path` is required");
    expect(out).not.toContain("filePath");
  });

  it("documents pi's `filePath` when that is the declared name", () => {
    const out = formatFencedToolDefinitions("agent", pi);
    expect(out).toContain("filePath: <the file to read>");
    expect(out).toContain("`filePath` is required");
    expect(out).not.toContain("path: <the file to read>");
  });

  it("maps an aliased `filePath:` header onto the harness's `path` param", () => {
    const r = parseFencedToolCalls("```read\nfilePath: /etc/hostname\n```", buildSpecMap(opencode));
    expect(r.calls).toHaveLength(1);
    expect(argsOf(r)).toEqual({ path: "/etc/hostname" });
  });

  it("write: an aliased path header is not leaked into the file body", () => {
    const r = parseFencedToolCalls("```write\nfilePath: a.txt\n\nprint(1)\n```", buildSpecMap(opencode));
    expect(argsOf(r)).toEqual({ path: "a.txt", content: "print(1)" });
  });

  it("edit: aliased path + replaceAll header with SEARCH/REPLACE body", () => {
    const r = parseFencedToolCalls(
      "```edit\nfilePath: a.py\nreplaceAll: true\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE\n```",
      buildSpecMap(opencode),
    );
    expect(argsOf(r)).toEqual({ path: "a.py", replaceAll: true, oldString: "old", newString: "new" });
  });

  it("accepts the reverse alias: a `path:` header against a pi-shaped `filePath` schema", () => {
    const r = parseFencedToolCalls("```read\npath: /x\n```", buildSpecMap(pi));
    expect(argsOf(r)).toEqual({ filePath: "/x" });
  });

  it("single-param file tool: an aliased header fills the body param without an empty-body clobber", () => {
    const tools = [T("read", { path: { type: "string" } }, ["path"])];
    const r = parseFencedToolCalls("```read\nfilePath: /x\n```", buildSpecMap(tools));
    expect(argsOf(r)).toEqual({ path: "/x" });
  });

  it("does not alias an unrelated key onto the file param", () => {
    const r = parseFencedToolCalls("```read\nnonsense: /x\n```", buildSpecMap(opencode));
    expect(argsOf(r)).toEqual({});
  });

  it("interpolates the harness's shell tool name into the grounding call", () => {
    const tools = [T("run_command", { command: { type: "string" } }, ["command"])];
    const out = formatFencedToolDefinitions("agent", tools);
    expect(out).toContain("```run_command\npwd && whoami && uname -srm && ls -la .\n```");
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

  it("parses an edit whose SEARCH/REPLACE body contains a ``` fence", () => {
    const specMap = buildSpecMap([editFile]);
    const text = "```edit_file\npath: /x/f.ts\n<<<<<<< SEARCH\nold ```bash\ncode\n```\n=======\nnew\n>>>>>>> REPLACE\n```";
    const { calls } = parseFencedToolCalls(text, specMap);
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.path).toBe("/x/f.ts");
    expect(args.old).toContain("old");
    expect(args.new).toContain("new");
  });

  it("parses a fence between two prose runs and keeps the prose after it", () => {
    const text = "I'll read the file first.\n\n```bash\ncat counter.txt\n``` — then I'll update it.";
    const { calls, leftover } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: "cat counter.txt" });
    expect(leftover).toContain("I'll read the file first.");
    expect(leftover).toContain("then I'll update it."); // prose glued after the closing fence
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

  // Regression: exact live shape from a verification turn — prose with the opening fence
  // glued straight on (`…contracts.```bash`) and no blank line.
  it("parses the glued opener on a verification turn (prose.```bash)", () => {
    const text = [
      "I'll verify structural conformance and inspect the live model/migration conventions behind the highest-risk contracts.```bash",
      "cd /home/lewis/Projects/cbc/cbcflow-portal",
      "printf '%s\\n' '=== REQUIRED SECTION AUDIT ==='",
      "```",
    ].join("\n");
    const { calls, leftover } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("bash");
    expect(leftover).toContain("verify structural conformance");
  });

  // Same glued opener, but the block is never closed (no closing fence at all).
  it("parses a glued opener whose block is unterminated (EOF)", () => {
    const text = [
      "I'll verify structural conformance and inspect the live conventions.```bash",
      "cd /home/lewis/Projects/cbc/cbcflow-portal",
      "grep -RnsE 'class Analysis' src/apps/registry/models",
    ].join("\n");
    const { calls } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("bash");
    expect(JSON.parse(calls[0].function.arguments).command).toContain("grep -RnsE");
  });

  // Regression: M365 escapes `]:` as `\]：`... i.e. injects a backslash before `]` when it
  // looks like a Markdown link reference (`…]:`). The harness ran it literally — bash
  // "bad substitution", Python "unexpected character after line continuation character".
  // Live shapes from the remediation consistency-check turns.
  it("unescapes M365's link-ref escape `\\]:` -> `]:` in a bash body", () => {
    const text = [
      "```bash",
      'for f in "${files[@\\]:1}"; do test -s "$f"; done',
      "```",
    ].join("\n");
    const { calls } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].function.arguments).command).toBe(
      'for f in "${files[@]:1}"; do test -s "$f"; done',
    );
  });

  it("unescapes `\\]:` in a Python dict body", () => {
    const text = [
      "```bash",
      'python3 -c "ids={f["key"\\]:f"CF-{i}" for i,f in enumerate(F,1)}"',
      "```",
    ].join("\n");
    const { calls } = parseFencedToolCalls(text, specs);
    expect(JSON.parse(calls[0].function.arguments).command).toBe(
      'python3 -c "ids={f["key"]:f"CF-{i}" for i,f in enumerate(F,1)}"',
    );
  });

  it("leaves a legitimate `\\]` (no colon) untouched, e.g. a regex class", () => {
    const text = ["```bash", "grep -E '[\\]]' file.txt", "```"].join("\n");
    const { calls } = parseFencedToolCalls(text, specs);
    expect(JSON.parse(calls[0].function.arguments).command).toBe("grep -E '[\\]]' file.txt");
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

  // Regression: the mid-line "glued closing fence" fix-up (restoreM365Fences Pass 2)
  // must not mistake a ``` INSIDE a quoted shell argument for a closing fence. Live
  // 2026-10-12 19:07:43Z (cid c3f86119): the model verified a report with
  // `grep -q '```suggestion' "$OUT"`. Pass 2 split the line at the quoted backticks,
  // the parser closed the block there, and the post-fence guard aborted the turn —
  // the harness ran a command truncated at `grep -q '` and bash reported
  // "unexpected EOF while looking for matching `'`".
  it("does not treat ``` inside a quoted shell argument as a closing fence", () => {
    const text = [
      "I'll verify the complete artefact before finalising.",
      "```bash",
      "set -euo pipefail",
      "OUT='/tmp/report.md'",
      "grep -q 'src/apps/registry/models/contributors.py:8' \"$OUT\"",
      "grep -q '```suggestion' \"$OUT\"",
      "printf 'verified: %s bytes\\n' \"$(wc -c < \"$OUT\")\"",
      "```",
    ].join("\n");
    const { calls, leftover } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.command).toContain("grep -q '```suggestion' \"$OUT\"");
    expect(args.command).toContain("printf 'verified: %s bytes");
    expect(leftover).not.toContain("suggestion");
  });

  // Same class, double-quoted argument: a ``` inside "…" is data too.
  it("does not treat ``` inside a double-quoted shell argument as a closing fence", () => {
    const text = [
      "```bash",
      "grep -q \"```lang\" file.txt",
      "test -s file.txt",
      "```",
    ].join("\n");
    const { calls } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.command).toBe("grep -q \"```lang\" file.txt\ntest -s file.txt");
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

describe("hostPlatformNote", () => {
  it("is empty off Windows, so POSIX framing stays byte-for-byte", () => {
    expect(hostPlatformNote("linux")).toBe("");
    expect(hostPlatformNote("darwin")).toBe("");
    expect(formatFencedToolDefinitions()).not.toContain("HOST PLATFORM");
  });

  it("names the platform and overrides every POSIX idiom the framing teaches", () => {
    const note = hostPlatformNote("win32");
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

  it("names `bash` (our only tool)", () => {
    expect(hostPlatformNote("win32")).toContain("`bash`");
  });
});

describe("formatFencedToolDefinitions", () => {
  it("emits the bash fence + shell example + <tool_output> schema (bash-only, no <tools> block)", () => {
    const out = formatFencedToolDefinitions();
    expect(out).toContain("You are a chat assistant helping with shell tasks, working toward the whole task stated in the user's request");
    expect(out).toContain("a single fenced block opened with the word bash (or shell) containing the commands for that step");
    expect(out).toContain("<tool_output>");
    expect(out).toContain("```bash");
    expect(out).toContain("The block may start with optional header lines before the commands");
    expect(out).not.toContain("<tools>"); // bash-only: no tool-template block
    expect(out).not.toContain("```read_file");
    expect(out).not.toContain("Run a shell command.");
    expect(out).not.toContain("execution core");
    expect(out).not.toContain("TOOL USE IS REQUIRED");
  });

  it("shows the optional timeout/workdir header example", () => {
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

    const out = formatFencedToolDefinitions();
    expect(out).toContain("optional header lines");
    expect(out).toContain("timeout: 30000");
    expect(out).toContain("workdir: /path/to/dir");
  });

  it("Claude variant (agent) declares read/write/edit + bash, with message-boundary + routing", () => {
    const T = (name: string, props: Record<string, unknown>, req: string[]): ToolDef => ({
      type: "function", function: { name, description: "d", parameters: { type: "object", properties: props, required: req } },
    });
    const tools = [
      T("read", { filePath: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, ["filePath"]),
      T("write", { filePath: { type: "string" }, content: { type: "string" } }, ["filePath", "content"]),
      T("edit", { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, ["filePath", "oldString", "newString"]),
      T("bash", { command: { type: "string" }, timeout: { type: "number" }, workdir: { type: "string" } }, ["command"]),
    ];
    const out = formatFencedToolDefinitions("agent", tools);
    expect(out).toContain("You are an execution agent working toward the user's whole objective");
    expect(out).toContain("MESSAGE BOUNDARY");
    expect(out).toContain("A `<tool_output>` block is written only by the harness");
    expect(out).toContain("Choose the tool that performs the step safely and clearly");
    expect(out).toContain("they are NOT calls");
    expect(out).not.toContain("ENTIRE filesystem");
    expect(out).not.toContain("anthropic_function_calls"); // full native-XML example removed
    expect(out).not.toContain("You have no code interpreter, sandbox, canvas");
    expect(out).not.toContain('<tool_output name="read">'); // no return-side example
    expect(out).toContain("<tools>");
    expect(out).toContain("```read");
    expect(out).toContain("```write");
    expect(out).toContain("```edit");
    expect(out).toContain("```bash");
  });

  it("agent framing: one call per turn, fence hygiene, TURN ZERO, anti-fabrication", () => {
    const T = (name: string, props: Record<string, unknown>, req: string[]): ToolDef => ({
      type: "function", function: { name, description: "d", parameters: { type: "object", properties: props, required: req } },
    });
    const tools = [T("bash", { command: { type: "string" }, workdir: { type: "string" } }, ["command"])];
    const out = formatFencedToolDefinitions("agent", tools);
    // one call per turn + density inside one call
    expect(out).toContain("Emit exactly ONE tool-call fence per turn");
    expect(out).toContain("Never emit a second tool fence in the same turn");
    expect(out).toContain("Make the single call substantial but coherent");
    // turn efficiency (gather a complete evidence set per read-only call)
    expect(out).toContain("Minimise unnecessary turns. Gather a complete evidence set");
    // fence hygiene (the anti-malformation anchors)
    expect(out).toContain("Never omit the backticks, never write the tool name inline with a sentence");
    // turn-zero epistemic statement + grounding
    expect(out).toContain("TURN ZERO: You have run nothing");
    expect(out).toContain("pwd && whoami && uname -srm && ls -la .");
    // anti-fabrication
    expect(out).toContain("YOU KNOW NOTHING ABOUT THE USER'S MACHINE UNTIL THE HARNESS SHOWS IT TO YOU");
    expect(out).toContain("a path named in the task");
    expect(out).toContain("CALL A TOOL AND READ THE REAL OBSERVATION");
    // no leftover multi-call / batching language
    expect(out).not.toContain("batch independent calls");
    expect(out).not.toContain("genuinely independent calls");
    expect(out).not.toContain("closing fence of the last call");
    expect(out).not.toContain("only whitespace between their fences");
  });

  it("advisor framing is unchanged by the agent-path changes", () => {
    const T = (name: string, props: Record<string, unknown>, req: string[]): ToolDef => ({
      type: "function", function: { name, description: "d", parameters: { type: "object", properties: props, required: req } },
    });
    const tools = [T("bash", { command: { type: "string" } }, ["command"])];
    const adv = formatFencedToolDefinitions("advisor", tools);
    expect(adv).toContain("You are a chat assistant helping with shell tasks");
    // none of the agent-only additions leaked in
    expect(adv).not.toContain("You are an execution agent working toward");
    expect(adv).not.toContain("Emit exactly ONE tool-call fence per turn");
    expect(adv).not.toContain("YOU KNOW NOTHING ABOUT THE USER'S MACHINE");
    expect(adv).not.toContain("TURN ZERO");
    expect(adv).not.toContain("MESSAGE BOUNDARY");
  });

  it("indented file-tool documentation in the <tools> block is not parsed as a call", () => {
    const T = (name: string, props: Record<string, unknown>, req: string[]): ToolDef => ({
      type: "function", function: { name, description: "d", parameters: { type: "object", properties: props, required: req } },
    });
    const tools = [
      T("read", { filePath: { type: "string" } }, ["filePath"]),
      T("write", { filePath: { type: "string" }, content: { type: "string" } }, ["filePath", "content"]),
      T("edit", { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, ["filePath", "oldString", "newString"]),
      T("bash", { command: { type: "string" }, workdir: { type: "string" } }, ["command"]),
    ];
    const out = formatFencedToolDefinitions("agent", tools);
    // The framed `bash` example IS a real call; the indented read/write/edit docs must not be.
    const parsed = parseToolCalls(out, tools);
    const names = parsed.toolCalls.map((c) => c.function.name);
    expect(names).not.toContain("read");
    expect(names).not.toContain("write");
    expect(names).not.toContain("edit");
    expect(names).toContain("bash");
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

  it("keeps a tool fence's body opaque — an inner ```<tool> line is body, not a new call", () => {
    // A bash call that writes a file containing a fenced code block must parse as ONE call
    // (the inner ```bash is body content). Previously the parser split it into two calls.
    const text = `\`\`\`bash
cat > /tmp/f <<'EOF'
\`\`\`bash
npm start
\`\`\`
EOF
\`\`\``;
    const { calls } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.command).toContain("npm start");
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

  // Regression: a `write` whose body is a Markdown doc embedding a ```python fence must
  // NOT be truncated at the inner fence's closing ```. Previously the parser closed the
  // write block at the first bare ``` (the inner python closer), cutting off the rest of
  // the file. Same class as the bash heredoc fix, but for arbitrary tool bodies.
  it("does not truncate a write body containing a nested code fence (all tools)", () => {
    const text = [
      "```write_file",
      "path: result-qa-verify-issue-10.md",
      "",
      "# QA Verification Result",
      "",
      "Actual file content (verified by direct read):",
      "",
      "```python",
      "from django.db import models",
      "from django.utils import timezone",
      "",
      "",
      "class AuditableModel(models.Model):",
      "    record_timestamp = models.DateTimeField(default=timezone.now, db_index=True)",
      "    created_at = models.DateTimeField(auto_now_add=True)",
      "    updated_at = models.DateTimeField(auto_now=True)",
      "",
      "    class Meta:",
      "        abstract = True",
      "```",
      "",
      "## MORE CONTENT AFTER THE PYTHON BLOCK",
      "This should be preserved.",
      "```",
    ].join("\n");

    const { calls, leftover } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.path).toBe("result-qa-verify-issue-10.md");
    expect(args.content).toContain("abstract = True");
    expect(args.content).toContain("MORE CONTENT AFTER THE PYTHON BLOCK");
    expect(leftover.trim()).toBe("");
  });

  // Regression (2026-10-17, live CP-7 write session): a `write` body whose embedded
  // code block opens with a BARE ``` (no info-string) — the ordinary Markdown form —
  // was truncated at that opener. OPEN_FENCE_REGEX requires a language token, so a
  // bare opener fell through to the close path and ended the tool body early, writing
  // a partial file AND tripping the post-fence contamination guard. The fix treats a
  // bare fence as an inner-fence opener when a later bare fence follows before any new
  // tool call / result tag.
  it("does not truncate a write body whose nested code fence opens BARE (no language)", () => {
    const text = [
      "```write_file",
      "path: result.md",
      "",
      "# Result",
      "",
      "Programmatic diff run inside the fixtures directory:",
      "",
      "```",
      "a111 -> b222: NetworkSNR 10.5 -> 11.0",
      "```",
      "",
      "## MORE CONTENT AFTER THE BARE BLOCK",
      "This must be preserved.",
      "```",
    ].join("\n");

    const { calls, leftover } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.content).toContain("a111 -> b222");
    expect(args.content).toContain("MORE CONTENT AFTER THE BARE BLOCK");
    expect(leftover.trim()).toBe("");
  });

  it("parses a write body with MULTIPLE nested code fences, closing only at the real tool fence", () => {
    const text = [
      "```write_file",
      "path: guide.md",
      "",
      "# Guide",
      "",
      "```python",
      "print('a')",
      "```",
      "",
      "more prose",
      "",
      "```bash",
      "echo hi",
      "```",
      "",
      "the end",
      "```",
    ].join("\n");

    const { calls, leftover } = parseFencedToolCalls(text, specs);
    expect(calls).toHaveLength(1);
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.content).toContain("print('a')");
    expect(args.content).toContain("more prose");
    expect(args.content).toContain("echo hi");
    expect(args.content).toContain("the end");
    expect(leftover.trim()).toBe("");
  });
});





describe("advisor framing", () => {
  const TOOLS = [bash, readFile];

  it("frames the model as a chat assistant that writes a bash fence", () => {
    const out = formatFencedToolDefinitions();
    expect(out).toContain("You are a chat assistant helping with shell tasks, working toward the whole task stated in the user's request");
    expect(out).toContain("a single fenced block opened with the word bash (or shell) containing the commands for that step");
    expect(out).toContain("<tool_output>");
    expect(out).toContain("```bash");
  });

  it("omits every agentic pressure that makes Astra refuse", () => {
    const out = formatFencedToolDefinitions();
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
});

describe("framingVariantForTone", () => {
  it("routes Claude tones to the execution-agent framing, everything else to advisor", () => {
    expect(framingVariantForTone("Gpt_6_Astra")).toBe("advisor");
    expect(framingVariantForTone("Gpt_5_6_Reasoning")).toBe("advisor");
    expect(framingVariantForTone("Gpt_5_5_Reasoning")).toBe("advisor");
    expect(framingVariantForTone("magic")).toBe("advisor");
    expect(framingVariantForTone("Claude_Sonnet")).toBe("agent");
    expect(framingVariantForTone("Claude_Opus")).toBe("agent");
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

  it("seals on a fence glued to the end of a prose line, dropping it and everything after (regression)", () => {
    const gate = createProseStreamGate(specs);
    // M365 emits `prose + fence + surrender text` with the opener glued to the prose
    // line — the fence and the trailing text must never reach the content channel.
    const out = gate.push("I'll run the command now```bash\nuname -s\n```UNABLE");
    expect(out).toBe("I'll run the command now");
    expect(gate.sealed).toBe(true);
    expect(gate.push(" trailing surrender")).toBe("");
  });
});

describe("isAdvisorTone", () => {
  it("is true for every non-Claude tone", () => {
    expect(isAdvisorTone("Gpt_6_Astra")).toBe(true);
    expect(isAdvisorTone("Gpt_5_6_Reasoning")).toBe(true);
    expect(isAdvisorTone("gpt_6_astra")).toBe(true);
    expect(isAdvisorTone("GPT_6_ASTRA")).toBe(true);
    expect(isAdvisorTone("Gpt_5_5_Reasoning")).toBe(true);
    expect(isAdvisorTone("magic")).toBe(true);
    expect(isAdvisorTone("Claude_Sonnet")).toBe(false);
    expect(isAdvisorTone()).toBe(true);
  });
});
