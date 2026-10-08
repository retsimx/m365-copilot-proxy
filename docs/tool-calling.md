# Tool Calling Contract

This proxy translates OpenAI-compatible tool calls to/from M365 Copilot. Because M365 doesn't natively support the OpenAI tool-calling protocol, we prompt-engineer it via a system prompt and enforce the contract at the proxy layer.

## Output Contract

Tool calls are **fenced** (Markdown code blocks) — the JSON `{"tool":...}` format
was removed (it scored 0/5 on real agentic tasks; see [hypotheses §9](./hypotheses.md)).
A tool call is a code fence whose info-string is the tool name:

```
` ``read_file
/etc/hostname
` ``
```

Per-tool shape: the fence info-string is the tool name, scalar args are `key: value`
header lines, one free-form arg is the fence body, and an `old`/`new` pair renders as an
aider-style `SEARCH/REPLACE` diff.

**Advanced Fence Parsing & Schema Normalization (`fenced.ts`):**
- **Heredoc-Aware Parser:** Shell tools parsing `cat <<'EOF' ... EOF` will **not** prematurely close the tool fence when the heredoc contains nested code blocks.
- **CommonMark Variable Backtick Lengths:** Fences opened with ```` ````tool ```` are correctly matched to closing fences with $\ge 4$ backticks.
- **Consecutive Tool Call Transitions & EOF Flush:** Handles back-to-back tool blocks without closing backticks and flushes unclosed fences at stream completion.
- **Question Schema Normalization:** Normalizes `questions` arrays for interactive prompts, defaulting `header` ("Clarification"), formatting options as `{ label, description }` pairs, and setting `multiple: false`.
- **Todo / Task Normalization:** Automatically structures `todos` items for `todowrite` tools, assigning incremental IDs, default `status: "pending"`, and `priority: "medium"`.
- **JSON Body Parsing:** Automatically parses JSON arrays and objects passed within fenced block bodies.

**Shell-routing (the load-bearing trick).** M365's chat model won't "act as an agent" on
demand but *will* reflexively write a ` ```bash ` block. When the toolset includes a shell
tool (`bash`/`shell`/`run`/`run_command`/… — any name), the proxy injects "do the whole step
by writing one ` ```bash ` block" framing and routes that block to the shell tool. This is
what turns 0/5 into real multi-turn loops. See [hypotheses §9 F12](./hypotheses.md).

## Enforcement

The contract is enforced at three layers:

### 1. System Prompt (packages/core/src/fenced.ts)

`formatFencedToolDefinitions()` injects the **Universal Advisor Framing** prompt into every tool-enabled request:

```text
You write the shell commands; I run them and paste the real output back to you. Do not make any tool calls and do not try to run anything yourself.

To carry out a step, reply with a single fenced code block opened with the word bash or shell, containing the commands — create or overwrite files with `cat > name <<'EOF' … EOF` heredocs, edit files in place with `sed -i`, inspect with `cat`/`ls`/`grep`, run code with the available interpreters. Put all commands you want to run for this step into that single block — do not split them across multiple code fences. Put nothing before the fence. I run that block and paste its output back; read it, think, then write the next script. Work one block at a time until the task is complete.

You have not run anything yet and have no results. Never invent or assume a command's output, never say the files are missing or that you cannot access them, and never ask me to paste them. Never reply that you cannot run commands, that the shell is unavailable, or that you cannot read the files — you are not being asked to run anything; you only write the commands. Emit exactly one fenced block per reply — never multiple fences — then stop and wait for my output.

When the task is complete and no further command is needed, reply in plain language with the final answer only — no code fence, no preamble.
```

