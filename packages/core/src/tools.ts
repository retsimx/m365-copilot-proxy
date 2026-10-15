import { createLogger } from "./log.js";
import {
  buildSpecMap,
  currentFramingVariant,
  deriveFencedSpec,
  formatFencedToolDefinitions,
  parseFencedToolCalls,
  renderFencedCall,
  SHELL_LANGS,
} from "./fenced.js";
import { classifyTurnResponse } from "./classifier.js";

const log = createLogger("tools");

// Tool calls use the **fenced** Markdown format exclusively (see fenced.ts and
// docs/hypotheses.md §9). The old `{"tool":...,"arguments":{}}` JSON format was
// removed — it produced 0/5 on real agentic tasks; fenced + shell-routing produces
// genuine multi-turn loops. We still *parse* a stray JSON tool call as a tolerance
// fallback (M365 occasionally emits one), but we never instruct the model to use it.

// --- Types (standalone, no zod dependency) ---

export interface ToolFunction {
  name: string;
  description?: string;
  parameters?: {
    properties?: Record<string, { type?: string; [k: string]: unknown }>;
    required?: string[];
    [k: string]: unknown;
  };
}

export interface ToolDef {
  type?: string;
  function: ToolFunction;
}

export interface Message {
  role: string;
  content?: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } }
  | undefined;

// --- Tool call format ---

// Fenced Markdown is the format we instruct and primarily parse (see fenced.ts).
// The regex below is a tolerance-only FALLBACK: M365 occasionally ignores the
// fenced contract and emits a stray `{"tool":...,"arguments":{...}}` object. We
// parse it if it shows up but never teach the model to produce it — the JSON
// format scored 0/5 and was removed (§9). (The legacy ```tool_call fence wrapper
// was removed too: TOOL_CALL_REGEX already matches the JSON inside it, and the
// leftover fence markers are stripped below.)
const TOOL_CALL_REGEX = /\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;

// M365 invents bookkeeping objects ({"confidence": 0.5}) and wraps its answer in
// {"final": "..."} — neither is a real tool call. Strip confidence everywhere;
// drop final when it rides alongside tool calls (it's usually a premature
// success claim), and unwrap it when it stands alone as the response.
const CONFIDENCE_REGEX = /\{\s*"confidence"\s*:\s*-?[0-9.]+\s*\}/g;
const FINAL_OBJECT_REGEX = /\{\s*"final"\s*:\s*"(?:[^"\\]|\\.)*"\s*\}/g;

/** Strip invented confidence/final objects from a no-tool-call response and
 *  unwrap a lone {"final": "..."} answer into bare text. Returns null if empty. */
function cleanLooseText(text: string): string | null {
  let out = text;
  for (const m of out.match(FINAL_OBJECT_REGEX) ?? []) {
    try {
      const value = JSON.parse(m).final;
      if (typeof value === "string") out = out.replace(m, value);
    } catch {
      // leave the literal text in place if it isn't valid JSON
    }
  }
  out = out.replace(CONFIDENCE_REGEX, "").trim();
  return out.length ? out : null;
}

// --- Formatting ---

/** The session framing, hand-written (bash-only; no tool descriptions are ever injected).
 *  Historically named `formatToolDefinitions`; it never formats or emits tool defs. */
export function formatSessionFraming(variant: string = "advisor", tools: ToolDef[] = []): string {
  return formatFencedToolDefinitions(variant, tools);
}

export function formatToolChoiceInstruction(toolChoice: ToolChoice): string {
  if (!toolChoice || toolChoice === "auto") return "";
  if (toolChoice === "none") return "\nDo NOT call tools. Text only.";
  if (toolChoice === "required") return "\nYou MUST call at least one tool.";
  if (typeof toolChoice === "object" && toolChoice.function) {
    return `\nYou MUST call "${toolChoice.function.name}".`;
  }
  return "";
}

export function getMessageContent(msg: Message): string {
  if (msg.content === null || msg.content === undefined) return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content.map((p) => p.text || "").join("");
}

/** A short one-line description of what a tool call did, for labelling its result
 *  (e.g. the shell command, or the file path). Newlines collapsed, truncated. */
function toolCallSummary(rawArgs: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
  } catch {
    return "";
  }
  const primary =
    args.command ?? args.cmd ?? args.script ?? args.path ?? args.file ??
    args.filename ?? args.query ?? Object.values(args).find((v) => typeof v === "string");
  if (typeof primary !== "string") return "";
  return primary.replace(/\s+/g, " ").replace(/"/g, "'").trim().slice(0, 100);
}

