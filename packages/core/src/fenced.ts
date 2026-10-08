import { createLogger } from "./log.js";
import type { ParsedToolCall, ToolDef } from "./tools.js";

const log = createLogger("fenced");

// --- Fenced tool-call format (M365_TOOL_FORMAT=fenced) ------------------------
//
// Hypothesis H4 (docs/hypotheses.md, experiment E-C1): M365's chat-tuned model
// emits a Markdown code fence — ```bash / ```write_file — far more readily than a
// `{"tool":...,"arguments":{...}}` JSON object, because fenced code is everywhere
// in its training data and (crucially) a multi-line file body needs no JSON string
// escaping. The 0/5 bench baseline (§8.12) is the model narrating success instead
// of acting; removing the escaping friction is the remaining untested lever.
//
// Format, per tool:
//   - fence info-string is the EXACT tool name
//   - scalar args render as `key: value` header lines
//   - one free-form "body" arg is the fence body (blank line separates it from the
//     header, like email/front-matter)
//   - an old/new edit pair renders as an aider-style SEARCH/REPLACE diff
//
//   ```bash
//   ls -la
//   ```
//
//   ```write_file
//   path: fizzbuzz.py
//
//   for i in range(1, 101):
//       print(i)
//   ```
//
//   ```edit_file
//   path: app.py
//   <<<<<<< SEARCH
//   debug = False
//   =======
//   debug = True
//   >>>>>>> REPLACE
//   ```
//
// Known limitation: a `write_file` body that itself contains a ``` fence can't be
// carried unambiguously — this is exactly where JSON wins, and the bench A/B will
// show whether the escaping-free win on ordinary files outweighs it.

const BODY_PARAM_NAMES = [
  "command", "content", "code", "body", "script", "text",
  "query", "input", "patch", "cmd", "data", "contents",
  "prompt", "instruction", "instructions", "message", "questions", "diff", "payload",
  "todos", "items", "tasks", "entries",
];
const SEARCH_KEYS = ["old", "search", "find", "old_str", "old_string", "target"];
const REPLACE_KEYS = ["new", "replace", "replacement", "new_str", "new_string"];

// Fence info-strings that mean "a shell script". M365's chat-tuned model emits
// ```bash blocks reflexively (it's the one agentic-shaped output Microsoft's
// system prompt permits); we route them to whatever shell tool the harness gave,
// whatever it's named. See docs/hypotheses.md §A (shell-routing).
export const SHELL_LANGS = new Set([
  "bash", "sh", "shell", "zsh", "console", "shell-session", "shellsession", "shsession",
  // M365's hosted runtime leaks its own code-interpreter tool namespace into
  // generations (`container.exec` and friends) — see §12.13. Those turns are
  // salvageable: the model *did* decide to run a command, it just addressed the
  // wrong executor. Route them to the harness shell instead of losing them to prose.
  "container.exec", "container.run", "container.bash",
  // Windows fences, routed unconditionally rather than gated on `process.platform`:
  // the proxy and the harness need not share a host, and a command that runs and
  // fails returns an error the model can correct from, whereas an unrouted fence is
  // silently demoted to prose and the turn is lost. Issue #7 — a user's memory
  // instruction to "always use PowerShell" made every compliant turn a no-op, which
  // read as the model ignoring them.
  "powershell", "pwsh", "ps1", "posh", "cmd", "bat", "batch", "dosbatch",
]);
// A tool counts as "the shell" if its name looks like a run-a-command tool. pi
// uses `bash`, opencode `bash`, hermes `shell`/`run`, openclaw `run_command` — all caught.
const SHELL_TOOL_NAME = /^(bash|sh|shell|zsh|run|exec|execute|command|cmd|terminal|run_command|run_terminal_cmd|execute_command|execute_bash|shell_exec|system)$/i;

/** The harness tool (if any) that runs a shell command — the target for ```bash routing. */
export function findShellTool(tools: ToolDef[]): ToolDef | undefined {
  return tools.find((t) => SHELL_TOOL_NAME.test(t.function.name)) ??
    // fallback: a single-string-param tool whose param is command-ish
    tools.find((t) => {
      const props = Object.keys(t.function.parameters?.properties ?? {});
      return props.length === 1 && /^(command|cmd|script|input)$/i.test(props[0]);
    });
}

