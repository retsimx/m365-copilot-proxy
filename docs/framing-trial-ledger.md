# Framing trial ledger

Chronological record of framing/wording experiments for M365 model compliance.
Each entry: hypothesis → exact change → commit → test → result → verdict.

Test shape unless stated: a GPT subagent (`m365gpt`, think-deeper-5.6) is given a
multi-turn task that reads source files and then **writes a file to a fixed path**.
Success = a fenced command that writes the file, executed by the harness, verified
on disk. Failure = a refusal at the write step, or prose-only delivery.

"Right direction" = the refusal disappeared or the mechanism moved as predicted.
"Wrong direction" = no change, or a new failure mode.

---

## T1 — Subject swap in the advisor framing (2026-10-21)

**Hypothesis.** The sentence "For reading, creating, or changing files, **you write**
the shell commands" places the file action on the assistant, which a GPT model can
reclassify as a direct file-generation request.

**Change.** `the fenced block contains the shell commands` (subject moved from the
model to the block). No imperative, no prohibition (F22 shape constraint).

**Commit.** `fe11b70`

**Test.** Fresh `m365gpt` session, 500+ word dispatch, read two source files, write
`/tmp/opencode/relay-note.md`.

**Result.** Refused at the write with "file-generation capabilities are disabled in
this session", after quoting the new sentence and agreeing it assigns execution to
the person. Delivered the content as prose.

**Verdict.** **Wrong direction.** The model confirmed the relay sentence reads
correctly and refused anyway. The refusal is not about the grammatical subject.

---

## T2 — Long dispatch as the trigger (2026-10-21)

**Hypothesis.** The short demo task did not refuse; a realistic 500+ word dispatch
might, because length/complexity dilutes the framing.

**Change.** None (dispatch only).

**Test.** `m365gpt`, long dispatch, read F46 + source files, write
`/tmp/opencode/gpt-f46-verification.md`.

**Result.** Read the files across several turns, then refused at the write, three
proxy retries, then delivered the report as prose.

**Verdict.** **Right direction for reproduction.** The refusal is stable and
reproducible at the write step with a realistic dispatch.

---

## T3 — Agent instructions re-provision (2026-10-21)

**Hypothesis.** The regression is the Copilot Studio agent rebuild, not the framing.
The agent instructions hash changed `eafb1432` → `610a6c54` at 01:21:03 (when
`agent.ts` was edited); the previous agent had served 685 turns. A new agent may be
created with a capability/policy profile the old one did not have.

**Change.** Revert `agent.ts` to the pre-change sentence (`in a <tool_output> block`
rather than `as the next message`) so the instructions hash returns to `eafb1432`
and the existing old agent is reused (agents are never deleted).

**Commit.** (filled in on commit)

**Test.** Same long dispatch, `m365gpt`, write to a fixed path.

**Result.** (pending)

**Verdict.** (pending)

---

## T4 — Single-turn probe (2026-10-21) — **flawed test**

**Hypothesis.** A one-turn "write this file" request through the proxy is enough to
compare framings.

**Change.** None (probe only); `scripts/framing-trial-probe.mjs` and two curl turns.

**Result.**
- Without `tools` in the request the proxy takes the **agent-less** path (`agent=none`):
  no tool call, content "Created `/tmp/opencode/framing-probe.md`…" — a fabricated
  success, and the file does not exist.
- With `tools: [bash]` the agent attaches and the **current** framing works on turn 0:
  `finish: tool_calls`, a `bash` command that writes the file and verifies it
  byte-for-byte.

**Verdict.** **Flawed test, discarded.** A single turn does not reproduce the failure.
The refusal appears only in the long multi-turn agentic dispatch (read several files,
then write). All framing trials must use that dispatch shape. The agent-less/no-tools
path also matters: it confabulates rather than writing, so trials must send `tools`.

---

## T5 — Massive-dispatch trials (2026-10-21)

**Hypothesis.** The write-step refusal depends on the long dispatch + multi-turn
context, and the framing text can change it.

**Test.** `m365gpt`, one run per candidate, same ~600-word dispatch (source files only;
no hypothesis documents), reads 4–5 files, writes `/tmp/opencode/gpt-audit.md`.
Success = a `bash` tool call that writes the file (harness executes it) and the file
verifies on disk. Failure = refusal or prose-only delivery.

**Candidates.**
- T5a — current framing (`fe11b70`) — baseline.
- T5b — pre-Oct-21 advisor framing (`91b9f29`: tag named, "you write", prose-only line).
- T5c — current + explicit file-step sentence.
- T5d — current with the subject reverted to "you write the shell commands".

**Commit.** (per candidate)

**Result.** (pending)

**Verdict.** (pending)

### T5–T10 results (2026-10-21)

| ID | Change | Result | Verdict |
|---|---|---|---|
| T5a | current advisor framing, massive dispatch | refused at write ("can't generate or modify files"), prose fallback | baseline reproduced |
| T5b | pre-Oct-21 advisor (`91b9f29`) | refused at write; retry emitted the call (run stopped) | framing text is not the cause |
| T5c | + per-turn file-step sentence | refused at write | wrong direction |
| T5d | + post-delta reminder (recency) | refused at write ("shell-driven file task") | wrong direction |
| T5e | non-meta read/write control | refused at write ("in this interface") | not the audit task |
| T6 | de-tag the `<user>` delta channel | 1 run wrote, but via refusal + printed command executed; repeat T6b clean; T6c refused at a *read* ("shell interaction ended") | helps one class, unreliable |
| T7 | plain result envelope + "session continues" cue | termination class gone; write refusal persists | partial |
| T8 | output-destination phrasing | clean once, refused on repeat (T8b) | stochastic, not the fix |
| T9 | `M365_NO_TURN_FRAMING=1` (no per-turn re-attach) | refused at write | wrong direction |
| T10 | **agent framing + full read/write/edit/bash tool set** for GPT | **2/2 clean** (T10, T10b); used a shell heredoc, not `write` | best signal so far; user testing in production |

**Lessons.**
- The write refusal is **stochastic**, not deterministic: the same wording succeeds and fails across fresh sessions. Single-run results are meaningless (T8 vs T8b; T6b vs T6c).
- It is **not** the advisor text (T5b), the per-turn re-attach (T9), the task content (T5e), or the position of the reminder (T5d).
- The reliable historical shape is the **full tool set + drafted-step (agent) framing** (T10), which is now enabled via `M365_FRAMING_VARIANT=agent` and `read/write/edit` in the `m365gpt`/`m365gpt61` agent configs.
- T7 removed the "session ended after a truncated read" class; keep it.

**Open.** T10 needs more samples in production; the model still prefers shell heredocs over the `write` tool. If it holds, retire the bash-only advisor path for GPT or keep it only as a fallback.