/**
 * Inject a synthetic `reply(text)` tool that the model calls instead of
 * answering in prose. Wired by the handler (which converts `reply` back to a
 * plain assistant message), so it's invisible to the client. Off by default —
 * set `M365_INJECT_REPLY_TOOL=1` to enable.
 *
 * Why this matters: M365 mostly disobeys "only emit JSON" when the right
 * answer is text. Routing text through a `reply()` call makes EVERY turn a
 * tool call, which is a much cleaner contract for the model to follow.
 *
 * Tradeoff: adds 1 tool to the prompt, which nudges the Disengaged-filter
 * threshold a tiny bit. Safe with lean toolsets (<= ~10 tools).
 */
function maybeInjectReplyTool(tools: ToolDef[]): ToolDef[] {
  const enabled = process.env.M365_INJECT_REPLY_TOOL || currentFramingVariant() === "reply_tool";
  if (!enabled) return tools;
  if (tools.some((t) => t.function.name === "reply")) return tools;
  const replyTool: ToolDef = {
    type: "function",
    function: {
      name: "reply",
      description:
        "Send a plain-text answer to the user. Use this whenever you would otherwise reply in prose.",
      parameters: {
        type: "object",
        properties: { text: { type: "string", description: "The text to send" } },
        required: ["text"],
      },
    },
  };
  return [replyTool, ...tools];
}

export function formatMessages(
  messages: Message[],
  tools?: ToolDef[],
  toolChoice?: ToolChoice,
  conversationId?: string,
  framingVariant?: string,
): string {
  const parts: string[] = [];

  if (conversationId) {
    parts.push(`<conversation_id>${conversationId}</conversation_id>`);
  }

  const effectiveTools = tools ? maybeInjectReplyTool(tools) : tools;
  const specMap = effectiveTools ? buildSpecMap(effectiveTools) : null;
  if (effectiveTools && effectiveTools.length > 0 && toolChoice !== "none") {
    parts.push(`<system>\n${formatSessionFraming(framingVariant, effectiveTools ?? [])}${formatToolChoiceInstruction(toolChoice)}\n</system>`);
  }

  // Correlate each tool result back to the call that produced it, so the model
  // sees WHICH command's output it's reading (e.g. `bash: ls -la`). Without this
  // the result is labelled "unknown" and the model misreads it — observed: it ran
  // `ls`, saw `README.md`, and concluded the *file* was empty (docs §9 F15-adjacent).
  const callMeta = new Map<string, { name: string; summary: string }>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const tc of m.tool_calls) {
        if (tc.id) callMeta.set(tc.id, { name: tc.function.name, summary: toolCallSummary(tc.function.arguments) });
      }
    }
  }

  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      const calls = m.tool_calls.map((tc) => {
        const rawArgs = tc.function.arguments;
        let argsObj: Record<string, unknown> = {};
        try {
          argsObj = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
        } catch {
          // fall through with empty args; better than crashing the transcript
        }
        // Prefer the request's tool schema; otherwise synthesize one from the
        // recorded argument keys so a tool no longer in scope still renders.
        const spec = specMap?.get(tc.function.name) ?? deriveFencedSpec({
          type: "function",
          function: {
            name: tc.function.name,
            parameters: {
              properties: Object.fromEntries(
                Object.keys(argsObj).map((k) => [k, { type: "string" }]),
              ),
            },
          },
        });
        return renderFencedCall(spec, argsObj);
      }).join("\n");
      const content = getMessageContent(m);
      parts.push(`<assistant>${content ? "\n" + content : ""}\n${calls}\n</assistant>`);
    } else if (m.role === "tool") {
      const meta = m.tool_call_id ? callMeta.get(m.tool_call_id) : undefined;
      const name = m.name || meta?.name || "tool";
      // Show the command/args that produced this output so the model reads it in
      // context (a directory listing vs file contents vs a command's stdout).
      const cmdAttr = meta?.summary ? ` command="${meta.summary}"` : "";
      parts.push(`<tool_response tool="${name}"${cmdAttr}>\n${getMessageContent(m)}\n</tool_response>`);
    } else {
      parts.push(`<${m.role}>\n${getMessageContent(m)}\n</${m.role}>`);
    }
  }

  return parts.join("\n\n");
}

// --- Parsing ---

export interface ParsedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ParseResult {
  hasToolCalls: boolean;
  toolCalls: ParsedToolCall[];
  textContent: string | null;
}