/** Shell tools are covered entirely by the advisor prompt's built-in shell framing.
 *  Strip them from the <tools> block to eliminate token bloat and the contradictory
 *  harness descriptions that tell the model not to use cat/sed/grep. Routing is
 *  unaffected: `buildSpecMap` still registers the shell aliases and the fence parser
 *  is purely regex-based — the model need not have seen a <tools> entry for bash. */
export function nonShellTools(tools: ToolDef[]): ToolDef[] {
  return tools.filter(
    (t) => !SHELL_LANGS.has(t.function.name) && !SHELL_TOOL_NAME.test(t.function.name),
  );
}

export interface FencedToolSpec {
  name: string;
  description?: string;
  /** Scalar params rendered as `key: value` header lines. */
  headerParams: string[];
  /** The free-form param carried as the fence body (mutually exclusive with editPair). */
  bodyParam?: string;
  /** Schema of the body parameter if available */
  bodyParamSchema?: any;
  /** An (old → new) pair rendered as a SEARCH/REPLACE diff. */
  editPair?: { search: string; replace: string };
}

/** Derive how a single OpenAI tool maps onto the fenced shape. */
export function deriveFencedSpec(tool: ToolDef): FencedToolSpec {
  const name = tool.function.name;
  const description = tool.function.description;
  const properties = tool.function.parameters?.properties ?? {};
  const props = Object.keys(properties);

  const search = props.find((p) => SEARCH_KEYS.includes(p));
  const replace = props.find((p) => REPLACE_KEYS.includes(p));
  if (search && replace) {
    return {
      name,
      description,
      editPair: { search, replace },
      headerParams: props.filter((p) => p !== search && p !== replace),
    };
  }

  const bodyParam =
    props.find((p) => BODY_PARAM_NAMES.includes(p)) ??
    (props.length === 1 ? props[0] : undefined);
  const bodyParamSchema = bodyParam ? properties[bodyParam] : undefined;

  return {
    name,
    description,
    bodyParam,
    bodyParamSchema,
    headerParams: props.filter((p) => p !== bodyParam),
  };
}

export function buildSpecMap(tools: ToolDef[]): Map<string, FencedToolSpec> {
  const m = new Map<string, FencedToolSpec>();
  for (const t of tools) m.set(t.function.name, deriveFencedSpec(t));

  // Shell aliasing: route the model's reflexive ```bash / ```sh / ```shell blocks
  // to the harness's shell tool even when it's named `run`/`run_command`/etc., so
  // the model can "just write bash" (the behavior M365 reliably permits) and the
  // harness still receives a structured tool_call under its own tool's name.
  const shell = findShellTool(tools);
  if (shell) {
    const shellSpec = m.get(shell.function.name)!;
    for (const lang of SHELL_LANGS) {
      if (!m.has(lang)) m.set(lang, shellSpec);
    }
  }
  return m;
}

function scalarToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/** Render a skeleton for a JSON parameter schema */
function renderSchemaSkeleton(name: string, schema?: any): string {
  if (!schema) return `<${name}>`;
  if (name === "questions" || (schema.type === "array" && schema.items?.properties?.question)) {
    return `[
  {
    "header": "<category/title: string>",
    "question": "<question prompt: string>",
    "options": [
      { "label": "<option A: string>", "description": "<description A: string>" },
      { "label": "<option B: string>", "description": "<description B: string>" }
    ],
    "multiple": false
  }
]`;
  }
  if (name === "todos" || (schema.type === "array" && schema.items?.properties?.content)) {
    return `[
  {
    "id": "<id: string>",
    "content": "<task description: string>",
    "status": "pending",
    "priority": "medium"
  }
]`;
  }
  if (schema.type === "array") return `[<${name} item>]`;
  if (schema.type === "object") return `{\n  /* ${name} object fields */\n}`;
  return `<${name}>`;
}

/** Render one concrete tool call (name + args object) as a fenced block. */
export function renderFencedCall(spec: FencedToolSpec, args: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const h of spec.headerParams) {
    if (args[h] !== undefined) lines.push(`${h}: ${scalarToString(args[h])}`);
  }

  if (spec.editPair) {
    lines.push("<<<<<<< SEARCH");
    lines.push(scalarToString(args[spec.editPair.search]));
    lines.push("=======");
    lines.push(scalarToString(args[spec.editPair.replace]));
    lines.push(">>>>>>> REPLACE");
  } else if (spec.bodyParam !== undefined) {
    if (lines.length) lines.push(""); // blank line separates header from body
    lines.push(scalarToString(args[spec.bodyParam]));
  }

  return "```" + spec.name + "\n" + lines.join("\n") + "\n```";
}

