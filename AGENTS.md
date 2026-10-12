# AGENTS.md

Guidance for AI agents (and humans) working in this repo.

## What this is

`m365-copilot-proxy` wraps Microsoft 365 Copilot's undocumented SignalR/WebSocket
API in an **OpenAI-compatible** interface so OpenAI-compatible coding agents (notably
[pi](https://pi.dev/)) can use it as a model backend.

**Read [`docs/m365-copilot-api.md`](docs/m365-copilot-api.md) before touching the
protocol code** — it documents every quirk of the M365 API (auth, SignalR frames,
tones, throttling, the "Disengaged" filter, Copilot Studio agents). It is the source
of truth; keep it in sync if you change protocol behaviour.

[`docs/hypotheses.md`](docs/hypotheses.md) is the open-questions notebook —
tool-call compliance experiments, the search for token/context-window data, the
"how do we improve this proxy" backlog. Update it whenever an experiment lands.

[`docs/prompt-engineering.md`](docs/prompt-engineering.md) is the distilled
reference for **prompting the Copilot model into tool-calling** — the load-bearing
levers, the confirmed dead-ends, and the A/B scoreboard. Read it before tinkering
with framing/format.

**Where findings graduate to.** `docs/hypotheses.md` is the *messy, in-progress*
layer. Once a finding is **decently conclusive** (real evidence, not n=1 noise),
promote it out of the notebook into the right reference doc so it isn't lost:
- **Protocol / API behaviour** (frames, auth, tones, throttling, Disengaged,
  agents) → [`docs/m365-copilot-api.md`](docs/m365-copilot-api.md).
- **Prompting / tool-calling strategy** (what framing/format makes the model act,
  what backfires) → [`docs/prompt-engineering.md`](docs/prompt-engineering.md).
Leave a one-line pointer + evidence reference behind in the notebook.

## Operating principles (read first)

Hard-won defaults for working on this proxy. Internalize these before touching anything.

1. **Always run sequentially — one thread at a time.** Rate limiting operates across two horizons:
   - **Thread spawn rate (`PerScenarioThrottled`):** Tracks *conversations/threads started per unit time*,
     not messages (F13). Tripping it returns explicit `PerScenarioThrottled` completion frames and arms
     a 30-minute (1800s) cooldown. The proxy enforces a continuous token bucket + 15s stagger queue for
     fresh conversations (`turn === 0`) to cap thread creation at 4/min.
   - **Hourly turn volume (`PerUserThrottled`):** Tracks total turns dispatched across the account.
     The proxy's local ~120 turns / 60-minute rolling cap is **conservative local policy, not a
     confirmed Microsoft threshold** (see hypotheses F35/F36; deployed cap is now **120** — the conservative default; 125 and 135 both tripped upstream on 2026-10-11/12): a 2026-10 campaign ran 151 turns
     (~120/hr) per model for 75 min with no throttle, while a separate smoke tripped `PerUserThrottled`
     at ~140 account turns/60m and blocked **both** models (existing and fresh conversations). Tripping
     it arms a 20-minute (1200s) cooldown (`M365_USER_THROTTLE_COOLDOWN_SEC`). The proxy protects this
     with a Dual-Horizon Progressive Leaky Bucket and a serialized Priority FIFO Turn Gatekeeper
     (`paceTurnVelocity`) with 1500ms minimum turn spacing (`M365_MIN_TURN_SPACING_MS = 1500`), where
     forcing retries jump to the head of the queue.
   Never fire concurrent requests, and never loop fresh conversations back-to-back. Space experiment
   runs out (generous cooldowns between threads). A real pi/openclaw session — one long thread, many
   messages — is cheap; it's our *experiments* (a new thread per task) or unthrottled subagents that
   burn the thread budget and trigger the throttle.

2. **Chase all hunches — tangents are encouraged.** This is an undocumented API we're
   reverse-engineering. The moment you think *"oh, maybe X works like this"* — stop and
   test it. A probe that teaches us something true about the system is often worth more
   than the task it interrupted. Don't suppress an idea because it's off the current
   thread. Record what you learn in [`docs/hypotheses.md`](docs/hypotheses.md).

3. **The end goal is always a usable agent in pi or openclaw.** Every change exists to make
   this proxy drop into pi/openclaw and actually drive a real coding loop. A clever protocol
   finding that doesn't move that needle is a footnote, not a win. Validate wins through a
   real harness, not only the bench.

4. **Be scientific: hypothesize → predict → test → conclude.** Turn every "I think X" into a
   falsifiable hypothesis with the cheapest probe that settles it. Don't ship on a plausible
   inference when the live API or the bench can decide it. Log it with sample size + an
   evidence pointer.

5. **Prompt tinkering: try N *wildly different* things at once, then let the data pick the
   direction.** Never iterate on the first idea — that's how you spin in loops re-trying
   variations of the same thing. Generate N genuinely distinct strategies (N = however many
   real ideas you have), A/B them all on the bench in **one** sweep, read the scorecard, and
   conclude a direction from the result. *Then* go deep on the winner.

**Things easy to forget (added during the June 24 framing-sweep):**

- **`Disengaged` is driven by jailbreak *shape*, not size (F10) — so a "stronger", more
  aggressive ALL-CAPS prompt can itself trip the filter.** When tinkering (#5), always
  include *leaner/softer* variants, not just heavier ones; the heavier prompt is often the
  one that disengages. Watch `usage.x_m365_dea_score` — M365's own disengagement-eligibility
  score — it rises *before* Disengaged fires (clean tool calls ~1e-8, prose ~1e-6,
  jailbreak-shaped ~1e-3).
- **n=1 is noise.** One SOLVED/Disengaged is a single sample on a stochastic,
  throttle-confounded backend. Confirm a winner with `--repeat`, and control for order
  effects (rotate strategy order across runs) before believing any number.
- **Native tool-calling is permanently OUT OF SCOPE.** MCP / a full Dataverse bot need a
  Copilot Studio license, which breaks the zero-cost premise (§8.11). Tangents (#2) are
  great — but don't re-open this one; it's a closed dead-end. Tool calling stays
  prompt-emulated.

## How we work — hypothesis-driven (default)

This is a reverse-engineering project against an undocumented API. **The default
mode is science: turn every "I think X" into a testable hypothesis, design the
cheapest probe that would confirm or kill it, run it, and record the result.**
Don't guess what works — measure it. Don't stop at a plausible inference when the
live API or the benchmark can settle it. Always be looking for the next testable
hypothesis that teaches us something.

- **Log every hypothesis in [`docs/hypotheses.md`](docs/hypotheses.md)** with a
  falsification criterion and a probe idea; update it when an experiment lands
  (confirmed / disproved, with sample size + evidence pointer).
- **[`docs/experiments.md`](docs/experiments.md) is the runnable catalog** — each
  experiment is a hypothesis + exact commands + how to read the result. Reach for
  it to *run* something; add to it when you design a new experiment.
- **Probes live in `scripts/`** — small, single-purpose, read-mostly. Reuse
  `scripts/_probe-chat.mjs` (one M365 turn in → structured result out; supports
  `optionsSets` / `extraAllowed` / `plugins` / `variants` / `tone` / agent
  overrides) and copy an existing probe rather than starting from scratch.
- **Quantify with the benchmark** — `scripts/bench/` (Terminal-Bench-style) scores
  real agentic coding tasks objectively, executing every tool call in a
  `--network none` Docker sandbox. To compare *any* lever (tool format, model/tone,
  prompt, optionsSets) run it with a `--label` and diff the scorecards in
  `scripts/bench/out/`. "Best" is a pass-rate number, not an opinion. See
  `scripts/bench/README.md`.
- Prefer empirical evidence — what the real first-party client sends/receives
  (capture it with Playwright), what the bench scores — over schema guesses.

## Layout (pnpm workspace, all TypeScript/ESM)

| Package | Role |
|---|---|
| `@m365-copilot/core` | auth (MSAL+Playwright), WebSocket client, sessions, agent mgmt, tool formatting, schemas |
| `@m365-copilot/proxy-lib` | OpenAI↔M365 translation: framework-free `createApp()` fetch handler, `SessionPool`, handler, tool-call parsing |
| `@m365-copilot/proxy` | standalone **Nitro** service / proxy binary (`m365-proxy`); file-based `routes/`, startup-auth `plugins/`, builds to `.output/` |
| `@m365-copilot/openclaw-plugin` | OpenClaw config generator + setup CLI |

`scripts/` holds RE probes + dev tools (`_probe-chat` helper, `proxy-verify`,
frame/optionsSets/tone probes, `gateway-*` captures) and **`scripts/bench/`** — the
quantitative benchmark. See the hypothesis-driven section above.

## Build & test

```sh
pnpm install
pnpm build          # tsdown, all packages (tests import from dist/, so build first)
pnpm test           # = test:unit; pure unit tests, NO auth/network
pnpm test:live      # M365_LIVE=1; live tests that hit real M365 (uses quota)
```

- ESM with `.js`-suffixed relative imports (tsdown/Node ESM). Keep that convention.
- Zod for boundary validation. No `console.log` in library code — use `createLogger`.
- `vitest run` skips live tests unless `M365_LIVE=1` (see `describe.skipIf`).

## Running against real M365 (important)

- **Run inside the Nix dev shell**: `nix develop --command bash -c '...'`. It provides
  `CHROMIUM_PATH` (a system Chromium); Playwright's bundled one is broken on NixOS.
- Auth uses `~/.config/opencode-m365/secrets.json` (email/password/mfaSecret) +
  `msal-cache.json`. **This data dir keeps the legacy `opencode-m365` name** — do not
  rename it or you orphan working credentials.
- Set `M365_DEBUG=1` to log to `~/.config/opencode-m365/debug.log`. There is **no
  interactive login** — auth is silent-refresh → automated (secrets.json) → fail loudly.
  A headless host / second PC never opens a browser tab or hangs on a paste-the-URL prompt.
- **Mind the quota**: ~600 messages **per conversation**, plus account-level throttling.
  Don't burn it on loops. A "rate limited / empty response" is often actually a
  `Disengaged` refusal (see the API doc), not throttling.

## Gotchas to know before you "fix" something

- **Tool calling needs the Copilot Studio agent AND the fenced/shell format.** The agent
  alone isn't enough — the old JSON `{"tool":...}` format scored 0/5 on real agentic tasks
  and was **removed**. Tools are now emitted as Markdown fences, and the load-bearing lever
  is **shell-routing**: M365's chat model won't act-as-agent but will write a ```` ```bash ````
  block, which the proxy routes to the harness's shell tool. That + the per-request shell
  framing (`formatFencedToolDefinitions`) is what produces real loops. See docs/hypotheses.md §9.
- **Prompt *framing* can't flip the turn-1 reflex; format/routing can.** 8 per-request
  behavioral-prompt variants moved nothing (0 tool calls); heavy anti-advise framing in the
  agent *backfired*. Don't try to wordsmith the model into acting — route its natural ```` ```bash ````.
- **The agent is versioned by an instructions hash.** Its name is
  `m365-tool-agent-<sha256(instructions)[:8]>`, so editing `getAgentInstructions()` auto-
  provisions a fresh agent on the next request. Stale versions are **always left in place**
  (we never delete agents), which avoids the multi-host footgun where a host on new code
  would delete the agent another host/PC is still using mid-conversation. A few orphaned
  lightweight bots are harmless. We re-create rather than update in place (the update API
  needs a `changeToken` only returned by *create*). See API doc §10.
- **Reasoning tones are recommended for tool calling.** Reasoning tones
  (`gpt-5.5-think-deeper`, `gpt-5.6-think-deeper`) are the recommended engines for
  tool-calling when paired with fenced/shell-routing and delta turn tool re-injection.
  The default `m365-copilot` (magic) tone is unreliable for tools (confabulates ~0%
  solve). The older claim that reasoning tones do not work applied only to the legacy
  bare-JSON format prior to fenced/shell routing.
- **M365 disengages on large tool payloads.** Keep injected toolsets lean. This is why
  pi works and heavy harnesses (opencode) don't. The proxy also enforces one tool call per
  turn and strips M365's invented `{confidence}`/`{final}` JSON (`M365_ALLOW_MULTI_TOOL` to opt out).
- **Account degradation has two distinct horizons:**
  - **Thread-rate (`PerScenarioThrottled`, docs/hypotheses.md §9 F13):** Microsoft throttles
    *conversations started*, not messages sent — the per-conversation counter resets each thread.
    Upstream throttling returns explicit `PerScenarioThrottled` completion frames. A bench or harness
    that opens fresh conversations/subagents in rapid succession burns the thread budget fast (~15–20
    threads / 10 min); a single long thread (hundreds of messages) is fine.
  - **Hourly turn volume (`PerUserThrottled`, docs/hypotheses.md §17 F31/F34; F35):** Microsoft
    enforces an **account-wide** turn-volume ceiling shared by all models (observed 2026-10: throttling
    Sonnet blocked GPT-5.6 on both existing and fresh conversations). The exact ceiling is **not pinned**;
    the sustained cap is **conservative local policy** (currently deployed at **120** turns/60m — the code default; 125 and 135 both tripped upstream on 2026-10-11/12; F36), not a confirmed upstream number.
  - **Before raising local burst/sustained caps:** monitor queue delay, achieved turn rate, retries and
    explicit throttles on `/api/metrics`, ideally split by model and agent attachment, and only raise
    limits if pacing materially delays real work — validating on the tool-enabled path. See
    `docs/m365-copilot-api.md` §7 "Monitoring before changing throughput".
- **The proxy features a Local Circuit Breaker Shield.** When upstream throttling (`PerScenarioThrottled`
  or `PerUserThrottled`) or repeated empty responses across conversations are detected, the proxy arms
  a cooldown (1800s for `PerScenarioThrottled`, 1200s for `PerUserThrottled`). The proxy intercepts
  subsequent requests locally and returns **`HTTP 429 Too Many Requests`** with a client header capped at
  **`Retry-After: 60`** (`M365_MAX_RETRY_AFTER_SEC`). This sends **zero traffic to Microsoft** during
  the cooldown window, allowing Microsoft's token bucket to recharge while standard OpenAI clients
  (OpenCode, Pi) automatically pause and retry without aborting the turn.
- **Priority FIFO Turn Gatekeeper & Wire Pacing (`paceTurnVelocity`):** Serializes all backend turns
  through a live-recalculating FIFO queue. Turns enforce a minimum 1500ms wire spacing
  (`M365_MIN_TURN_SPACING_MS = 1500`) to prevent thundering herd bursts. Forcing retries (`attempt > 0`)
  queue with `{ priority: true }`, jumping ahead of normal turns while preserving FIFO among retries.
- **New Session Stagger Queue:** The proxy enforces a 15-second spacing queue for initial turns
  (`turn === 0`, `M365_NEW_SESSION_SPACING_MS = 15000`), capping fresh session creation to 4/min to
  prevent parallel dispatch drops while follow-up turns (`turn > 0`) run unthrottled.
- **Refusal Fallthrough:** An NLI-classified tool refusal that persists after the forcing retries
  returns **HTTP 200** with the refusal as assistant content (session context
  reset) — refusals no longer fail closed. The remote-artifact `file_mutation_without_local_tool`
  502 is unchanged.
- **Structural Clause NLP Analysis** (`packages/core/src/tools.ts`): All natural language
  heuristics for tool refusals, confabulations, and unearned mutation claims use clause-boundary
  segmentation (`[Tool Anchor] + [Negation] + [Availability State]`). This avoids false positives
  on filenames with dots (e.g. `test_candidate_claim.py`), detects transitive provision verbs
  (`expose`, `mount`, `offer`), existence verbs (`exist`), truncation surrenders, and shell error
  deferrals.
- **Delta Turn Tool Definitions Injection:** Follow-up turns proactively re-inject the `<tools>`
  block into `formatDeltaMessages`. M365 reasoning models (`DeepLeo`) require continuous tool
  context; without it, follow-up turns often confabulate that tools are no longer available.
- **Assistant-simulated `<tool_response>` tags are rejected & flush session context:** When
  a model produces a hallucinated simulation with fake `<tool_response>` tags, the proxy strips
  them and resets the session to force a clean full-history replay on the next turn.
- **In-Process NLI Turn Classifier (`packages/core/src/classifier.ts`):** On every tool-mode turn
  that returns no tool call, distinguishes genuine prose deliverables (security audits, test
  diagnostics) from tool confabulations with a zero-shot NLI pipeline — `Xenova/nli-deberta-v3-base`
  (`dtype:"q8"`, CPU, via `@huggingface/transformers`/`onnxruntime-node`), no network, ~100 ms/turn.
  Labels are *claim-vs-result* (`["the assistant claiming it cannot perform the task", "the assistant
  providing its actual answer or results"]`, hypothesis template `"This message shows {}."`). Chosen
  on a 198-item balanced clean benchmark (~99 refusals / 99 deliverables): **92.4%** accuracy vs the
  prior `gemma4:e2b` SLM's **88.9%**, ~**34× faster** (~100 ms vs ~3.4 s; the SLM also serialised, no
  parallelism). `REFUSAL` forces an in-conversation retry (hard-capped at 3); `DELIVERABLE` returns
  as-is. The `claim-vs-result` framing alone lifted the same model 86.9% → 92.4% over a naive
  `refusal/success` framing. Max input is `max_position_embeddings: 512` tokens (~2,000 chars of prose,
  fewer for dense code) — the classifier sees only the message head. Fine for refusals (short: median
  ~200 chars, p95 ~600, max ~1,100 observed); long deliverables get head-truncated (normally still
  DELIVERABLE).
  - *History:* regex (`looksLikeConfabulation`, brittle/over-grown, ~86% false positives on real
    prose) → SLM (`gemma4:e2b`, high precision/zero false-retries but slow ~3.4 s and weaker recall,
    88.9%) → in-process NLI classifier (92.4%, ~100 ms). Other NLI candidates rejected on the same
    benchmark: `onnx-community/deberta-v3-large-zeroshot-v2.0-c` (missed a plain refusal),
    `Xenova/bart-large-mnli` (missed a plain success), `onnx-community/ModernBERT-large-zeroshot-v2.0`
    (79.8%, strong REFUSAL bias, 2× slower), `Xenova/mobilebert-uncased-mnli` (84.8%),
    `protectai/distilroberta-base-rejection-v1` (58.1% — a *safety*-rejection model, blind to
    *capability* refusals).
- **Refusal Retry & Fallthrough:** When a retry happens, the assistant content concatenates each
  attempt separated by `\n\n--- REFUSAL DETECTED - RETRY N/3 ---\n\n` (or
  `--- REMOTE ARTIFACT DETECTED - RETRY N/3 ---`); it is streamed as a content delta on the SSE path
  too. If a refusal survives all 3 retries, the proxy returns **HTTP 200** with the refusal as
  assistant content (session context reset) — it no longer 502s on a refusal (the remote-artifact
  `file_mutation_without_local_tool` 502 is unchanged). `M365_NO_CONFAB_RETRY=1` disables the retry
  loop; `M365_CONFAB_RETRIES` tunes the count (clamped to ≤3). Removed env vars:
  `M365_CLASSIFIER_OPENAI_URL`, `M365_CLASSIFIER_OPENAI_MODEL`, `M365_CLASSIFIER_OPENAI_API_KEY`,
  `M365_CLASSIFIER_TIMEOUT_MS`, `M365_CLASSIFIER_MAX_TOKENS`, `M365_DISABLE_CONFAB_DETECTION`,
  `M365_DISABLE_STALL_RETRY`. Content-policy refusals are no longer special-cased (the old
  `looksLikeSafetyRefusal` → HTTP 400 `content_policy_refusal` fast-fail was removed).


## Verifying changes end-to-end

```sh
# proxy smoke + tool call + multiturn (run unsandboxed, inside nix develop):
nix develop --command bash -c 'M365_DEBUG=1 node scripts/proxy-verify.mjs --agent --multiturn'
```

## Conventions

- Conventional Commits (`fix:`, `feat:`, `docs:`, `chore:`, `build:`). No `Co-Authored-By` lines.
- Small, focused files; handle errors explicitly; prefer immutable updates.