// M365 sometimes creates a real patch in its Teams-hosted remote artifact
// store instead of calling the harness's local edit/write/bash tools. The link
// is valid in M365 but the referenced file is not present in the caller's
// working directory, so a later `git apply <basename>` inevitably fails.
// Every pattern must be ANCHORED to something only M365's remote runtime emits:
// a Teams artifact URL, a `sandbox:/mnt/data` path, or a citation marker. Talking
// about a "patch" or "diff" is normal for a coding agent, so an unanchored verb +
// noun pattern (e.g. /generated .{0,100} patch/) fires on "I generated a patch for
// review" and — because this detector fails closed below — turns an ordinary answer
// into a 502. Anchors are what separate a remote artifact from a local one.
const REMOTE_ARTIFACT_COMPLETION_PATTERNS: RegExp[] = [
  /sandbox:\/mnt\/data\/[^\s)\]]+/i,
  /https?:\/\/[^\s)\]]*asyncgw\.teams\.microsoft\.com\/[^\s)\]]+\.(?:patch|diff)(?:[?#][^\s)\]]*)?/i,
  // The remote artifact may be the whole updated source file rather than a
  // patch. Require a mutation claim near the Teams "views/original" URL so a
  // normal shared link is not mistaken for a failed local edit.
  /\b(?:updated|modified|replaced|rewrote|saved|applied|prepared|created)\b[\s\S]{0,600}https?:\/\/[^\s)\]]*asyncgw\.teams\.microsoft\.com\/[^\s)\]]*\/views\/original\//i,
  /https?:\/\/[^\s)\]]*asyncgw\.teams\.microsoft\.com\/[^\s)\]]*\/views\/original\/[\s\S]{0,600}\b(?:updated|modified|replaced|rewrote|saved|applied|prepared|created)\b/i,
  // Live GPT-5.6 variant: "Updated [plan.md](<turn1file1 citation>) locally".
  // The private-use citation resolves to an M365 artifact, not the harness disk.
  /\b(?:updated|modified|replaced|rewrote|saved|applied)\b[\s\S]{0,180}\uE200cite\uE202turn\d+file\d+\uE201/i,
  /\uE200cite\uE202turn\d+file\d+\uE201[\s\S]{0,180}\b(?:updated|modified|replaced|rewrote|saved|applied)\b/i,
];

/**
 * Did M365 substitute a remote Teams-hosted patch for a local filesystem edit?
 * Unlike the general hallucinated-completion detector this must fire even after
 * earlier tool calls: reading a file locally does not make a remote patch local.
 */
export function looksLikeRemoteArtifactCompletion(text: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < 12) return false;
  return REMOTE_ARTIFACT_COMPLETION_PATTERNS.some((re) => re.test(t));
}



/**
 * Did the model write a DOCUMENT (prose with embedded code fences) rather than
 * issue tool calls? The shell-routing parser greedily turns every ```bash block
 * into a tool call, so a model answering "here's a simplified README" — whose
 * markdown is full of ```bash / ```json examples — would get its own answer
 * executed as shell. Catch that: a real agentic turn is ONE action with little
 * prose; a document is multiple fences surrounded by substantial prose.
 *
 * Chosen empirically (scripts guard-experiment, README-about-bash fixture):
 * ≥2 fences AND (≥120 chars of surrounding prose OR ≥4 fences). A SINGLE action
 * is never reclassified regardless of prose, so the coding loop is untouched.
 */
/**
 * Distinguish a real agentic tool turn from an instructional markdown document.
 *
 * 1. If ANY tool call is a client-specific tool (e.g. skill, question, edit_file,
 *    write_file — anything not in SHELL_LANGS), it is an unambiguous agent action.
 * 2. If ALL tool calls are generic shell blocks (bash/sh) AND surrounded by
 *    substantial prose or markdown headings, it is treated as a tutorial document.
 */