/** A self-documenting template shown in the per-request <tools> block. */
function renderFencedTemplate(spec: FencedToolSpec): string {
  const lines: string[] = [];
  for (const h of spec.headerParams) lines.push(`${h}: <${h}>`);
  if (spec.editPair) {
    lines.push("<<<<<<< SEARCH");
    lines.push(`<${spec.editPair.search}>`);
    lines.push("=======");
    lines.push(`<${spec.editPair.replace}>`);
    lines.push(">>>>>>> REPLACE");
  } else if (spec.bodyParam !== undefined) {
    if (lines.length) lines.push("");
    lines.push(renderSchemaSkeleton(spec.bodyParam, spec.bodyParamSchema));
  }
  const header = spec.description ? `${spec.name} — ${spec.description}` : spec.name;
  return `${header}\n\`\`\`${spec.name}\n${lines.join("\n")}\n\`\`\``;
}

function toolsBlock(tools: ToolDef[]): string {
  const defs = tools.map((t) => renderFencedTemplate(deriveFencedSpec(t))).join("\n\n");
  return `<tools>\n${defs}\n</tools>`;
}

export function formatAdvisorPrompt(tools: ToolDef[]): string {
  // Elision only — the advisor prose below is deliberately left byte-for-byte
  // unchanged (the persistence / anti-surrender language is load-bearing for
  // gpt-5.6 multi-turn work). Shell tools are dropped from the <tools> block to
  // remove the contradictory harness description; because that block no longer
  // declares the shell, the concrete fence example — with the optional header
  // params the harness shell actually declares — is provided inline here instead.
  // Teach a fixed `shell` fence label regardless of the harness tool's name: heavy
  // refusing tones (gpt-61) reportedly respond to the generic word over the concrete
  // `bash`. Routing is label-agnostic — buildSpecMap aliases both to the shell tool.
  const shellTool = findShellTool(tools);
  const shellLabel = "shell";
  const shellProps = Object.keys(shellTool?.function.parameters?.properties ?? {});
  const headerLines = [
    shellProps.includes("timeout") ? "timeout: 30000" : null,
    shellProps.includes("workdir") ? "workdir: /path/to/dir" : null,
  ].filter(Boolean).join("\n");
  // Only teach the fence when the harness actually provides a shell tool to route it.
  const shellExample = !shellTool
    ? ""
    : headerLines
      ? `\n\nThe block may start with optional header lines before the commands:\n\`\`\`${shellLabel}\n${headerLines}\n<commands>\n\`\`\``
      : `\n\nExample:\n\`\`\`${shellLabel}\n<commands>\n\`\`\``;

  const extra = nonShellTools(tools);
  const extraBlock = extra.length > 0 ? `\n\n${toolsBlock(extra)}` : "";
  return `You write the shell commands; I run them and paste the real output back to you. Do not make any tool calls and do not try to run anything yourself.

To carry out a step, reply with a single fenced code block opened with the word bash or shell, containing the commands — create or overwrite files with \`cat > name <<'EOF' … EOF\` heredocs, edit files in place with \`sed -i\`, inspect with \`cat\`/\`ls\`/\`grep\`, run code with the available interpreters. Put all commands you want to run for this step into that single block — do not split them across multiple code fences. Put nothing before the fence. I run that block and paste its output back; read it, think, then write the next script. Work one block at a time until the task is complete.

You have not run anything yet and have no results. Never invent or assume a command's output, never say the files are missing or that you cannot access them, and never ask me to paste them. Never reply that you cannot run commands, that the shell is unavailable, or that you cannot read the files — you are not being asked to run anything; you only write the commands. Emit exactly one fenced block per reply — never multiple fences — then stop and wait for my output.

When the task is complete and no further command is needed, reply in plain language with the final answer only — no code fence, no preamble.${shellExample}${extraBlock}`;
}

export function formatFencedToolDefinitions(tools: ToolDef[], _variantOverride?: string): string {
  return formatAdvisorPrompt(tools) + hostPlatformNote(findShellTool(tools));
}

