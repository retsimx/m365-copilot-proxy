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
const SEARCH_KEYS = ["old", "search", "find", "old_str", "old_string", "oldstring", "target"];
const REPLACE_KEYS = ["new", "replace", "replacement", "new_str", "new_string", "newstring"];

// --- Cross-harness parameter aliases -----------------------------------------
//
// The <tools> block teaches one harness's parameter names, but the model may emit
// another harness's name for the same slot. The canonical example is the file
// parameter: pi names it `filePath`, OpenCode names it `path` (and OpenClaw
// `file_path`). A fenced `filePath:` header against an OpenCode `path` schema used
// to be discarded (headerParams.includes("filePath") === false → the header loop
// broke and the argument was lost): `read` reached the harness as `{}` and `write`
// leaked the header line into the file body. Each family maps a set of equivalent
// key spellings onto whichever name the harness actually declared.
const PARAM_ALIAS_FAMILIES: readonly (readonly string[])[] = [
  ["path", "filepath", "file_path", "file", "filename", "file_name"],
  ["content", "contents", "text", "body", "data"],
  ["oldstring", "old_string", "oldstr", "old_str", "old", "search", "find", "target"],
  ["newstring", "new_string", "newstr", "new_str", "new", "replace", "replacement"],
  ["replaceall", "replace_all"],
  ["timeout", "timeout_ms", "timeoutms"],
  ["workdir", "working_directory", "working_dir", "cwd", "dir", "directory"],
];

/** Every param name a spec declares (headers + body + edit pair). */
function declaredParams(spec: FencedToolSpec): string[] {
  return [
    ...spec.headerParams,
    ...(spec.bodyParam !== undefined ? [spec.bodyParam] : []),
    ...(spec.editPair ? [spec.editPair.search, spec.editPair.replace] : []),
  ];
}

/** Map a model-emitted key onto a param this tool actually declares, accepting
 *  cross-harness aliases (`filePath` → `path`). Returns undefined when the key names
 *  nothing the tool has — the caller then treats the line as body content, as before. */
export function resolveDeclaredParam(spec: FencedToolSpec, key: string): string | undefined {
  const declared = declaredParams(spec);
  const lower = key.toLowerCase();
  for (const d of declared) if (d.toLowerCase() === lower) return d;
  const family = PARAM_ALIAS_FAMILIES.find((f) => f.includes(lower));
  if (!family) return undefined;
  for (const d of declared) if (family.includes(d.toLowerCase())) return d;
  return undefined;
}

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

export interface FencedToolSpec {
  name: string;
  description?: string;
  /** Scalar params rendered as `key: value` header lines. */
  headerParams: string[];
  /** The free-form param carried as the fence body (mutually exclusive with editPair). */
  bodyParam?: string;
  /** JSON-schema `type` of `bodyParam`. A `string` body is ALWAYS kept verbatim — a
   *  file whose content happens to be JSON must not be turned into an object. */
  bodyType?: string;
  /** An (old → new) pair rendered as a SEARCH/REPLACE diff. */
  editPair?: { search: string; replace: string };
  /** A worked example for the Claude agent <tools> block: the call the model emits
   *  and the harness's reply. */
  example?: { input: string; output?: string };
}