export async function isProseDocument(parsed: ParseResult): Promise<boolean> {
  if (!parsed.hasToolCalls || parsed.toolCalls.length < 2) return false;

  // A refusal claiming inability to act is never an instructional tutorial document.
  // Decided by the classifier, not a regex heuristic.
  if ((await classifyTurnResponse(parsed.textContent)) === "REFUSAL") return false;

  // If any tool call is a non-shell client tool, it is definitively an agent action.
  const hasClientTool = parsed.toolCalls.some(
    (tc) => !SHELL_LANGS.has(tc.function.name),
  );
  if (hasClientTool) return false;

  const prose = parsed.textContent ? parsed.textContent.trim() : "";
  // A valid shell call between two prose runs is an ACTION, not a document. Do NOT
  // downgrade on prose *length* — that swallowed real tool calls (e.g. sonnet's
  // "read the file ```bash cat … ``` — then I'll update it" was returned as text
  // because the surrounding prose was long). Only document-level structure — a
  // markdown tutorial heading — downgrades a turn to prose. (A high fence COUNT is
  // not a document signal: it also matches batched actions, which one-call-per-turn
  // now truncates to the first call rather than reclassifying as a document.)
  return /(?:^|\n)#{1,3}\s+(?:readme|install|usage|run|getting started|build|setup|example|overview|configuration|documentation)\b/i.test(prose)
    || /(?:^|\n)#\s+[^\n]+/m.test(prose);
}

export function parseToolCalls(text: string, tools?: ToolDef[]): ParseResult {
  // If the model self-simulated a conversation by emitting a tool call followed by
  // a fake result tag (`<tool_response>` legacy, or `<tool_output>` — the tag our
  // framing now teaches) and subsequent output, isolate the text before the first
  // such tag so we salvage the real tool call(s) and discard the hallucinated
  // multi-turn script (fabricated results the harness never returned).
  const toolResponseMatch = text.match(/<(?:tool_response|tool_output|assistant)\b/i);
  let parseInput = text;
  if (toolResponseMatch && toolResponseMatch.index !== undefined && toolResponseMatch.index > 0) {
    const prefix = text.slice(0, toolResponseMatch.index);
    const specMap = tools && tools.length > 0 ? buildSpecMap(tools) : null;
    if (specMap) {
      const { calls } = parseFencedToolCalls(prefix, specMap);
      if (calls.length > 0) {
        parseInput = prefix;
      }
    }
  }

  // Fenced is the format: parse ```toolname blocks first. Needs the tool schemas
  // to map header/body args. The JSON parse below is only a tolerance fallback for
  // when M365 ignores the contract and emits a `{"tool":...}` object anyway.
  const specMap = tools && tools.length > 0 ? buildSpecMap(tools) : null;
  if (specMap) {
    const { calls, leftover } = parseFencedToolCalls(parseInput, specMap);
    if (calls.length > 0) {
      return { hasToolCalls: true, toolCalls: calls, textContent: cleanLooseText(leftover) };
    }
  }

  // The spec map carries the shell aliases too, so a JSON call naming a leaked
  // runtime tool (`container.exec`) resolves to the harness shell tool here.
  const resolveName = (raw: unknown): string | undefined =>
    typeof raw === "string" ? (specMap?.get(raw)?.name ?? raw) : undefined;

  const toolCalls: ParsedToolCall[] = [];

  // Tolerance fallback: a stray JSON tool call {"tool": "...", "arguments": {...}}
  const jsonRegex = new RegExp(TOOL_CALL_REGEX.source, "g");
  let match: RegExpExecArray | null;

  while ((match = jsonRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      const name = resolveName(parsed.tool);
      if (name) {
        toolCalls.push({
          id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
          type: "function",
          function: {
            name,
            arguments: typeof parsed.arguments === "string"
              ? parsed.arguments
              : JSON.stringify(parsed.arguments ?? {}),
          },
        });
      }
    } catch {
      log.error("Failed to parse tool call JSON:", match[0]);
    }
  }

  if (toolCalls.length === 0) {
    return { hasToolCalls: false, toolCalls: [], textContent: cleanLooseText(text) };
  }

  // Strip matched tool calls from text to get remaining content.
  // M365 is a markdown model and often wraps the JSON in a ```json / ```tool_call
  // fence even when told not to; remove the now-empty fence markers it leaves
  // behind so they aren't mistaken for real assistant prose. Also drop the
  // invented confidence/final objects so a premature "✅ SUCCESS" never reaches
  // the client and a junk-only leftover isn't flagged as mixed output.
  let remaining = text
    .replace(jsonRegex, "")
    .replace(CONFIDENCE_REGEX, "")
    .replace(FINAL_OBJECT_REGEX, "")
    .replace(/```(?:json|tool_call)?\s*```/g, "") // empty fence pair
    .replace(/```(?:json|tool_call)?/g, "") // dangling opening/closing fence
    .trim();

  return {
    hasToolCalls: true,
    toolCalls,
    textContent: remaining || null,
  };
}