/** Per-turn correction telling the model which OS it is actually driving.
 *
 *  Every framing variant teaches POSIX idioms *by name* — `cat > f <<'EOF'`
 *  heredocs, `sed -i`, `ls`/`grep` — and none of them ever say what host the shell
 *  runs on. On Windows that is a strong instruction, repeated every single turn, to
 *  emit commands the host cannot run; it reliably outweighed the user-level memory
 *  instructions people wrote to counteract it, and the resulting failures pushed the
 *  model toward M365's own Linux code-interpreter as the only filesystem it could
 *  reach (#7, and the sandbox drift in #12).
 *
 *  `platform` is injectable so the Windows branch is testable from a POSIX box —
 *  the whole point, since this repo had no Windows host to verify against.
 *  Returns "" off Windows, leaving the bench-tuned variants byte-for-byte unchanged. */
export function hostPlatformNote(
  shell: ToolDef | undefined,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32" || !shell) return "";
  return `

HOST PLATFORM: Windows. The \`${shell.function.name}\` tool runs PowerShell on a real Windows machine — not Linux, and not a container. Any POSIX idiom named above is wrong here and will fail: there are no \`<<'EOF'\` heredocs, no \`sed -i\`, no \`ls\`/\`grep\`. Emit \`\`\`powershell blocks instead of \`\`\`bash, and use the Windows equivalents:

- create/overwrite a file: \`Set-Content -Path name -Value @'\n…\n'@\`
- edit in place: \`(Get-Content f) -replace 'old','new' | Set-Content f\`
- inspect: \`Get-Content\` / \`Get-ChildItem\` / \`Select-String\`
- paths use \`\\\` and may contain spaces — quote them.

You are NOT in a Linux sandbox and have no \`/mnt/data\`. The working directory is a real Windows path; run \`Get-Location\` if you need to see it.`;
}

export function currentFramingVariant(): string {
  return "advisor";
}

export function isAdvisorTone(_tone?: string): boolean {
  return true;
}

export function framingVariantForTone(_tone?: string): string {
  return "advisor";
}

export const FRAMING_VARIANT_NAMES = ["advisor"];

// --- Parsing -----------------------------------------------------------------

