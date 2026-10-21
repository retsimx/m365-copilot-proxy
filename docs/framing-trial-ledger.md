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
