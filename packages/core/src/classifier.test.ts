import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CLASSIFIER_NLI_MODEL_ID,
  CLASSIFIER_LABELS,
  CLASSIFIER_HYPOTHESIS_TEMPLATE,
  CLASSIFIER_LOCAL_MODEL_DIR,
  CLASSIFIER_POSITIVE_LABEL,
  classifyTurnResponse,
  setClassifierBackend,
  resetClassifierCache,
  warmupClassifier,
} from "./classifier.js";

describe("Classifier Module", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setClassifierBackend(null);
    resetClassifierCache();
  });

  afterEach(() => {
    setClassifierBackend(null);
    resetClassifierCache();
  });

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  describe("exported configuration", () => {
    it("falls back to the expected zero-shot NLI model", () => {
      expect(CLASSIFIER_NLI_MODEL_ID).toBe("Xenova/nli-deberta-v3-base");
    });

    it("CLASSIFIER_LABELS has refusal as index 0 and deliverable as index 1", () => {
      expect(CLASSIFIER_LABELS[0]).toMatch(/cannot perform/i);
      expect(CLASSIFIER_LABELS[1]).toMatch(/actual answer/i);
    });

    it("CLASSIFIER_HYPOTHESIS_TEMPLATE contains a {} placeholder", () => {
      expect(CLASSIFIER_HYPOTHESIS_TEMPLATE).toContain("{}");
    });

    it("CLASSIFIER_LOCAL_MODEL_DIR points somewhere under the app config dir by default", () => {
      expect(typeof CLASSIFIER_LOCAL_MODEL_DIR).toBe("string");
      expect(CLASSIFIER_LOCAL_MODEL_DIR.length).toBeGreaterThan(0);
    });

    it("CLASSIFIER_POSITIVE_LABEL matches refusal but not non-refusal", () => {
      const re = new RegExp(CLASSIFIER_POSITIVE_LABEL, "i");
      expect(re.test("refusal")).toBe(true);
      expect(re.test("non-refusal")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Helpers — fake backends
  // ---------------------------------------------------------------------------

  function seqBackend(label: string) {
    return { kind: "seq" as const, pipe: vi.fn().mockResolvedValue([{ label, score: 0.9 }]) };
  }

  function nliBackend(topLabel: string) {
    return { kind: "nli" as const, pipe: vi.fn().mockResolvedValue({ labels: [topLabel, "other"] }) };
  }

  // ---------------------------------------------------------------------------
  // Empty / null / whitespace → DELIVERABLE (no inference)
  // ---------------------------------------------------------------------------

  describe("classifyTurnResponse — empty input", () => {
    it("returns DELIVERABLE for empty string without calling the pipeline", async () => {
      const b = seqBackend("refusal");
      setClassifierBackend(Promise.resolve(b));

      expect(await classifyTurnResponse("")).toBe("DELIVERABLE");
      expect(b.pipe).not.toHaveBeenCalled();
    });

    it("returns DELIVERABLE for whitespace-only string", async () => {
      const b = seqBackend("refusal");
      setClassifierBackend(Promise.resolve(b));

      expect(await classifyTurnResponse("   \n\t  ")).toBe("DELIVERABLE");
      expect(b.pipe).not.toHaveBeenCalled();
    });

    it("returns DELIVERABLE for null", async () => {
      expect(await classifyTurnResponse(null)).toBe("DELIVERABLE");
    });

    it("returns DELIVERABLE for undefined", async () => {
      expect(await classifyTurnResponse(undefined)).toBe("DELIVERABLE");
    });
  });

  // ---------------------------------------------------------------------------
  // Local sequence-classifier backend (preferred)
  // ---------------------------------------------------------------------------

  describe("classifyTurnResponse — local sequence head", () => {
    it("returns REFUSAL when the top label is 'refusal'", async () => {
      const b = seqBackend("refusal");
      setClassifierBackend(Promise.resolve(b));

      const result = await classifyTurnResponse(
        "I cannot run commands because I do not have access to a shell.",
      );

      expect(result).toBe("REFUSAL");
      expect(b.pipe).toHaveBeenCalledTimes(1);
      expect(b.pipe.mock.calls[0][0]).toBe("I cannot run commands because I do not have access to a shell.");
    });

    it("returns DELIVERABLE when the top label is 'non-refusal'", async () => {
      const b = seqBackend("non-refusal");
      setClassifierBackend(Promise.resolve(b));

      expect(await classifyTurnResponse("The command exited with code 1.")).toBe("DELIVERABLE");
    });

    it("accepts a single-object result (not wrapped in an array)", async () => {
      const b = { kind: "seq" as const, pipe: vi.fn().mockResolvedValue({ label: "refusal", score: 0.8 }) };
      setClassifierBackend(Promise.resolve(b));

      expect(await classifyTurnResponse("nope")).toBe("REFUSAL");
    });
  });

  // ---------------------------------------------------------------------------
  // Zero-shot NLI fallback backend
  // ---------------------------------------------------------------------------

  describe("classifyTurnResponse — NLI fallback", () => {
    it("returns REFUSAL when the top NLI label is the refusal label", async () => {
      const b = nliBackend(CLASSIFIER_LABELS[0]);
      setClassifierBackend(Promise.resolve(b));

      expect(await classifyTurnResponse("cannot do it")).toBe("REFUSAL");
      const [, labels, opts] = b.pipe.mock.calls[0];
      expect(labels).toEqual(CLASSIFIER_LABELS);
      expect(opts.hypothesis_template).toBe(CLASSIFIER_HYPOTHESIS_TEMPLATE);
    });

    it("returns DELIVERABLE when the top NLI label is the deliverable label", async () => {
      const b = nliBackend(CLASSIFIER_LABELS[1]);
      setClassifierBackend(Promise.resolve(b));

      expect(await classifyTurnResponse("here is the report")).toBe("DELIVERABLE");
    });
  });

  // ---------------------------------------------------------------------------
  // Fail-open behaviour
  // ---------------------------------------------------------------------------

  describe("classifyTurnResponse — fail-open on errors", () => {
    it("returns DELIVERABLE when the backend promise rejects (load failure)", async () => {
      setClassifierBackend(Promise.reject(new Error("model load failed")));
      expect(await classifyTurnResponse("Some text")).toBe("DELIVERABLE");
    });

    it("returns DELIVERABLE when the pipeline call itself throws", async () => {
      const b = { kind: "seq" as const, pipe: vi.fn().mockRejectedValue(new Error("inference error")) };
      setClassifierBackend(Promise.resolve(b));
      expect(await classifyTurnResponse("Some text")).toBe("DELIVERABLE");
    });
  });

  // ---------------------------------------------------------------------------
  // Cache behaviour
  // ---------------------------------------------------------------------------

  describe("classifyTurnResponse — memoisation", () => {
    it("calls the pipeline only once for repeated identical text", async () => {
      const b = seqBackend("non-refusal");
      setClassifierBackend(Promise.resolve(b));

      await classifyTurnResponse("Identical message");
      await classifyTurnResponse("Identical message");
      await classifyTurnResponse("  Identical message  ");

      expect(b.pipe).toHaveBeenCalledTimes(1);
    });

    it("shares the in-flight promise for concurrent calls with identical text", async () => {
      let resolveCall!: (v: any) => void;
      const pending = new Promise((res) => { resolveCall = res; });
      const b = { kind: "seq" as const, pipe: vi.fn().mockImplementation(() => pending) };
      setClassifierBackend(Promise.resolve(b));

      const p1 = classifyTurnResponse("concurrent");
      const p2 = classifyTurnResponse("concurrent");
      resolveCall([{ label: "refusal", score: 0.9 }]);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe("REFUSAL");
      expect(r2).toBe("REFUSAL");
      expect(b.pipe).toHaveBeenCalledTimes(1);
    });

    it("resetClassifierCache causes a fresh inference on the next call", async () => {
      const b = seqBackend("non-refusal");
      setClassifierBackend(Promise.resolve(b));

      await classifyTurnResponse("Cache invalidation test");
      expect(b.pipe).toHaveBeenCalledTimes(1);

      resetClassifierCache();
      await classifyTurnResponse("Cache invalidation test");
      expect(b.pipe).toHaveBeenCalledTimes(2);
    });

    it("evicts a failed promise so a subsequent call can retry", async () => {
      const b = {
        kind: "seq" as const,
        pipe: vi
          .fn()
          .mockRejectedValueOnce(new Error("transient inference error"))
          .mockResolvedValueOnce([{ label: "non-refusal", score: 0.9 }]),
      };
      setClassifierBackend(Promise.resolve(b));

      expect(await classifyTurnResponse("Retry after failure")).toBe("DELIVERABLE");
      await Promise.resolve(); // let the catch handler evict the cache entry
      expect(await classifyTurnResponse("Retry after failure")).toBe("DELIVERABLE");
      expect(b.pipe).toHaveBeenCalledTimes(2);
    });

    it("evicts oldest entry when cache reaches MAX_CLASSIFIER_CACHE_SIZE (100)", async () => {
      const b = seqBackend("non-refusal");
      setClassifierBackend(Promise.resolve(b));

      for (let i = 0; i < 100; i++) await classifyTurnResponse(`Prompt ${i}`);
      expect(b.pipe).toHaveBeenCalledTimes(100);

      await classifyTurnResponse("Prompt 1"); // still cached
      expect(b.pipe).toHaveBeenCalledTimes(100);

      await classifyTurnResponse("Prompt 100"); // evicts "Prompt 0"
      expect(b.pipe).toHaveBeenCalledTimes(101);

      await classifyTurnResponse("Prompt 0"); // evicted → re-classified
      expect(b.pipe).toHaveBeenCalledTimes(102);
    });
  });

  // ---------------------------------------------------------------------------
  // warmupClassifier
  // ---------------------------------------------------------------------------

  describe("warmupClassifier", () => {
    it("resolves without throwing even when the backend load fails", async () => {
      setClassifierBackend(Promise.reject(new Error("load error")));
      await expect(warmupClassifier()).resolves.toBeUndefined();
    });

    it("resolves without throwing when the backend loads successfully", async () => {
      setClassifierBackend(Promise.resolve(seqBackend("non-refusal")));
      await expect(warmupClassifier()).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Gated acceptance suite — the REAL classifier against the curated corpora.
//
// These exercise the actual model (local ModernBERT head, else the NLI fallback),
// not the mock, so they are opt-in: run with M365_CLASSIFIER_ACCEPTANCE=1.
// They are the acceptance test for refusals.txt / antirefusals.txt — validation
// of the corpus lives HERE, not in the regex-heuristic unit tests.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCEPTANCE = process.env.M365_CLASSIFIER_ACCEPTANCE === "1";

function loadCorpus(file: string): string[] {
  return readFileSync(join(__dirname, "..", "..", "..", file), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((l) => l.replace(/\\n/g, "\n"));
}

describe.skipIf(!ACCEPTANCE)("refusal corpus acceptance (real classifier)", () => {
  beforeEach(() => {
    setClassifierBackend(null); // force a real model load
    resetClassifierCache();
  });
  afterEach(() => {
    setClassifierBackend(null);
    resetClassifierCache();
  });

  it("classifies every known refusal (refusals.txt) as REFUSAL", async () => {
    const refusals = loadCorpus("refusals.txt");
    expect(refusals.length).toBeGreaterThan(0);
    const misses: string[] = [];
    for (const r of refusals) {
      if ((await classifyTurnResponse(r)) !== "REFUSAL") misses.push(r.replace(/\s+/g, " ").slice(0, 120));
    }
    expect(misses).toEqual([]);
  }, 900_000);

  it("does not flag any known deliverable (antirefusals.txt) as REFUSAL", async () => {
    const antirefusals = loadCorpus("antirefusals.txt");
    expect(antirefusals.length).toBeGreaterThan(0);
    const falsePositives: string[] = [];
    for (const a of antirefusals) {
      if ((await classifyTurnResponse(a)) === "REFUSAL") falsePositives.push(a.replace(/\s+/g, " ").slice(0, 120));
    }
    expect(falsePositives).toEqual([]);
  }, 900_000);
});