// Match opening fence of 3 or more backticks with a tool-like info-string.
// Dots and hyphens are allowed so namespaced runtime tool names (```container.exec)
// can be recognised and routed.
const OPEN_FENCE_REGEX = /^( {0,3})(`{3,})([A-Za-z0-9_.-]+)[ \t]*$/;
const HEREDOC_OPEN_REGEX = /(?:^|[^<])<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;

const SEARCH_REPLACE_REGEX =
  /<{5,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={5,}\s*\r?\n([\s\S]*?)\r?\n>{5,}\s*REPLACE/;

function makeCall(name: string, args: Record<string, unknown>): ParsedToolCall {
  return {
    id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** Parse the inner text of one fenced block into an arguments object, schema-aware. */
function parseFencedInner(spec: FencedToolSpec, inner: string): Record<string, unknown> | null {
  const lines = inner.split("\n");
  const args: Record<string, unknown> = {};

  // If the entire block is valid JSON (object), parse directly
  const trimmed = inner.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsedObj = JSON.parse(trimmed);
      if (typeof parsedObj === "object" && parsedObj !== null && !Array.isArray(parsedObj)) {
        return parsedObj;
      }
    } catch {
      // fall through to line-by-line parsing
    }
  }

  // Header: contiguous "key: value" lines whose key is a known header param,
  // terminated by a blank line (consumed) or the first non-header line (kept).
  let i = 0;
  if (spec.headerParams.length) {
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "") { i++; break; }
      const m = line.match(/^([A-Za-z0-9_]+):[ \t]?(.*)$/);
      if (m && spec.headerParams.includes(m[1])) {
        const val = m[2].trim();
        if (val === "true") args[m[1]] = true;
        else if (val === "false") args[m[1]] = false;
        else if (/^-?\d+(\.\d+)?$/.test(val)) args[m[1]] = Number(val);
        else args[m[1]] = m[2];
      } else {
        break;
      }
    }
  }

  const rest = lines.slice(i).join("\n");

  if (spec.editPair) {
    const sr = rest.match(SEARCH_REPLACE_REGEX);
    if (!sr) {
      log.error(`edit tool "${spec.name}" missing SEARCH/REPLACE markers`);
      return null;
    }
    args[spec.editPair.search] = sr[1];
    args[spec.editPair.replace] = sr[2];
  } else if (spec.bodyParam !== undefined) {
    const restTrimmed = rest.trim();
    if (
      (restTrimmed.startsWith("[") && restTrimmed.endsWith("]")) ||
      (restTrimmed.startsWith("{") && restTrimmed.endsWith("}"))
    ) {
      try {
        args[spec.bodyParam] = JSON.parse(restTrimmed);
      } catch {
        args[spec.bodyParam] = rest;
      }
    } else {
      // Strip trailing model invocation stop-tokens emitted at stream end
      args[spec.bodyParam] = typeof rest === "string"
        ? rest.replace(/(?:<\/?(?:parameter|invoke|tool_call|function_call)[^>]*>\s*)+$/gi, "").trimEnd()
        : rest;
    }
  }

  // Automatic schema normalization for question tools
  if (Array.isArray(args.questions)) {
    args.questions = args.questions.map((q: any) => {
      if (typeof q !== "object" || q === null) return q;
      const normalized: any = { ...q };
      if (!normalized.header) {
        normalized.header =
          typeof normalized.question === "string" && normalized.question.length <= 40
            ? normalized.question
            : "Clarification";
      }
      if (Array.isArray(normalized.options)) {
        normalized.options = normalized.options.map((opt: any) => {
          if (typeof opt === "string") {
            return { label: opt, description: opt };
          }
          if (typeof opt === "object" && opt !== null) {
            return {
              label: opt.label ?? opt.value ?? opt.name ?? String(opt),
              description: opt.description ?? opt.label ?? opt.value ?? String(opt),
            };
          }
          return opt;
        });
      }
      if (normalized.multiple === undefined) {
        normalized.multiple = false;
      }
      return normalized;
    });
  }

  // Automatic schema normalization for todo tools (todowrite / todos)
  if (Array.isArray(args.todos)) {
    args.todos = args.todos.map((item: any, idx: number) => {
      if (typeof item === "string") {
        return {
          id: String(idx + 1),
          content: item,
          status: "pending",
          priority: "medium",
        };
      }
      if (typeof item === "object" && item !== null) {
        const normalized: any = { ...item };
        if (!normalized.id) normalized.id = String(idx + 1);
        if (!normalized.status) normalized.status = "pending";
        if (!normalized.priority) normalized.priority = "medium";
        if (!normalized.content && normalized.task) normalized.content = normalized.task;
        if (!normalized.content && normalized.title) normalized.content = normalized.title;
        return normalized;
      }
      return item;
    });
  }

  return args;
}

export interface FencedParseResult {
  calls: ParsedToolCall[];
  /** Text with the matched tool fences removed (for mixed-output detection). */
  leftover: string;
}

/**
 * Parse all fenced tool calls whose info-string matches a known tool name.
 * 
 * Supports:
 * - CommonMark variable fence length: ```` ```tool ```` closed by at least 3 backticks,
 *   ```` ````tool ```` closed by at least 4 backticks.
 * - Shell heredoc awareness: when inside a bash/shell block with an active heredoc
 *   (e.g. `cat <<'END'`), nested ```` ``` ```` lines do not prematurely close the tool fence.
 * - Consecutive fence transitions without closing backticks (e.g. ```` ```bash ... ```bash ````).
 * - EOF flush for streams ending without a decorative closing fence.
 */
export function parseFencedToolCalls(
  text: string,
  specs: Map<string, FencedToolSpec>,
): FencedParseResult {
  const calls: ParsedToolCall[] = [];
  const lines = text.split(/\r?\n/);

  let inBlock = false;
  let fenceLen = 3;
  let toolSpec: FencedToolSpec | null = null;
  let blockLines: string[] = [];
  let matchedIndices: { start: number; end: number }[] = [];
  let blockStartIndex = 0;
  let heredocStack: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inBlock) {
      const m = line.match(OPEN_FENCE_REGEX);
      if (m) {
        const spec = specs.get(m[3]);
        if (spec) {
          inBlock = true;
          fenceLen = m[2].length;
          toolSpec = spec;
          blockLines = [];
          blockStartIndex = i;
          heredocStack = [];
        }
      }
    } else {
      // Check if we are inside a heredoc for shell tools
      if (heredocStack.length > 0) {
        const currentDelim = heredocStack[heredocStack.length - 1];
        if (line.trim() === currentDelim) {
          heredocStack.pop();
        }
        blockLines.push(line);
        continue;
      }

      // Check if this line is starting a NEW tool fence without an explicit closing fence
      // (e.g. ```bash ... ```bash ...) when not inside an active heredoc
      const openMatch = line.match(OPEN_FENCE_REGEX);
      const newSpec = openMatch && openMatch[2].length >= fenceLen ? specs.get(openMatch[3]) : null;
      if (newSpec) {
        const inner = blockLines.join("\n");
        const args = parseFencedInner(toolSpec!, inner);
        if (args) {
          calls.push(makeCall(toolSpec!.name, args));
          matchedIndices.push({ start: blockStartIndex, end: i - 1 });
        }
        inBlock = true;
        fenceLen = openMatch![2].length;
        toolSpec = newSpec;
        blockLines = [];
        blockStartIndex = i;
        heredocStack = [];
        continue;
      }

      // Check for opening a heredoc in the current line
      const hMatch = line.match(HEREDOC_OPEN_REGEX);
      if (hMatch) {
        heredocStack.push(hMatch[1]);
      }

      // Check if this line is a closing fence (3+ backticks, optionally followed by inline prose)
      const closeMatch = line.match(/^( {0,3})(`{3,})([ \t].*)?$/);
      if (closeMatch && closeMatch[2].length >= fenceLen) {
        // Closing fence reached
        const inner = blockLines.join("\n");
        const args = parseFencedInner(toolSpec!, inner);
        if (args) {
          calls.push(makeCall(toolSpec!.name, args));
          matchedIndices.push({ start: blockStartIndex, end: i });
        }
        inBlock = false;
        toolSpec = null;
        blockLines = [];
        heredocStack = [];
      } else {
        blockLines.push(line);
      }
    }
  }

  // EOF Flush: if stream ended while still inside an unclosed tool block, parse it
  if (inBlock && toolSpec && blockLines.length > 0) {
    const inner = blockLines.join("\n");
    const args = parseFencedInner(toolSpec, inner);
    if (args) {
      calls.push(makeCall(toolSpec.name, args));
      matchedIndices.push({ start: blockStartIndex, end: lines.length - 1 });
    }
  }

  // Build leftover text by excluding matched line ranges
  const leftoverLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isMatched = matchedIndices.some((range) => i >= range.start && i <= range.end);
    if (!isMatched) {
      leftoverLines.push(lines[i]);
    }
  }

  return { calls, leftover: leftoverLines.join("\n") };
}

