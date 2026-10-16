# Checklist — Fenced Tool-Call Parsing (`packages/core/src/fenced.ts`)

Domain checklist for changes to fence parsing / `restoreM365Fences` / the post-fence guard.

## Rules

- [ ] **Quote-aware mid-line fences.** Any mid-line ` ``` ` detection in a **shell** body must
  ignore backticks inside `'…'` / `"…"` (they are DATA, not a closing fence). Regression:
  2026-10-12 19:07:43Z, cid `c3f86119` — `grep -q '```suggestion' "$OUT"` was split at the
  quoted backticks, the block closed early, and `hasPostFenceContamination` aborted the turn.
- [ ] **Parser and guard share the same restore.** `parseFencedToolCalls` and
  `hasPostFenceContamination` both call `restoreM365Fences`; a change there affects both
  ("what we parse" and "what we abort"). Test both.
- [ ] **Body is opaque.** A tool fence body may contain heredocs, nested code fences, and
  `SEARCH/REPLACE` regions — all body content. Only a bare closing fence ends the block
  (`feedToolBodyLine`, shared).
- [ ] **Bare inner fence openers.** A `write`/`edit` body may embed a **language-less** code
  block opened with a bare ` ``` ` (the ordinary Markdown form). `OPEN_FENCE_REGEX` requires
  an info-string, so a bare opener must be recognised as an *inner opener* (via
  `hasBareFenceFollower` lookahead), not as the tool close — otherwise the body is truncated
  at that line and the turn is aborted. A bare fence with inline trailing prose is a real
  closer. Regression: 2026-10-17, cid `95e5e391` — a Markdown evidence report written via
  `write` was cut at its first bare ` ``` `, the file landed as a stub, and the model re-wrote
  it four times.
- [ ] **Pin both glued-fence shapes.** Keep the mid-line (`cmd```STATUS: …`) and line-start
  (` ```STATUS: …`) glued-closing-fence tests green when touching Pass 2.
