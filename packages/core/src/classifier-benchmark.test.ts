import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Integrity test for the classifier benchmark dataset. This does NOT run the NLI
// model (that is the job of `scripts/classifier-bench.mjs`); it only guards the
// dataset's schema and shape so the suite can be used reliably as a regression
// fixture.

const here = dirname(fileURLToPath(import.meta.url));
const DATASET = join(here, "..", "benchmark", "classifier-benchmark.jsonl");

interface Row {
  id: string;
  text: string;
  classifier: "REFUSAL" | "DELIVERABLE";
  label: "refusal" | "deliverable" | "ambiguous";
}

function load(): Row[] {
  return readFileSync(DATASET, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe("classifier benchmark dataset", () => {
  const rows = load();

  it("loads a non-trivial number of samples", () => {
    expect(rows.length).toBeGreaterThanOrEqual(400);
  });

  it("every row has the required fields with valid values", () => {
    const ids = new Set<string>();
    for (const r of rows) {
      expect(typeof r.id).toBe("string");
      expect(r.id.length).toBeGreaterThan(0);
      expect(typeof r.text).toBe("string");
      expect(r.text.length).toBeGreaterThan(0);
      expect(["REFUSAL", "DELIVERABLE"]).toContain(r.classifier);
      expect(["refusal", "deliverable", "ambiguous"]).toContain(r.label);
      ids.add(r.id);
    }
    // ids are unique
    expect(ids.size).toBe(rows.length);
  });

  it("text is capped at 1000 chars", () => {
    for (const r of rows) expect(r.text.length).toBeLessThanOrEqual(1000);
  });

  it("has a usable label mix (both classes present, few ambiguous)", () => {
    const refusal = rows.filter((r) => r.label === "refusal").length;
    const deliverable = rows.filter((r) => r.label === "deliverable").length;
    const ambiguous = rows.filter((r) => r.label === "ambiguous").length;
    expect(refusal).toBeGreaterThan(50);
    expect(deliverable).toBeGreaterThan(50);
    // Ambiguous should stay a small tail, not balloon.
    expect(ambiguous / rows.length).toBeLessThan(0.05);
  });
});