// --- Live prose streaming gate ----------------------------------------------
//
// Track A (design 002 §3.2): the tool path must stream prose live up to the first
// *known tool* fence, then stop — the fence body is a tool call, not prose. The
// gate reuses OPEN_FENCE_REGEX + the buildSpecMap aliases so "what streams" and
// "what parses" recognise fences byte-identically (grug 25: use what exists).
//
// Emission is EAGER, token-granularity, no line buffering: after each delta we
// rescan the whole buffer (a partial opener's bytes may already have been emitted)
// for the earliest line matching OPEN_FENCE_REGEX whose info-string is a spec key.
// Only the eager passthrough can leak the bytes of a partial opener
// (`"``"` then `"`bash\n"`); the fence *body* never leaks because it begins only
// after the recognised opener line. See design §3.2/§7.

export interface ProseStreamGate {
  /** Append a raw delta; returns the text safe to emit now (possibly ""). */
  push(delta: string): string;
  /** True once a known tool fence has opened; nothing more will stream. */
  readonly sealed: boolean;
}

/** Offset of the earliest line in `buf` that opens a known tool fence, or -1. */
function findToolFenceOffset(buf: string, specs: Map<string, FencedToolSpec>): number {
  let pos = 0;
  while (pos <= buf.length) {
    const nl = buf.indexOf("\n", pos);
    const lineEnd = nl === -1 ? buf.length : nl;
    const line = buf.slice(pos, lineEnd).replace(/\r$/, "");
    const m = line.match(OPEN_FENCE_REGEX);
    if (m && specs.has(m[3])) return pos;
    if (nl === -1) break;
    pos = nl + 1;
  }
  return -1;
}

export function createProseStreamGate(specs: Map<string, FencedToolSpec>): ProseStreamGate {
  let buf = "";
  let emitted = 0;
  let sealed = false;
  return {
    get sealed() {
      return sealed;
    },
    push(delta: string): string {
      if (sealed) return "";
      buf += delta;
      const fenceAt = findToolFenceOffset(buf, specs);
      if (fenceAt >= 0) {
        sealed = true;
        const out = fenceAt > emitted ? buf.slice(emitted, fenceAt) : "";
        emitted = buf.length;
        return out;
      }
      const out = buf.slice(emitted);
      emitted = buf.length;
      return out;
    },
  };
}

