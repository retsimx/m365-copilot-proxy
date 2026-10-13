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
- [ ] **Pin both glued-fence shapes.** Keep the mid-line (`cmd```STATUS: …`) and line-start
  (` ```STATUS: …`) glued-closing-fence tests green when touching Pass 2.
