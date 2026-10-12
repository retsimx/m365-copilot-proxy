import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CLASSIFIER_MODEL_ID,
  CLASSIFIER_LABELS,
  CLASSIFIER_HYPOTHESIS_TEMPLATE,
  classifyTurnResponse,
  setClassifierPipelinePromise,
  resetClassifierCache,
  warmupClassifier,
} from "./classifier.js";

describe("Classifier Module", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setClassifierPipelinePromise(null);
    resetClassifierCache();
  });

  afterEach(() => {
    setClassifierPipelinePromise(null);
    resetClassifierCache();
  });

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  describe("exported constants", () => {
    it("CLASSIFIER_MODEL_ID is the expected NLI model", () => {
      expect(CLASSIFIER_MODEL_ID).toBe("Xenova/nli-deberta-v3-base");
    });

    it("CLASSIFIER_LABELS has refusal as index 0 and deliverable as index 1", () => {
      expect(CLASSIFIER_LABELS[0]).toMatch(/cannot perform/i);
      expect(CLASSIFIER_LABELS[1]).toMatch(/actual answer/i);
    });

    it("CLASSIFIER_HYPOTHESIS_TEMPLATE contains a {} placeholder", () => {
      expect(CLASSIFIER_HYPOTHESIS_TEMPLATE).toContain("{}");
    });
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function makePipeline(label: string) {
    return vi.fn().mockResolvedValue({ labels: [label, "other"] });
  }

  // ---------------------------------------------------------------------------
  // Empty / null / whitespace → DELIVERABLE (no inference)
  // ---------------------------------------------------------------------------

  describe("classifyTurnResponse — empty input", () => {
    it("returns DELIVERABLE for empty string without calling the pipeline", async () => {
      const fakePipe = makePipeline(CLASSIFIER_LABELS[0]);
      setClassifierPipelinePromise(Promise.resolve(fakePipe));

      expect(await classifyTurnResponse("")).toBe("DELIVERABLE");
      expect(fakePipe).not.toHaveBeenCalled();
    });

    it("returns DELIVERABLE for whitespace-only string", async () => {
      const fakePipe = makePipeline(CLASSIFIER_LABELS[0]);
      setClassifierPipelinePromise(Promise.resolve(fakePipe));

      expect(await classifyTurnResponse("   \n\t  ")).toBe("DELIVERABLE");
      expect(fakePipe).not.toHaveBeenCalled();
    });

    it("returns DELIVERABLE for null", async () => {
      expect(await classifyTurnResponse(null)).toBe("DELIVERABLE");
    });

    it("returns DELIVERABLE for undefined", async () => {
      expect(await classifyTurnResponse(undefined)).toBe("DELIVERABLE");
    });
  });

  // ---------------------------------------------------------------------------
  // Normal classification paths
  // ---------------------------------------------------------------------------

  describe("classifyTurnResponse — classification via injected pipeline", () => {
    it("returns REFUSAL when pipeline labels[0] is the refusal label", async () => {
      const fakePipe = makePipeline(CLASSIFIER_LABELS[0]);
      setClassifierPipelinePromise(Promise.resolve(fakePipe));

      const result = await classifyTurnResponse(
        "I cannot run commands because I do not have access to a shell."
      );

      expect(result).toBe("REFUSAL");
      expect(fakePipe).toHaveBeenCalledTimes(1);
      const [text, labels, opts] = fakePipe.mock.calls[0];
      expect(text).toBe("I cannot run commands because I do not have access to a shell.");
      expect(labels).toEqual(CLASSIFIER_LABELS);
      expect(opts.hypothesis_template).toBe(CLASSIFIER_HYPOTHESIS_TEMPLATE);
    });

    it("returns DELIVERABLE when pipeline labels[0] is the deliverable label", async () => {
      const fakePipe = makePipeline(CLASSIFIER_LABELS[1]);
      setClassifierPipelinePromise(Promise.resolve(fakePipe));

      const result = await classifyTurnResponse("The command exited with code 1.");
      expect(result).toBe("DELIVERABLE");
    });

    it("trims surrounding whitespace before passing text to the pipeline", async () => {
      const fakePipe = makePipeline(CLASSIFIER_LABELS[1]);
      setClassifierPipelinePromise(Promise.resolve(fakePipe));

      await classifyTurnResponse("  hello world  ");
      expect(fakePipe.mock.calls[0][0]).toBe("hello world");
    });
  });

  // ---------------------------------------------------------------------------
  // Fail-open behaviour
  // ---------------------------------------------------------------------------

  describe("classifyTurnResponse — fail-open on errors", () => {
    it("returns DELIVERABLE when the pipeline promise rejects (load failure)", async () => {
      setClassifierPipelinePromise(Promise.reject(new Error("model load failed")));

      const result = await classifyTurnResponse("Some text");
      expect(result).toBe("DELIVERABLE");
    });

    it("returns DELIVERABLE when the pipeline call itself throws", async () => {
      const fakePipe = vi.fn().mockRejectedValue(new Error("inference error"));
      setClassifierPipelinePromise(Promise.resolve(fakePipe));

      const result = await classifyTurnResponse("Some text");
      expect(result).toBe("DELIVERABLE");
    });
  });

  // ---------------------------------------------------------------------------
  // Cache behaviour
  // ---------------------------------------------------------------------------

  describe("classifyTurnResponse — memoisation", () => {
    it("calls pipeline only once for repeated identical text", async () => {
      const fakePipe = makePipeline(CLASSIFIER_LABELS[1]);
      setClassifierPipelinePromise(Promise.resolve(fakePipe));

      const r1 = await classifyTurnResponse("Identical message");
      const r2 = await classifyTurnResponse("Identical message");
      const r3 = await classifyTurnResponse("  Identical message  ");

      expect(r1).toBe("DELIVERABLE");
      expect(r2).toBe("DELIVERABLE");
      expect(r3).toBe("DELIVERABLE");
      expect(fakePipe).toHaveBeenCalledTimes(1);
    });

    it("shares the in-flight promise for concurrent calls with identical text", async () => {
      let resolveCall!: (v: any) => void;
      const pending = new Promise((res) => { resolveCall = res; });
      const fakePipe = vi.fn().mockImplementation(() => pending);
      setClassifierPipelinePromise(Promise.resolve(fakePipe));

      const p1 = classifyTurnResponse("concurrent");
      const p2 = classifyTurnResponse("concurrent");

      resolveCall({ labels: [CLASSIFIER_LABELS[0], CLASSIFIER_LABELS[1]] });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe("REFUSAL");
      expect(r2).toBe("REFUSAL");
      expect(fakePipe).toHaveBeenCalledTimes(1);
    });

    it("resetClassifierCache causes a fresh inference on the next call", async () => {
      const fakePipe = makePipeline(CLASSIFIER_LABELS[1]);
      setClassifierPipelinePromise(Promise.resolve(fakePipe));

      await classifyTurnResponse("Cache invalidation test");
      expect(fakePipe).toHaveBeenCalledTimes(1);

      resetClassifierCache();

      await classifyTurnResponse("Cache invalidation test");
      expect(fakePipe).toHaveBeenCalledTimes(2);
    });

    it("evicts a failed promise so a subsequent call can retry", async () => {
      const fakePipe = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient inference error"))
        .mockResolvedValueOnce({ labels: [CLASSIFIER_LABELS[1], CLASSIFIER_LABELS[0]] });
      setClassifierPipelinePromise(Promise.resolve(fakePipe));

      // First call: inference throws → fail-open → DELIVERABLE
      const r1 = await classifyTurnResponse("Retry after failure");
      expect(r1).toBe("DELIVERABLE");

      // Wait a tick for the catch handler to evict the cache entry
      await Promise.resolve();

      // Second call: cache miss → retries → DELIVERABLE (second mock value)
      const r2 = await classifyTurnResponse("Retry after failure");
      expect(r2).toBe("DELIVERABLE");
      expect(fakePipe).toHaveBeenCalledTimes(2);
    });

    it("evicts oldest entry when cache reaches MAX_CLASSIFIER_CACHE_SIZE (100)", async () => {
      const fakePipe = makePipeline(CLASSIFIER_LABELS[1]);
      setClassifierPipelinePromise(Promise.resolve(fakePipe));

      for (let i = 0; i < 100; i++) {
        await classifyTurnResponse(`Prompt ${i}`);
      }
      expect(fakePipe).toHaveBeenCalledTimes(100);

      // "Prompt 1" is still cached — no extra call
      await classifyTurnResponse("Prompt 1");
      expect(fakePipe).toHaveBeenCalledTimes(100);

      // Inserting entry 101 evicts "Prompt 0" (oldest)
      await classifyTurnResponse("Prompt 100");
      expect(fakePipe).toHaveBeenCalledTimes(101);

      // "Prompt 0" was evicted — re-classifying it calls the pipeline again
      await classifyTurnResponse("Prompt 0");
      expect(fakePipe).toHaveBeenCalledTimes(102);
    });
  });

  // ---------------------------------------------------------------------------
  // warmupClassifier
  // ---------------------------------------------------------------------------

  describe("warmupClassifier", () => {
    it("resolves without throwing even when the pipeline load fails", async () => {
      setClassifierPipelinePromise(Promise.reject(new Error("load error")));
      await expect(warmupClassifier()).resolves.toBeUndefined();
    });

    it("resolves without throwing when the pipeline loads successfully", async () => {
      const fakePipe = makePipeline(CLASSIFIER_LABELS[1]);
      setClassifierPipelinePromise(Promise.resolve(fakePipe));
      await expect(warmupClassifier()).resolves.toBeUndefined();
    });
  });
});