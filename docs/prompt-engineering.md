# Prompt-engineering M365 Copilot into tool-calling

Distilled, **conclusive** findings on how to make M365 Copilot's chat-tuned model
emit usable tool calls — enough to drive a real agent loop in pi/openclaw. This is
the reference layer: the protocol lives in [`m365-copilot-api.md`](m365-copilot-api.md),
the messy in-progress experiments in [`hypotheses.md`](hypotheses.md). Promote things
here once they're settled with evidence (not n=1).

> **Methodology reminder** (see [`../AGENTS.md`](../AGENTS.md) → Operating principles):
> run sequentially (thread-rate throttle), try **N wildly different** strategies in
> one bench sweep rather than iterating on the first idea, and confirm winners with
> `--repeat` before believing a number. n=1 is noise.

## The cage theory (why this is hard)

Microsoft's server-side BizChat system prompt sits **above** ours in priority and
defines the model as a *retrieval chat assistant*. So instructions of the form
"be an agent / emit a tool call on demand" are refused or meta-analysed away — the
model decides to answer in prose or hallucinate a result **before** it would act.
We don't fight the cage; we use the one arm-hole it leaves open (see shell-routing).

## The load-bearing levers (confirmed)

These are what actually move compliance. In rough order of importance:

1. **The Copilot Studio agent (server-side system prompt).** Without it, M365 ignores
   the per-request tool instructions and answers in prose. It is *the* lever, not the
   syntax. ([api §10](m365-copilot-api.md), [hyp §1].)
2. **Shell-routing — the unlock.** The model won't "act as an agent" but **will**
   reflexively write a ```` ```bash ```` block. The proxy executes that block as the
   harness's shell tool (any name: `bash`/`run`/`run_command`/…). This is what turned
   the bench from **0/5 → real multi-turn loops** (a verified 9-tool-call fix-bug solve).
   ([hyp §9 F12].)
3. **Fenced format, not JSON.** Tools are emitted as Markdown code fences (info-string
   = tool name), not `{"tool":…}` JSON. JSON scored **0/5** on real agentic tasks; the
   multi-line-body escaping burden was a prime suspect. ([hyp §8.12, §9].)
4. **Anti-confabulation + first-move framing.** Explicitly telling the model it has run
   nothing yet, the files are real, and its FIRST output must be a ```` ```bash ```` block
   flips the stochastic turn-1 "I can't access the files, please paste them" reflex toward
   complying. ([hyp §9 F14].)
5. **Delta turn `<tools>` injection.** M365 reasoning models (`DeepLeo`) require continuous
   tool context on every turn. In follow-up delta messages, `formatDeltaMessages` re-injects
   the `<tools>` block, eliminating turn-2+ "I do not have access to tools" confabulations.
6. **Reasoning models (`gpt-5.5-think-deeper`, `gpt-5.6-think-deeper`) — the winning engine.**
   Paired with fenced/shell-routing and delta `<tools>` injection, reasoning tones are the
   recommended and most compliant engines for tool-calling. In contrast, the default `m365-copilot`
   (magic) tone is unreliable and frequently confabulates (~0% solve rate).
7. **Structural Clause NLP Semantic Analyzer.** Replacing brittle regexes with clause-boundary
   tokenization (`[Tool Anchor] + [Negation] + [Availability State]`) to intercept subtle refusals,
   transitive provision verbs (`this interface does not expose tools`), existence claims (`no
   apply_patch binary exists`), truncation surrenders, and shell diagnosis deferrals without
   false-positive splits on `.py` filenames. ([hyp §15].)
8. **Proxy-side hardening** (deterministic, behind the model): document guard
   (`isProseDocument` — don't execute a model's own markdown answer), simulated `<tool_response>`
   rejection and context flush, confab retry, hallucinated-completion retry, tool-result
   labelling, one-call-per-turn, stripping invented `{confidence}`/`{final}` JSON.
   See [`tool-calling.md`](tool-calling.md).
