#!/usr/bin/env node
// Cross-model benchmark: run any transformers.js text-classification model over the
// labelled dataset and report accuracy + speed vs the current NLI baseline.
//
// Usage:
//   node packages/core/bench/model-bench.mjs <model-id> [--pos <regex>] [--dtype <d>]
//
// --pos  regex matching the model's "refusal"/positive label (default /refus|reject|label_1|^1$|unsafe/i)
// --dtype  onnx dtype (q8|fp32|fp16|int8); omit to use the repo default
//
// Run from a cwd where "@huggingface/transformers" resolves (packages/core).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);
const modelId = args[0];
if (!modelId) { console.error("usage: node model-bench.mjs <model-id> [--pos <regex>] [--dtype <d>]"); process.exit(2); }
const posArg = args.includes("--pos") ? args[args.indexOf("--pos") + 1] : null;
const dtype = args.includes("--dtype") ? args[args.indexOf("--dtype") + 1] : undefined;
const dataArg = args.includes("--data") ? args[args.indexOf("--data") + 1] : null;
const POS = new RegExp(posArg ?? "refus|reject|label_1|^1$|unsafe", "i");

const here = dirname(fileURLToPath(import.meta.url));
const DATASET = dataArg ? resolve(dataArg) : resolve(here, "..", "benchmark", "classifier-benchmark.jsonl");
const rows = readFileSync(DATASET, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const { pipeline } = await import("@huggingface/transformers");
const opts = dtype ? { dtype } : {};
const pipe = await pipeline("text-classification", modelId, opts);

// Warm up (first call loads weights).
await pipe(rows[0].text);

let tp = 0, fp = 0, fn = 0, tn = 0, amb = 0;
const fps = [], fns = [];
const t0 = process.hrtime.bigint();
for (const r of rows) {
  const out = await pipe(r.text);
  const top = Array.isArray(out) ? out[0] : out;
  const pred = POS.test(String(top.label)) ? "REFUSAL" : "DELIVERABLE";
  if (r.label === "ambiguous") { amb++; continue; }
  if (pred === "REFUSAL" && r.label === "refusal") tp++;
  else if (pred === "REFUSAL" && r.label === "deliverable") { fp++; fps.push({ id: r.id, score: top.score, text: r.text }); }
  else if (pred === "DELIVERABLE" && r.label === "refusal") { fn++; fns.push({ id: r.id, score: top.score, text: r.text }); }
  else tn++;
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / rows.length;
const prec = tp + fp ? tp / (tp + fp) : 0, rec = tp + fn ? tp / (tp + fn) : 0;
const acc = tp + fp + fn + tn ? (tp + tn) / (tp + fp + fn + tn) : 0;
const brief = (t) => t.replace(/\s+/g, " ").slice(0, 110);

console.log(`\nmodel: ${modelId}${dtype ? ` (${dtype})` : ""}`);
console.log(`n=${rows.length} scored=${tp + fp + fn + tn} ambiguous=${amb}`);
const spec = tn + fp ? tn / (tn + fp) : 0;          // deliverables correctly left alone
const bal = (rec + spec) / 2;                        // balanced accuracy
const delivFpr = fp + tn ? fp / (fp + tn) : 0;       // fraction of deliverables WRONGLY flagged refusal
const trivial = (tp + fp + fn + tn) ? (tp + fn) / (tp + fp + fn + tn) : 0; // always-refusal baseline
console.log(`TP=${tp} FP=${fp} FN=${fn} TN=${tn}`);
console.log(`precision=${prec.toFixed(3)} recall=${rec.toFixed(3)} accuracy=${acc.toFixed(3)} F1=${(prec && rec ? 2 * prec * rec / (prec + rec) : 0).toFixed(3)}`);
console.log(`specificity=${spec.toFixed(3)} balancedAcc=${bal.toFixed(3)}  deliverableFP-rate=${(delivFpr * 100).toFixed(1)}%  (trivial always-refusal acc=${trivial.toFixed(3)})`);
console.log(`speed: ${ms.toFixed(2)} ms/sample  (${(1000 / ms).toFixed(0)} samples/s)`);
if (fps.length) { console.log(`FPs (${fps.length}):`); for (const m of fps.slice(0, 6)) console.log(`  [${m.id}] ${brief(m.text)}`); }
if (fns.length) { console.log(`FNs (${fns.length}):`); for (const m of fns.slice(0, 6)) console.log(`  [${m.id}] ${brief(m.text)}`); }