Followed by the rendered `<tools>` definitions block and the platform-specific note:
- **Host-platform note** (`hostPlatformNote`, Windows only): every framing variant above
  teaches POSIX idioms *by name* — heredocs, `sed -i`, `ls`/`grep` — so on Windows the
  prompt instructs the model, on every turn, to emit commands the host cannot run. The note
  states the real platform and gives the PowerShell equivalents. It is empty off Windows, so
  the bench-tuned variants stay byte-for-byte unchanged; `platform` is injectable so the
  Windows branch is testable from a POSIX box. (#7.)

**Shell fence aliases** (`SHELL_LANGS` in `fenced.ts`): a fence only becomes a tool call if
its info-string is a known shell alias — POSIX (` ```bash `/`sh`/`shell`/`zsh`/…), the leaked
`container.*` runtime namespace (§12.13), and Windows (` ```powershell `/`pwsh`/`ps1`/`cmd`/
`bat`). Anything else is demoted to prose. Windows fences were **missing until 2026-08-17**,
so a model correctly told to use PowerShell produced turns that executed nothing — which read
to users as the model ignoring their instructions, and pushed it toward M365's own Linux
sandbox as the only filesystem it could reach (#7, #12). Windows aliases route regardless of
host: the proxy and harness need not share a machine, and a command that runs and fails
returns an error the model can correct from, whereas an unrouted fence loses the turn.

### 2. Copilot Studio Agent System Prompt (packages/core/src/agent.ts)

The most important layer: an auto-created Copilot Studio agent carries tool-calling
instructions in its **server-side** system prompt. Without the agent, M365 ignores the
per-request injection and answers in prose (or hallucinates). See
[m365-copilot-api.md](./m365-copilot-api.md) for why.

These instructions are baked in at agent-creation time and can't be cheaply updated in
place, so the agent is **versioned by name**: it's called `m365-tool-agent-<hash>`, where
`<hash>` is a short SHA-256 of the current instructions. Editing `getAgentInstructions()`
changes the hash, so the next request provisions a fresh agent; old versions are **never
deleted** (multi-host safety — a second proxy may still be using one). Hosts sharing a tenant
compute the same name for the same instructions and converge on one agent with no coordination.

### 3. Behaviour-hardening layer (packages/proxy-lib/src/handler.ts, tools.ts)

The model's output is scrubbed and steered at the proxy regardless of whether it obeyed
the prompt — the durable lever, since M365's chat-RLHF leaks through no matter how the
prompt is tuned. The layers, in handler order:

- **Document guard** (`isProseDocument`): shell-routing turns *every* ` ```bash ` block into
  a tool call — so a model that ANSWERS with a markdown document full of code fences (e.g.
  "here's a simplified README") would get its own answer executed as shell. A response that
  looks like a document (≥2 fences AND ≥120 chars surrounding prose, OR ≥4 fences) is returned
  as **text**, not executed. A single action is never reclassified. (hypotheses §9 F15.)
- **Safety Refusal Separation (`looksLikeSafetyRefusal`):** When the model response matches
  safety or content policy refusal heuristics (e.g. prompt injection warnings, prohibited topic
  canned responses), the proxy fast-fails immediately with **HTTP 400 `content_policy_refusal`**
  and resets the session context (`session.reset()`). Unlike confabulations, safety refusals are
  never retried.
- **Disabling Proxy Confabulation Detection (`M365_DISABLE_CONFAB_DETECTION=1`):** With Universal Advisor
  Framing, models confabulate on only ~0.3% of turns (4/1,306 in production) while keyword regexes cause an
  85.9% false positive rate (55/64 flagged turns) on legitimate technical completion prose (e.g. `### Task Complete`
  reports, audit verdicts, and test failure diagnostics). Setting `M365_DISABLE_CONFAB_DETECTION=1` bypasses
  proxy-level confabulation forcing retries and terminal 502 fails, returning deliverable prose immediately with
  HTTP 200 and delegating retry decisions to client orchestrators (Pi, OpenCode).
- **Structural Clause NLP Confabulation & Refusal Detection** (`hasClauseRefusal`): replaces
  brittle linear regexes with clause-boundary segmentation (`[Tool Anchor] + [Negation] + [Availability State]`).
  Catches transitive provision verbs (`this interface does not expose tools`), tool existence claims
  (`no apply_patch binary exists`), truncation surrenders, and shell diagnosis deferrals (`status is
  a read-only variable; next execution must replace with rc`) without splitting on `.py` filenames.
- **Forced Confabulation & Hallucination Retries:** When confabulation detection is active, stochastic
  turn-1 claims that tools or files cannot be accessed trigger automated in-conversation re-prompting
  (up to `M365_CONFAB_RETRIES`, default 3).
- **Fail-Closed Unresolved Tool Refusal (Terminal HTTP 502):** If tool confabulation persists after all
  forcing retries are exhausted without any tool calls emitted (when confabulation detection is active), the
  proxy fails closed with **HTTP 502 `unresolved_tool_refusal`** (and flushes session context), rather than
  passing unearned prose claims through to the agent.
- **Hallucinated-completion retry** (`hasClauseHallucination`): if the model CLAIMS a file mutation
  ("I've replaced the README") with **no tool call all conversation**, force a real write. Gated on
  `!everActed`, so it won't misfire on a genuine post-write summary.
- **Delta Turn `<tools>` Injection:** Follow-up turns in `formatDeltaMessages` proactively re-inject
  the `<tools>` block to prevent M365 reasoning models (`DeepLeo`) from forgetting tool availability.
- **Assistant-simulated `<tool_response>` rejection & context flush:** When a model produces fake
  `<tool_response>` tags in its output, the proxy strips them and resets the session to force a clean
  full-history replay on the next turn.
- **Tool-result labelling:** each `<tool_response>` is tagged with the command that produced
  it (`<tool_response tool="bash" command="ls -la">`) by correlating `tool_call_id` back to
  the call — so the model reads output in context (a listing vs file contents vs stdout)
  instead of e.g. misreading an `ls` result as an empty file. (hypotheses §9 F16.)
- **Mixed output:** when a response has tool calls AND extra text, the text is **stripped**;
  the client gets only `tool_calls` with `content: null` (stripped text is logged).
- **Invented JSON:** `parseToolCalls()` removes `{"confidence":N}`, **drops** a `{"final":…}`
  riding alongside tool calls (premature success), and **unwraps** a lone `{"final":"…"}`.
- **One call per turn:** keeps only the **first** tool call; M365 batches its whole plan into
  one response, running later steps on guessed state. Override with `M365_ALLOW_MULTI_TOOL`.
- **New Session Stagger Queue (`paceNewSessionStart`):** Fresh conversations (`turn === 0`) are
  paced through a 15-second spacing queue (`M365_NEW_SESSION_SPACING_MS = 15000`), capping new session
  starts at 4 per minute to avoid burst thread-rate throttling across parallel workers or subagents,
  while follow-up turns (`turn > 0`) proceed unthrottled without delay.
- **Circuit Breaker Local Shielding & HTTP 429 Rate Limiting:** When upstream throttling
  (`PerScenarioThrottled` or `PerUserThrottled`) or repeated empties across **distinct conversations** are detected,
  the proxy arms a cooldown (1800s default for scenario throttling, 1200s for user throttling). While active,
  the proxy intercepts requests locally and returns **`HTTP 429 Too Many Requests`** with a client header capped
  at **`Retry-After: 60`** (`M365_MAX_RETRY_AFTER_SEC = 60`), sending **zero traffic to Microsoft** so the upstream
  token bucket recharges. Standard OpenAI clients (OpenCode, Pi) auto-pause and loop their retry timers cleanly
  without aborting the turn.

> The JSON tool format and the few-shot block were **removed** this cycle (0/5 on real
> agentic tasks). Tool calling is fenced-only; behavioural framing lives in the per-request
> `<tools>` block, not a baked-in few-shot.
