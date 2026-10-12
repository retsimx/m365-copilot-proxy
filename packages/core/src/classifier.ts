import { createLogger } from "./log.js";

const log = createLogger("classifier");

export const CLASSIFIER_MODEL_ID = "Xenova/nli-deberta-v3-base";

export const CLASSIFIER_LABELS = [
  "the assistant claiming it cannot perform the task",
  "the assistant providing its actual answer or results",
] as const;

export const CLASSIFIER_HYPOTHESIS_TEMPLATE = "This message shows {}.";

// ---------------------------------------------------------------------------
// Singleton pipeline — lazy-loaded once per process
// ---------------------------------------------------------------------------

let pipelinePromise: Promise<any> | null = null;

/**
 * Test hook: inject a fake pipeline promise (mirrors the old setLocalGemmaPromise pattern).
 */
export function setClassifierPipelinePromise(promise: Promise<any> | null): void {
  pipelinePromise = promise;
}

async function getPipeline(): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return pipeline("zero-shot-classification", CLASSIFIER_MODEL_ID, {
        dtype: "q8",
        device: "cpu",
      });
    })();
    // On failure, evict so the next call can retry
    pipelinePromise.catch(() => {
      pipelinePromise = null;
    });
  }
  return pipelinePromise;
}

/**
 * Trigger the lazy model load at startup. Safe to call and ignore the return value.
 */
export async function warmupClassifier(): Promise<void> {
  try {
    await getPipeline();
  } catch (err: any) {
    log.warn(`Classifier warmup failed — will retry on first use: ${err?.message ?? err}`);
  }
}

// ---------------------------------------------------------------------------
// In-memory result cache
// ---------------------------------------------------------------------------

const classifierCache = new Map<string, Promise<"REFUSAL" | "DELIVERABLE">>();
const MAX_CLASSIFIER_CACHE_SIZE = 100;

export function resetClassifierCache(): void {
  classifierCache.clear();
}

// ---------------------------------------------------------------------------
// Core classification function
// ---------------------------------------------------------------------------

/**
 * Classify an assistant turn as REFUSAL or DELIVERABLE using an in-process
 * zero-shot NLI pipeline (Xenova/nli-deberta-v3-base, quantised q8, CPU).
 *
 * - Returns "DELIVERABLE" for empty/whitespace text (fail-open).
 * - Returns "DELIVERABLE" on any inference error (fail-open — never block a turn).
 * - Results are memoised by trimmed text (up to MAX_CLASSIFIER_CACHE_SIZE entries).
 */
export async function classifyTurnResponse(
  text: string | null | undefined,
): Promise<"REFUSAL" | "DELIVERABLE"> {
  if (!text || text.trim().length === 0) {
    return "DELIVERABLE";
  }

  const key = text.trim();

  let promise = classifierCache.get(key);
  if (!promise) {
    promise = (async (): Promise<"REFUSAL" | "DELIVERABLE"> => {
      const pipe = await getPipeline();
      const result = await pipe(key, CLASSIFIER_LABELS, {
        hypothesis_template: CLASSIFIER_HYPOTHESIS_TEMPLATE,
      });
      return result.labels[0] === CLASSIFIER_LABELS[0] ? "REFUSAL" : "DELIVERABLE";
    })();

    // Evict failed promises so transient errors do not get permanently cached
    promise.catch(() => {
      classifierCache.delete(key);
    });

    if (classifierCache.size >= MAX_CLASSIFIER_CACHE_SIZE) {
      const oldestKey = classifierCache.keys().next().value;
      if (oldestKey !== undefined) classifierCache.delete(oldestKey);
    }
    classifierCache.set(key, promise);
  }

  try {
    const verdict = await promise;
    const preview = key.replace(/\s+/g, " ").slice(0, 200);
    log.info(`Classifier: ${verdict} (${key.length} chars) — "${preview}"`);
    return verdict;
  } catch (err: any) {
    log.warn(`Classifier load/inference failed — failing open: ${err?.message ?? err}`);
    return "DELIVERABLE";
  }
}
