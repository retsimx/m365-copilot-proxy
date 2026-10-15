# Classifier benchmark dataset

Labelled assistant turns for the in-process NLI refusal/deliverable classifier
(`Xenova/nli-deberta-v3-base`, see `packages/core/src/classifier.ts`).

## File

`classifier-benchmark.jsonl` — one JSON object per line:

| field | meaning |
|---|---|
| `id` | stable sample id (`c0000`…) |
| `text` | the assistant message, **first 1000 chars** |
| `classifier` | the verdict the proxy produced at capture time (`REFUSAL` \| `DELIVERABLE`) |
| `label` | ground-truth judgment (`refusal` \| `deliverable` \| `ambiguous`) |

## Provenance

Extracted from the production debug log (`~/.config/opencode-m365/debug.log`,
2026-10-12 → 10-15). Each sample is a *(text, verdict)* pair built by pairing a
`[handler] Raw response (tool mode):` line with the immediately following
`[classifier] Classifier: <VERDICT> (<N> chars)` line. Pairs are kept only when
`len(text) == min(N, 1000)` (length validation rejects interleaved/concurrent
turns), then de-duplicated by text: **455 validated pairs → 454 unique**.

The classifier only runs on **tool-mode turns that produced no tool call**, so
this is exactly the difficult slice the classifier exists for — *not* a random
sample of all messages.

## Labels

The `label` column is a **blind first-pass** judgment (the classifier verdict was
hidden and the order shuffled to avoid anchoring), produced with model assistance
— **not** human-verified. 2 samples are `ambiguous`. Treat it as a v1 bootstrap
benchmark, not gospel.

## Measurements

Run: `node scripts/classifier-bench.mjs [dataset.jsonl]`

Fresh re-run (classifier re-scored on the stored text):

```
n=454  scored=452  ambiguous=2
TP=146  FP=7  FN=82  TN=217        (positive = refusal)
precision=0.954  recall=0.640  accuracy=0.803  F1=0.766
stability: fresh verdict == stored verdict on 430/454
```

Using the **stored** (production) verdicts instead: `precision=0.898 recall=0.658
accuracy=0.790`.

**Reading:** on this production distribution the classifier is **high-precision /
moderate-recall** — when it says `REFUSAL` it is right ~90–95% of the time, but it
**misses ~1/3 of genuine refusals** (they come back `DELIVERABLE`). Most
`REFUSAL` flags are not false positives on plain prose; they are narration with a
refusal appended later in the text (the classifier reads up to ~512 tokens, so it
sees the trailing refusal even when the opening line looks like ordinary prose).

## Caveats

- **Truncation:** `text` is capped at 1000 chars (47/454 samples are exactly
  1000). The classifier reads up to ~512 tokens (~2000 chars), so for those
  samples the stored text is shorter than what the classifier actually saw —
  this is the main source of the 24/454 fresh-vs-stored verdict differences.
- **Labels are a first pass** (model-assisted, blind). Fine for relative
  comparison; refine before trusting absolute numbers.
- Turns are paced and can interleave; the length-validation step should have
  removed mispaired (text, verdict) samples, but treat any single row with
  suspicion.
