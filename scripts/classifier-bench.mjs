#!/usr/bin/env node
// Classifier benchmark: replay a labelled dataset of assistant turns through the
// in-process NLI classifier and report precision/recall/accuracy + mismatches.
//
// Usage:
//   node scripts/classifier-bench.mjs [dataset.jsonl]
//
// Default dataset: packages/core/benchmark/classifier-benchmark.jsonl
// Each line: {"id","text","classifier","label"} where `label` is "refusal" | "deliverable" | "ambiguous"
// (`classifier` is the historical verdict the proxy produced at capture time).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const datasetPath = process.argv[2] ?? resolve(repoRoot, "packages/core/benchmark/classifier-benchmark.jsonl");

const { classifyTurnResponse, warmupClassifier } = await import(
  resolve(repoRoot, "packages/core/dist/index.mjs")
);

const rows = readFileSync(datasetPath, "utf8")
  .split("\n")
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

console.error(`Loading classifier (${rows.length} samples)…`);
await warmupClassifier?.();

let tp = 0, fp = 0, fn = 0, tn = 0, ambiguous = 0, errors = 0, agreeStored = 0;
const fps = []; // pred REFUSAL, truth deliverable
const fns = []; // pred DELIVERABLE, truth refusal

for (const r of rows) {
  let pred;
  try {
    pred = await classifyTurnResponse(r.text);
  } catch {
    errors++;
    continue;
  }
  if (pred === r.classifier) agreeStored++;
  if (r.label === "ambiguous") {
    ambiguous++;
  } else if (pred === "REFUSAL" && r.label === "refusal") {
    tp++;
  } else if (pred === "REFUSAL" && r.label === "deliverable") {
    fp++;
    fps.push({ id: r.id, text: r.text });
  } else if (pred === "DELIVERABLE" && r.label === "refusal") {
    fn++;
    fns.push({ id: r.id, text: r.text });
  } else {
    tn++;
  }
}

const prec = tp + fp ? tp / (tp + fp) : 0;
const rec = tp + fn ? tp / (tp + fn) : 0;
const acc = tp + fp + fn + tn ? (tp + tn) / (tp + fp + fn + tn) : 0;

console.log(`\ndataset: ${datasetPath}`);
console.log(`n=${rows.length}  (scored=${tp + fp + fn + tn}, ambiguous=${ambiguous}, errors=${errors})`);
console.log(`\nconfusion (positive=refusal):`);
console.log(`  TP=${tp}  FP=${fp}  FN=${fn}  TN=${tn}`);
console.log(`  precision=${prec.toFixed(3)}  recall=${rec.toFixed(3)}  accuracy=${acc.toFixed(3)}`);
console.log(`  F1=${(prec && rec ? (2 * prec * rec) / (prec + rec) : 0).toFixed(3)}`);
console.log(`\nstability: fresh verdict == stored classifier on ${agreeStored}/${rows.length - errors}`);

const brief = (t) => t.replace(/\s+/g, " ").slice(0, 140);
console.log(`\nFALSE POSITIVES — classifier said REFUSAL, label=deliverable (${fps.length}):`);
for (const m of fps) console.log(`  [${m.id}] ${brief(m.text)}`);
console.log(`\nFALSE NEGATIVES — classifier said DELIVERABLE, label=refusal (${fns.length}):`);
for (const m of fns) console.log(`  [${m.id}] ${brief(m.text)}`);