/** Derive how a single OpenAI tool maps onto the fenced shape. */
export function deriveFencedSpec(tool: ToolDef): FencedToolSpec {
  const name = tool.function.name;
  const description = tool.function.description;
  const properties = tool.function.parameters?.properties ?? {};
  const props = Object.keys(properties);

  const search = props.find((p) => SEARCH_KEYS.includes(p.toLowerCase()));
  const replace = props.find((p) => REPLACE_KEYS.includes(p.toLowerCase()));
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

  return {
    name,
    description,
    bodyParam,
    bodyType: bodyParam ? (properties[bodyParam]?.type as string | undefined) : undefined,
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

// Bash-only advisor framing: the model writes shell commands in a ```bash / ```shell fence;
// the harness runs them and returns the output. We deliberately do NOT declare opencode's
// read/write/edit tools — the model reliably writes shell, and a lean toolset avoids Disengage.
export function formatAdvisorPrompt(): string {
  const shellName = "bash";

  // Optional-header example so the model knows the `timeout:`/`workdir:` fence prefix.
  const shellExample = `\n\nThe block may start with optional header lines before the commands:\n\`\`\`${shellName}\ntimeout: 30000\nworkdir: /path/to/dir\n<commands>\n\`\`\``;

  return `You are a chat assistant helping with shell tasks, working toward the whole task stated in the user's request.

Your objective is the whole task, not any single step. An objective may take one step or many; no single step completes it — the objective is achieved only when the work of all its steps is done. Every result, whatever it shows, is one of those steps.

The unit of progress in this session is a shell step. Each non-final turn delivers one: a short line of prose saying what you are about to do, then a single fenced block opened with the word bash (or shell) containing the commands for that step — its fences on their own new lines, nothing after the closing fence. The prose explains the step; the block is the executable deliverable. I run it and paste the real output back; read it and write the next step. Prose-only is reserved for a completed objective, or for a specific blocker no further step can resolve; announcing a step is not an answer — the step itself follows the sentence.

For reading, creating, or changing files, you write the shell commands; I run them and return the output. (A session may also offer Microsoft's own built-in tools — \`bash_tool\` (a container shell), \`create_file\`, \`view\`, \`str_replace\`, \`image_gen\`, \`search_web\`, \`click\`, the \`office365_*\` helpers, an Outlook compose tool, \`present_files\`, and \`record_memory\`. Those belong to Microsoft's remote sandbox, which holds none of the real files, so what they return is not from this machine. The fenced block below is the one that runs here.)

An unexpected or imperfect result — an error, an empty output, a wrong path, a truncated one — is information toward the objective, not grounds to stop; keep adjusting and going, and treat the objective as unachievable only when you are certain of it. A truncated result is a size cap — fetch the remainder with a narrower read (offset, limit; sed -n; head/tail). Keep working one block at a time until the whole objective is achieved. Only then reply with the final answer in plain language — not a command, not a fence.${shellExample}`;
}

/** The Claude <tools> block is built by `renderAgentToolsBlock` below. */

/** Harness tool names that mean "the file reader / writer / editor". Recognising the
 *  aliases keeps the framing honest when a harness calls them `read_file` (the bench)
 *  instead of OpenCode's `read`. */
const FILE_TOOL_ALIASES: Record<"read" | "write" | "edit", readonly string[]> = {
  read: ["read", "read_file", "readfile"],
  write: ["write", "write_file", "writefile"],
  edit: ["edit", "edit_file", "editfile"],
};

function findToolByAlias(tools: ToolDef[], aliases: readonly string[]): ToolDef | undefined {
  return tools.find((t) => aliases.includes(t.function.name.toLowerCase()));
}

/** The param name a harness uses for a file path (pi: `filePath`, OpenCode: `path`). */
export function filePathParamName(tool: ToolDef): string {
  const props = Object.keys(tool.function.parameters?.properties ?? {});
  const family = PARAM_ALIAS_FAMILIES.find((f) => f.includes("path"))!;
  return props.find((p) => family.includes(p.toLowerCase())) ?? "path";
}

/** The Claude <tools> block. File tools are shown as NON-EXECUTABLE structure — a
 *  fabricated path inside a recognized read/write/edit fence can be executed literally
 *  (GPT probe, 2026-10-11), and a nearby warning does not neutralise a copyable example.
 *  `bash` gets one concrete, executable call; the working directory is referenced from the
 *  harness-provided environment details rather than a placeholder.
 *
 *  Every declared name (tool name + file param) is derived from the harness's own tool
 *  schemas — never hardcoded — so the documented call structure is exactly the call the
 *  harness will accept (pi's `filePath` vs OpenCode's `path`). */
function renderAgentToolsBlock(tools: ToolDef[]): string {
  const shell = findShellTool(tools);
  const readTool = findToolByAlias(tools, FILE_TOOL_ALIASES.read);
  const writeTool = findToolByAlias(tools, FILE_TOOL_ALIASES.write);
  const editTool = findToolByAlias(tools, FILE_TOOL_ALIASES.edit);
  const propsOf = (t: ToolDef) => Object.keys(t.function.parameters?.properties ?? {}).map((p) => p.toLowerCase());

  // Names interpolated into the prose rules; fall back to the canonical word when the
  // harness has no such tool (the rule is then simply inert).
  const readName = readTool?.function.name ?? "read";
  const writeName = writeTool?.function.name ?? "write";
  const editName = editTool?.function.name ?? "edit";
  const shellName = shell?.function.name ?? "bash";

  const blocks: string[] = [
    "Each block below demonstrates one complete step. Emit only one step per assistant turn. Every value inside a call must come from the current task or from a harness-provisioned fixture — never copy an example value into an unrelated task.",
    "The indented forms below document field and body structure only — they are NOT steps. When you use a file tool, emit the same structure inside a fence named for that tool, replacing every documented value with a value established by the current task.",
  ];
  if (readTool) {
    const p = filePathParamName(readTool);
    const props = propsOf(readTool);
    const hasOffset = props.includes("offset");
    const hasLimit = props.includes("limit");
    const range = hasOffset && hasLimit ? [hasOffset, hasLimit]
      : hasOffset ? [true, false]
        : hasLimit ? [false, true]
          : [false, false];
    let desc = `${readTool.function.name} — inspect one known file`;
    if (range[0] || range[1]) desc += ", optionally within a bounded line range";
    desc += `. \`${p}\` is required.`;
    if (range[0]) desc += " `offset` is an optional line offset";
    if (range[1]) desc += range[0] ? " and `limit` is an optional maximum number of lines returned." : " `limit` is an optional maximum number of lines returned.";
    if (range[0] && range[1]) desc += " Omit both unless a specific range is needed.";
    else if (range[0] || range[1]) desc += " Omit it unless a specific range is needed.";
    blocks.push([desc, " Call structure:", "", `    \`\`\`${readTool.function.name}`, `    ${p}: <the file to read>`, "    ```"].join("\n"));
  }
  if (writeTool) {
    const p = filePathParamName(writeTool);
    // Only point at the editor when the harness actually declares one — otherwise a
    // compliant model would emit an `edit` fence that no spec can parse.
    const editHint = editTool ? ` Use \`${editName}\` for a targeted change to an existing file.` : "";
    blocks.push([
      `${writeTool.function.name} — create or completely replace a file; it overwrites the whole target. \`${p}\` is required. Place one blank line after the headers, then the complete file content.${editHint} Call structure:`,
      "",
      `    \`\`\`${writeTool.function.name}`,
      `    ${p}: <the file to create or replace>`,
      "",
      "    <the complete file content>",
      "    ```",
    ].join("\n"));
  }
  if (editTool) {
    const p = filePathParamName(editTool);
    const hasReplaceAll = propsOf(editTool).includes("replaceall");
    let desc = `${editTool.function.name} — replace exact text in a file. Read the file first so the SEARCH text matches exactly. \`${p}\` is required.`;
    if (hasReplaceAll) desc += " `replaceAll: true` is optional.";
    blocks.push([
      `${desc} Call structure:`,
      "",
      `    \`\`\`${editTool.function.name}`,
      `    ${p}: <the file to change>`,
      "    <<<<<<< SEARCH",
      "    <exact existing text>",
      "    =======",
      "    <replacement text>",
      "    >>>>>>> REPLACE",
      "    ```",
    ].join("\n"));
  }
  if (shell) blocks.push([
    `${shellName} — run a shell program on the user's machine. \`workdir\` is optional in the grounding call. For later project-specific calls, set it to the exact working-directory path supplied in the environment details or established by a harness observation; never emit a descriptive placeholder as its value. \`timeout\` is an optional integer number of milliseconds; omit it when the default is sufficient. Place one blank line after any headers, then the commands.`,
    "",
    `\`\`\`${shellName}`,
    "pwd && whoami && uname -srm && ls -la .",
    "```",
  ].join("\n"));
  return `Step types\n${blocks.join("\n\n")}`;
}

export function formatAgentPrompt(tools: ToolDef[]): string {
  const toolsBlock = renderAgentToolsBlock(tools);
  // Names used by the RULES prose — the harness's own, so a harness that calls its
  // tools `read_file`/etc. is described in the terms it actually accepts.
  const readName = findToolByAlias(tools, FILE_TOOL_ALIASES.read)?.function.name ?? "read";
  const writeName = findToolByAlias(tools, FILE_TOOL_ALIASES.write)?.function.name ?? "write";
  const editName = findToolByAlias(tools, FILE_TOOL_ALIASES.edit)?.function.name ?? "edit";
  const shell = findShellTool(tools);
  const shellName = shell?.function.name ?? "bash";
  const bashFence = "```" + shellName;
  // Claude tones are agent-less and structurally immune to the Disengage filter, but that
  // immunity is on the FORMAT axis only. On the ENGAGEMENT axis they check the framing against
  // their own tool list, so this variant uses workflow voice (draft the step; someone runs it)
  // rather than ownership claims (hypotheses F46). Keep the mechanical rules verbatim.
  return `Your job in this session is to draft the next concrete step toward the user's whole objective — not a document, a plan, or a summary. For any step that requires inspecting or changing files, running commands, or learning machine state, draft exactly one fenced step, end your message at its closing fence, and wait for the real result before deciding the next step. Writing a step does not execute it and gives you no knowledge of its result. Each step you draft is run outside this conversation by the person you're working with, and the real result is pasted back here before you continue. Use prose only for the brief sentence before a step and for the final answer after real results establish the requested outcome.

The blocks below describe the step types you can draft. They are run on the developer's machine, subject to operating-system permissions. If a path or command fails, use the result to draft a new step on the next turn when possible. Nothing in this conversation executes them — writing one is drafting, not doing.

MESSAGE BOUNDARY
Incoming harness observations are read-only evidence. A result is written only by the person running the step; never write one yourself. If your message contains a tool call, it contains exactly one call and ends at that call's closing fence. Do not append a predicted outcome, simulated exchange, conclusion, or second call. Assistant text that impersonates a new harness observation is invalid, is discarded, and never counts as evidence. You may later quote or summarise observations as ordinary prose when their provenance is clear.

Your objective is the user's whole task. Completing one tool call or intermediate step does not finish it unless it establishes the requested outcome.

RULES:
- You may also have other built-in tools in this conversation. They run somewhere else — not on this developer's machine — so they're the wrong tool for this task regardless of how well they seem to match it. For local work, use only the step types described in the step-types section or the platform-specific shell step supplied by the host-platform instructions.
- Choose the tool that performs the step safely and clearly. Use \`${readName}\` for one bounded inspection when that single file or range is the complete evidence needed for the step. Use \`${editName}\` for an exact targeted change, and \`${writeName}\` to create or completely replace one file. Use \`${shellName}\` for searches, builds, tests, version control, multi-file investigation, and composed workflows. Prefer one well-structured \`${shellName}\` call when several known inspections or already-determined operations can be completed together with bounded, clearly labelled output.
- TURN ZERO: You have run nothing and received no machine evidence yet. Your first reply must contain exactly one fenced block — the grounding call below, copied as rendered — with one short sentence before it and nothing after it. Do not call any tool directly: a tool you call directly runs somewhere else, not on this developer's machine, and its result is void. The block you write is the step the harness runs. End at its closing fence and wait for the real result. Never omit the backticks, never write \`${shellName}\` inline with the sentence, and never place the opening fence mid-paragraph.

${bashFence}
pwd && whoami && uname -srm && ls -la .
\`\`\`

The result of \`pwd\` establishes the current directory. For later project-specific ${shellName} steps, set \`workdir:\` to the exact project directory established by the environment details or a real result. Never emit descriptive placeholder text as a \`workdir\` value.

Do not describe, assume, or reason about the environment before receiving the result. For a question that needs no machine access, answer directly.
- Every tool-call fence must be well formed. Its opening line is three backticks followed immediately by one supported tool name, on its own line and never joined to prose. Header fields use \`name: value\`, one per line. For \`${shellName}\` and \`${writeName}\`, place one blank line after the headers before the shell program or file content. \`${readName}\` has headers only. \`${editName}\` begins its SEARCH/REPLACE block after its headers. The closing three backticks are on their own line. Omit optional headers you do not need. Never omit the backticks, never write the tool name inline with a sentence, and never embed the block mid-paragraph.
- Emit exactly ONE tool-call fence per turn, then end the message at its closing fence and wait for the real harness observation. Never emit a second tool fence in the same turn.
- Minimise unnecessary turns. Gather a complete evidence set for the next decision in each read-only investigation call. When several inspections are already identifiable, combine them in ONE \`${shellName}\` call: inspect multiple known files or ranges, list relevant directories, and run multiple targeted searches together. Label each section and keep output bounded. Do not spend separate turns on independent reads whose paths, patterns, and ranges are already known.
- Make the single call substantial but coherent. Read-only commands may be combined when their paths, patterns, ranges, and other arguments are known before the call. Combine mutations only when every target and change is already established by prior observations. Use \`&&\` or explicit error handling when a later command requires an earlier command to succeed. Do not emit generic planning words as commands; use actual project commands established from repository evidence. Keep output targeted, bounded, and clearly labelled. If a later command's selection, arguments, target, content, or safety depends on unseen output, end the turn and wait for the real observation.
- You don't know anything about the machine except what has been pasted into this conversation as an actual result. Base every claim about commands, files, paths, machine state, or completed changes on a result you actually received in this conversation. NEVER invent, reconstruct, remember, predict, or author a command's output or a file's contents. NEVER treat a step you drafted, a path named in the task, an instruction, an example, prior knowledge, or your own earlier statement as execution evidence. To learn something, draft a step and read the real result. A listing showing a file exists does not tell you what is inside it — do not report inferred content as observed fact.
- After receiving a real result, you may quote, summarise, and reason from it. Clearly distinguish what the result directly established from any inference you draw. Claim a change or task complete only when real observations verify the requested outcome.
- Request only the evidence needed for the current decision. Use targeted paths, searches, filters, and line ranges rather than unbounded output.
- Treat errors and empty output as evidence. Correct schema errors, narrow reads when output is truncated, and change the investigation before repeating a failed call. Conclude that something is unavailable only when returned evidence supports that conclusion. If a result is missing entirely, check that your last message rendered correctly before re-sending. If a result is merely unexpected, read it and adjust — an unexpected result is still a real result, and is not a reason to re-examine your own format.
- Ask the user only for information, authorization, or interaction that a step cannot provide. Investigate path errors and command failures with another step.
- For an action task, claim completion only when real results establish the requested outcome; otherwise state exactly what remains unverified or what evidenced blocker prevents it. "I'll now…" or "let me…" is not a final answer: if you are about to do something, draft the step. For a question that needs no execution, answer directly.

${toolsBlock}`;
}

export function formatFencedToolDefinitions(variant: string = "advisor", tools: ToolDef[] = []): string {
  return (variant === "agent" ? formatAgentPrompt(tools) : formatAdvisorPrompt()) + hostPlatformNote();
}

/** Short, wrapper-free rule re-attached to EVERY Claude (agent) turn. The full framing is
 *  only sent on turn 0; over a long session the model drifts. This is deliberately NOT the
 *  long aggressive prohibition — repeating the reserved `<tool_output>` wrapper every turn
 *  primes the very pattern we suppress (and empirically did not prevent it). The strong
 *  version is used only as an incident correction in the handler. */
export function agentTurnProhibition(): string {
  return "Here's the real result from your last step — read what it actually says before drafting the next one. One step per message: a line of prose, then one block, nothing after it.";
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
export function hostPlatformNote(platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return "";
  return `

HOST PLATFORM: Windows. The \`bash\` tool runs PowerShell on a real Windows machine — not Linux, and not a container. Any POSIX idiom named above is wrong here and will fail: there are no \`<<'EOF'\` heredocs, no \`sed -i\`, no \`ls\`/\`grep\`. Emit \`\`\`powershell blocks instead of \`\`\`bash, and use the Windows equivalents:

- create/overwrite a file: \`Set-Content -Path name -Value @'\n…\n'@\`
- edit in place: \`(Get-Content f) -replace 'old','new' | Set-Content f\`
- inspect: \`Get-Content\` / \`Get-ChildItem\` / \`Select-String\`
- paths use \`\\\` and may contain spaces — quote them.

You are NOT in a Linux sandbox and have no \`/mnt/data\`. The working directory is a real Windows path; run \`Get-Location\` if you need to see it.`;
}

export function currentFramingVariant(): string {
  return "advisor";
}

/** Claude tones get the execution-agent framing; every other tone the bash-only advisor. */
export function isAdvisorTone(tone?: string): boolean {
  return !/^Claude_/i.test(tone ?? "");
}

export function framingVariantForTone(tone?: string): string {
  return isAdvisorTone(tone) ? "advisor" : "agent";
}

// --- Parsing -----------------------------------------------------------------

// Match opening fence of 3 or more backticks with a tool-like info-string.
// Dots and hyphens are allowed so namespaced runtime tool names (```container.exec)
// can be recognised and routed.
const OPEN_FENCE_REGEX = /^( {0,3})(`{3,})([A-Za-z0-9_.-]+)[ \t]*$/;
/** Closing fence: 3+ backticks, optionally followed by inline prose. */
const CLOSE_FENCE_REGEX = /^ {0,3}`{3,}([ \t].*)?$/;
/** A line that is exactly a fenced tool label — M365's broken-opener shape. */
function isLabelToken(label: string, specs: Map<string, FencedToolSpec>): boolean {
  return specs.has(label) || SHELL_LANGS.has(label);
}
const RESULT_TAG_REGEX = /^[ \t]{0,3}<\/?(?:tool_output|tool_response|assistant)\b/im;

/** Lookahead used while walking a tool-call body: does a later BARE fence close an
 *  inner Markdown code block before any new tool call or self-authored result tag
 *  appears? A bare ``` with no language token is ambiguous — it can be the tool
 *  call's closer, or the opener of a plain fenced block inside a `write` body.
 *  When a later bare fence follows, the current one is the inner opener (body
 *  content); otherwise it is the tool call's closer. */
export function hasBareFenceFollower(
  lines: string[],
  index: number,
  specs?: Map<string, FencedToolSpec>,
): boolean {
  for (let j = index + 1; j < lines.length; j++) {
    const l = lines[j];
    if (RESULT_TAG_REGEX.test(l)) return false;
    const open = l.match(OPEN_FENCE_REGEX);
    if (open && (specs?.has(open[3]) || SHELL_LANGS.has(open[3]))) return false;
    if (CLOSE_FENCE_REGEX.test(l)) return true;
  }
  return false;
}
const HEREDOC_OPEN_REGEX = /(?:^|[^<])<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;

const SEARCH_REPLACE_REGEX =
  /<{5,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={5,}\s*\r?\n([\s\S]*?)\r?\n>{5,}\s*REPLACE/;

/** Restore M365's missing opening fence.
 *
 *  M365 renders the OPENING ``` of a code block as a bare info-string line — it
 *  emits the language label (`bash`) *without* the backticks — while emitting the
 *  CLOSING ``` literally. So the streamed/reconstructed text is
 *  `…prose\nbash\n<commands>\n``` ` (no opener), which the fence parser can't
 *  recognise, and the turn silently degrades to prose even though the model
 *  fenced its command.
 *
 *  This rewrites a line that is *exactly* a known tool / shell-language token and
 *  is followed (before any other fence) by a closing ```, into a proper
 *  ```` ```<label> ```` opener. Idempotent, and a no-op on well-formed text.
 *
 *  Regression: live 61sol run 2026-10-09 06:39:47 (FINAL-REPORT.md collation). */
/** True if a closing fence appears after index i before any other opening fence. */
function hasClosingFenceAfter(lines: string[], i: number): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    if (CLOSE_FENCE_REGEX.test(lines[j])) return true;
    if (OPEN_FENCE_REGEX.test(lines[j])) return false;
  }
  return false;
}

/** Index of the first ``` in `line` that is NOT inside a single- or double-quoted
 *  shell argument, or -1 if every ``` on the line is quoted.
 *
 *  Used by restoreM365Fences Pass 2: a ``` inside a quoted argument is DATA (e.g.
 *  `grep -q '```suggestion' "$OUT"`), not M365's glued closing fence. Splitting there
 *  corrupts the command and trips the post-fence guard (log 2026-10-12 19:07:43Z,
 *  cid c3f86119 — the harness ran a command truncated at `grep -q '`).
 *
 *  Quote state is tracked WITHIN the line only. Carrying it across lines would mis-scan
 *  the common stray apostrophe in a comment/prose (`# don't`), while multi-line quoted
 *  strings are vanishingly rare in model output. */
function indexOfUnquotedBackticks(line: string): number {
  let state: 0 | 1 | 2 = 0; // 0 = none, 1 = single-quoted, 2 = double-quoted
  for (let k = 0; k < line.length; k++) {
    const ch = line[k];
    if (state === 1) {
      if (ch === "'") state = 0; // single quotes: no escaping
      continue;
    }
    if (state === 2) {
      if (ch === "\\") { k++; continue; } // double quotes: \ escapes the next char
      if (ch === '"') state = 0;
      continue;
    }
    if (ch === "'") { state = 1; continue; }
    if (ch === '"') { state = 2; continue; }
    if (ch === "\\") { k++; continue; }
    if (line.startsWith("```", k)) return k;
  }
  return -1;
}

export function restoreM365Fences(text: string, specs: Map<string, FencedToolSpec>): string {
  // Pass 0: M365 escapes `]` as `\]` when it looks like a Markdown link reference
  // (`…]:`), leaking a backslash into code the harness then runs — bash "bad
  // substitution: no closing } in ${files[@\]:1}", Python "SyntaxError: unexpected
  // character after line continuation character". `\]:` is essentially never intended
  // in real code, and a `]` preceded by a real backslash or inside a regex class
  // (`[\]]`, sed `\]`) has no `:` after it, so it's left untouched.
  text = text.replace(/\\\]:/g, "]:");

  // Pass 1: M365 sometimes glues the opening fence to the end of the prose line
  // (`…output limit.```bash`) with no newline, so the opener isn't at line start
  // and OPEN_FENCE_REGEX misses it. Split it onto its own line.
  // Prefix must end in a real (non-backtick, non-space) char, so a fence's own
  // backticks (` ````write_file `) aren't mistaken for prose.
  const GLUED_OPEN_REGEX = /^(.*[^\s`])(`{3,})([A-Za-z0-9_.-]+)[ \t]*$/;
  const src = text.split(/\r?\n/);
  const lines: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const g = src[i].match(GLUED_OPEN_REGEX);
    if (g && isLabelToken(g[3], specs)) {
      // A prose line that ends in a tool-token fence opener is a fence attempt — split
      // it. Don't require a closing fence: the block can be unterminated and is then
      // parsed by the EOF flush (previously this guard dropped such openers).
      lines.push(g[1].replace(/[ \t]+$/, ""));
      lines.push(g[2] + g[3]);
    } else {
      lines.push(src[i]);
    }
  }

  // Pass 2: M365 can drop the opening fence entirely, leaving a bare language
  // label line (`bash\n<code>\n``` `). Restore the ``` before the label.
  let inBlock = false;
  let blockIsShell = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock) {
      if (CLOSE_FENCE_REGEX.test(line)) { inBlock = false; continue; }
      // M365 glues the CLOSING fence to adjacent text — mid-line
      // (`head -n 500```STATUS: …`) OR at line start with no space (` ```STATUS: …`).
      // Split the fence onto its own line and keep any trailing text as prose, so the
      // command isn't corrupted and the block actually closes.
      //
      // In a SHELL body a ``` inside a quoted argument is DATA, not a fence, so skip
      // quoted backticks (see indexOfUnquotedBackticks). Non-shell bodies keep the
      // original whole-line scan.
      if (!OPEN_FENCE_REGEX.test(line)) {
        const tick = blockIsShell ? indexOfUnquotedBackticks(line) : line.indexOf("```");
        if (tick >= 0) {
          const before = line.slice(0, tick);
          const after = line.slice(tick + 3);
          const repl = [...(before ? [before] : []), "```", ...(after ? [after] : [])];
          lines.splice(i, 1, ...repl);
          continue;
        }
      }
      continue;
    }
    const open = line.match(OPEN_FENCE_REGEX);
    if (open) { inBlock = true; blockIsShell = SHELL_LANGS.has(open[3]); continue; }
    const label = line.trim();
    if (!label || !isLabelToken(label, specs)) continue;
    if (hasClosingFenceAfter(lines, i)) {
      const indent = line.slice(0, line.length - line.trimStart().length);
      lines[i] = `${indent}\`\`\`${label}`;
      inBlock = true;
      blockIsShell = SHELL_LANGS.has(label);
    }
  }
  return lines.join("\n");
}

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
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") { i++; break; }
    const m = line.match(/^([A-Za-z0-9_]+):[ \t]?(.*)$/);
    const target = m ? resolveDeclaredParam(spec, m[1]) : undefined;
    const isHeaderParam = target !== undefined && spec.headerParams.includes(target);
    // A tool whose only param is its body (e.g. a single-`path` read) accepts one
    // leading header line naming that param, so `filePath: x` isn't swallowed whole
    // as body text.
    const isBodyParamHeader = i === 0 && target !== undefined && target === spec.bodyParam;
    if (m && (isHeaderParam || isBodyParamHeader)) {
      const val = m[2].trim();
      if (val === "true") args[target!] = true;
      else if (val === "false") args[target!] = false;
      else if (/^-?\d+(\.\d+)?$/.test(val)) args[target!] = Number(val);
      else args[target!] = m[2];
    } else {
      break;
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
    // A header line may already have supplied this param (e.g. `filePath:` naming a
    // single-`path` tool); an empty body must not clobber it back to "".
    if (restTrimmed !== "" || args[spec.bodyParam] === undefined) {
      // Auto-parse a JSON-looking body ONLY when the tool declares a structured param
      // (question's `questions: array`, a todo list, …). A `string` body is verbatim
      // data: writing a .json file must reach the harness as text, not as an object it
      // rejects at schema validation.
      const structuredBody = spec.bodyType !== "string";
      if (
        structuredBody &&
        ((restTrimmed.startsWith("[") && restTrimmed.endsWith("]")) ||
          (restTrimmed.startsWith("{") && restTrimmed.endsWith("}")))
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
 * Shared state for walking the body of a single tool-call fence. Used by both the
 * parser (`parseFencedToolCalls`) and the post-fence contamination guard
 * (`hasPostFenceContamination` in the proxy) so nested-fence and heredoc handling
 * live in exactly one place rather than being duplicated.
 */
export interface FenceBodyState {
  /** Backtick-lengths of open nested code fences inside the body. */
  inner: number[];
  /** Active bash heredoc delimiters inside the body. */
  heredocs: string[];
  /** True while inside an edit tool's SEARCH/REPLACE region. */
  inSearchReplace: boolean;
}

export function createFenceBodyState(): FenceBodyState {
  return { inner: [], heredocs: [], inSearchReplace: false };
}

/**
 * Feed one line of a tool-call fence body and decide whether it closes the OUTER
 * tool fence. Shared by the parser and the post-fence contamination guard so
 * nested-fence and heredoc handling live in exactly one place.
 *
 * A tool-call fence's BODY is OPAQUE: only a bare closing fence (3+ backticks
 * with no tool name) with no open inner fence or heredoc ends the tool block.
 * Everything else is body content:
 * - a line inside an active heredoc is opaque (may contain ``` fences);
 * - a ```lang line opens a nested code fence (e.g. a `write` whose content is a
 *   Markdown doc embedding ```python), and the following bare ``` closes the INNER
 *   fence rather than the tool (honouring CommonMark's variable-length rule);
 * - inside an edit's SEARCH/REPLACE region, ``` lines are body content.
 *
 * Returns true when `line` closes the outer tool fence; false otherwise (the line
 * is body content and any relevant state has been updated).
 */
export function feedToolBodyLine(
  line: string,
  state: FenceBodyState,
  outerFenceLen: number,
  isEdit: boolean,
  bareFollower: boolean = false,
): boolean {
  if (state.heredocs.length > 0) {
    if (line.trim() === state.heredocs[state.heredocs.length - 1]) state.heredocs.pop();
    return false;
  }
  const h = line.match(HEREDOC_OPEN_REGEX);
  if (h) state.heredocs.push(h[1]);

  if (isEdit) {
    if (line.includes("<<<<<<< SEARCH")) state.inSearchReplace = true;
    if (state.inSearchReplace) {
      if (line.includes(">>>>>>> REPLACE")) state.inSearchReplace = false;
      return false;
    }
  }

  const open = line.match(OPEN_FENCE_REGEX);
  if (open) {
    state.inner.push(open[2].length);
    return false;
  }

  const close = line.match(/^( {0,3})(`{3,})([ \t].*)?$/);
  if (close) {
    const n = close[2].length;
    if (state.inner.length > 0 && n >= state.inner[state.inner.length - 1]) {
      state.inner.pop();
      return false;
    }
    // A bare fence with no open inner is ambiguous: it either closes the tool call
    // or OPENS a plain (language-less) Markdown block inside a write/edit body — the
    // ordinary way a report embeds a code sample. Inline prose after the backticks
    // (`…``` — next I'll …`) marks a real closer with glued trailing prose; a CLEAN
    // bare fence followed by another bare fence (before any new tool call / result
    // tag) is an inner opener. Without this, a body like `…\n```\ncode\n```\n…` was
    // truncated at the first bare ``` (live 2026-10-17).
    const trailing = (close[3] ?? "").trim();
    if (!trailing && bareFollower) {
      state.inner.push(n);
      return false;
    }
    return n >= outerFenceLen;
  }
  return false;
}

/**
 * Parse all fenced tool calls whose info-string matches a known tool name.
 * 
 * Supports:
 * - CommonMark variable fence length: ```` ```tool ```` closed by at least 3 backticks,
 *   ```` ````tool ```` closed by at least 4 backticks.
 * - Shell heredoc awareness: when inside a bash/shell block with an active heredoc
 *   (e.g. `cat <<'END'`), nested ```` ``` ```` lines do not prematurely close the tool fence.
 * - Nested code fences inside a tool body (e.g. a `write` whose content is a Markdown
 *   doc embedding ```python): the inner fence is body content, not the tool's closer.
 * - Consecutive fence transitions without closing backticks (e.g. ```` ```bash ... ```bash ````).
 * - EOF flush for streams ending without a decorative closing fence.
 */
export function parseFencedToolCalls(
  text: string,
  specs: Map<string, FencedToolSpec>,
): FencedParseResult {
  const calls: ParsedToolCall[] = [];
  const lines = restoreM365Fences(text, specs).split(/\r?\n/);

  let inBlock = false;
  let fenceLen = 3;
  let toolSpec: FencedToolSpec | null = null;
  let blockLines: string[] = [];
  let matchedIndices: { start: number; end: number }[] = [];
  let blockStartIndex = 0;
  // Nested-fence + heredoc + SEARCH/REPLACE tracking for the tool body, shared with
  // the post-fence contamination guard (see feedToolBodyLine).
  let bodyState = createFenceBodyState();
  // Prose glued to the end of a closing-fence line (`… ``` — next I'll …`) is valid
  // content that FOLLOWS the tool call. Keep it, so a fence between two prose runs is
  // emitted as (leading prose) + tool_call + (trailing prose).
  const trailingProse: string[] = [];

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
          bodyState = createFenceBodyState();
        }
      }
    } else {
      // A tool-call fence's BODY is OPAQUE: nested ```<tool> fences, heredocs, and edit
      // SEARCH/REPLACE regions are all body content. feedToolBodyLine tracks that state
      // (in one shared place with the post-fence guard) and returns true only when a bare
      // ``` with no open inner fence or heredoc closes the OUTER tool fence.
      if (feedToolBodyLine(line, bodyState, fenceLen, !!toolSpec?.editPair, hasBareFenceFollower(lines, i, specs))) {
        // Closing fence reached (possibly with prose glued after it on the same line).
        const inner = blockLines.join("\n");
        const args = parseFencedInner(toolSpec!, inner);
        if (args) {
          calls.push(makeCall(toolSpec!.name, args));
          matchedIndices.push({ start: blockStartIndex, end: i });
        }
        const closeMatch = line.match(/^( {0,3})(`{3,})([ \t].*)?$/);
        const trailing = closeMatch?.[3]?.trim();
        if (trailing) trailingProse.push(trailing);
        inBlock = false;
        toolSpec = null;
        blockLines = [];
        bodyState = createFenceBodyState();
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

  // Build leftover text by excluding matched line ranges (plus prose glued after a closer).
  const leftoverLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isMatched = matchedIndices.some((range) => i >= range.start && i <= range.end);
    if (!isMatched) {
      leftoverLines.push(lines[i]);
    }
  }
  leftoverLines.push(...trailingProse);

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

/** Offset of the earliest opener in `buf` whose info-string is a known tool, or -1.
 *  Matches fences on their own line (≤3 leading spaces) AND fences glued to the end of
 *  a prose line (`...prose```bash`) — M365 emits both, and the parser (restoreM365Fences)
 *  already accepts the glued form. If the gate only matched own-line fences, the glued
 *  fence — and everything after it — would leak into the streamed prose. Returns the
 *  offset of the backticks, so the fence itself and anything after it are never emitted. */
function findToolFenceOffset(buf: string, specs: Map<string, FencedToolSpec>): number {
  const re = /(`{3,})([A-Za-z0-9_.-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(buf)) !== null) {
    const i = m.index;
    if (!specs.has(m[2])) continue;
    const prev = i > 0 ? buf[i - 1] : "\n";
    if (i === 0 || prev === "\n") return i; // own-line opener
    if (prev === " ") {
      let s = i;
      while (s > 0 && buf[s - 1] === " ") s--; // leading indentation
      if (s === 0 || buf[s - 1] === "\n") return i; // indented opener
      continue;
    }
    if (prev !== "`" && prev !== "\r") return i; // glued opener (`...contract.```read`)
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