9. **Chatbot Advisor framing ("You write commands, I run them; do not make tool calls").**
   Prompting the model to *be* an automated agent that *must* call tools contradicts M365's
   retrieval-chatbot prior and triggers RLHF refusals ("I have no bash tool / I am not an
   automated agent"). Recasting the model as a chat assistant that writes shell scripts
   (```` ```bash ```` or ```` ```shell ```` fences) for the user to execute eliminates the
   refusal reflex across all active models (GPT-6 Astra, GPT-5.6, GPT-5.5, Claude Sonnet,
   and even recovers the default `magic` tone to 100% tool-call compliance). ([hyp §18, §19].)

## What does NOT work (confirmed dead-ends — don't re-litigate)

- **Wording-only per-request variants.** 8 behavioural-prompt rewrites (alone /
  env-is-real / first-move-forcing / batch-persona / verify-contract / terse /
  combined) each moved **nothing** (0 tool calls). Wording alone can't flip the turn-1
  reflex. ([hyp §9 "What did NOT work".]) → *the lever is format/routing, not adjectives.*
- **Heavy anti-advise framing baked into the AGENT** (server-side): **backfired**,
  suppressing even illustration-fence tool calls to 0. The agent prompt is now
  minimal/format-only; behavioural framing lives in the per-request `<tools>` block.
- **Context-seeding** (injecting a real `ls`/`cat` before the task): the model reads the
  primed info as "task complete" and says "Done" with 0 tools.
- **`tool_choice: "required"`** translated to a prompt rule: forces bogus `bash()` calls
  on pure-prose questions ("what is 7×8?"). Pass it through as advisory only. ([hyp F3].)
- **Legacy bare-JSON tool prompting with reasoning models:** When prompted with legacy
  bare JSON `{"tool":...}` blocks and few-shot wrappers, the `DeepLeo` reasoning pipeline
  meta-analyzed the prompt and critiqued the few-shot instead of executing tools. Fenced/shell-routing
  and delta `<tools>` injection completely resolved this, making reasoning tones
  (`gpt-5.5-think-deeper`, `gpt-5.6-think-deeper`) the winning combination.
- **Native tool-calling (MCP / full Dataverse bot):** out of scope — needs a paid Copilot
  Studio license, breaking the zero-cost premise. ([hyp §8.11].)

## Constraints that bite while tinkering

- **`Disengaged` tracks jailbreak *shape*, not size** ([hyp F10]). A "stronger", more
  aggressive ALL-CAPS prompt can itself trip the filter — so a **leaner/softer** prompt
  can out-score a heavier one. Always include lean variants in a sweep. Watch
  `usage.x_m365_dea_score` (clean tool calls ~1e-8, prose ~1e-6, jailbreak-shaped ~1e-3);
  it rises before Disengaged fires.
- **Keep the toolset lean.** Heavy harnesses (opencode's ~15 tools) get empty Disengaged
  replies; pi's lean set works. ([api §9].) A heavy harness can often be *made* lean —
  but note that opencode's own config/hook levers do not affect the outgoing request, so
  the trim has to happen in the proxy. ([api §9, "Trimming a heavy harness"].)
- **Measure on *unfakeable* tasks.** The model hallucinates success on tasks it can answer
  from memory (fizzbuzz, count-lines) with 0 tool calls; only unfakeable tasks (fix-bug,
  find-needle, edit-config) force real calls. ([api §10 "measurement traps"].)
- **Bench ≠ pi.** The bench's short prompt is more compliant than pi's polished one; a
  bench win can still confab turn-1 under real pi. Confirm winners live. ([hyp F14].)

## The framing-variant registry & consolidation to Universal Advisor Framing

### Research evaluation phase (June–September 2026)

During the research evaluation phase, the per-request `<tools>` framing was treated as a live, no-reprovision lever. A 10-variant registry was maintained in `packages/core/src/fenced.ts` (`FRAMING_VARIANTS`) to compare strategies on the bench:
- Strategies evaluated: `baseline`, `minimal`, `recency`, `fewshot`, `proof_demand`, `persona`, `react`, `negative`, `terse`, and `reply_tool` (synthetic `reply()` tool).
- Selected per-request via `M365_FRAMING_VARIANT=<name>` or `M365_FRAMING_FILE=<path>` for no-restart A/B bench sweeps (`scripts/bench/sweep2.sh`).

### Consolidation to Universal Advisor Framing (`fenced.ts`)

Following empirical benchmarks and live coding agent evaluations, the codebase has since **consolidated onto Universal Advisor Framing** (`formatAdvisorPrompt` in `packages/core/src/fenced.ts`, where `isAdvisorTone() === true` unconditionally across all model tones).

Advisor framing inverts the prompting contract from autonomous agency to an advisory role:
> *"You write the shell commands; I run them and paste the real output back to you. Do not make any tool calls and do not try to run anything yourself..."*

By directing the model to emit a single ```bash or ```shell block per turn while the proxy executes the block and feeds the real output back, advisor framing matches the chat model's pretraining and completely eliminates JSON string-escaping overhead and agentic hesitation.

### Production findings & confabulation bypass (`docs/hypotheses.md` §21)

As documented in [`docs/hypotheses.md` §21](./hypotheses.md#21-october-8-2026--production-analysis-advisor-framing-renders-proxy-confabulation-machinery-obsolete-m365_disable_confab_detection-), long-term production telemetry across 1,306 production turns under universal advisor framing revealed:
1. **Confabulations dropped to 0.3% (4/1,306 turns):** The model emitted real tool calls on 84.9% of turns (1,109 turns) and clean prose deliverables on 15.1% (197 turns). Genuine operational refusals / container confabulations were virtually extinct.
2. **Regex false positives reached 85.9% (55/64 flagged turns):** Because confabulations became negligible, the proxy's internal keyword regex heuristics (`hasClauseRefusal` in `packages/core/src/tools.ts`) misidentified normal technical words in engineering deliverables (`binary`, `execution`, `available`, `run`) as refusals (e.g. in test diagnostics, review verdicts, and `### Task Complete` reports).
3. **Counterproductive retry loops:** Flagged turns were forced into 3–10 turn retry loops, discarding valid deliverable prose, burning conversational turn quota, and tripping upstream pacing limits.

**Resolution:** Shipped **`M365_DISABLE_CONFAB_DETECTION=1`**, allowing prose deliverables through untouched to client orchestrators (such as Pi or OpenCode) which natively handle model retries, while preserving safety refusal fast-fails (HTTP 400 `content_policy_refusal`).

## Results

### Framing sweep outcome & production consolidation

The framing sweeps demonstrated that prompt wordsmithing and synthetic reply tools were inferior to shell-routing combined with Universal Advisor Framing (`formatAdvisorPrompt`). Across multi-turn coding benchmarks and production sessions, advisor framing eliminated the turn-1 hesitation reflex and sustained long agentic loops. See [`docs/hypotheses.md` §21](./hypotheses.md#21-october-8-2026--production-analysis-advisor-framing-renders-proxy-confabulation-machinery-obsolete-m365_disable_confab_detection-) for comprehensive empirical metrics and breakdown.
