import { createLogger } from "./log.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const log = createLogger("classifier");

// ---------------------------------------------------------------------------
// Model configuration
//
// Two backends, tried in order:
//
//   1. A locally-hosted fine-tuned refusal head — a ModernBERT sequence
//      classifier (8k context) such as `natong19/refusal_classifier` exported to
//      ONNX. It is NOT published on the Hub with ONNX weights, so it must be
//      built locally and dropped in (see docs/classifier-model.md). Its positive
//      (refusal) label is matched by POSITIVE_LABEL_RE.
//
//   2. Fallback: the legacy zero-shot NLI classifier (deberta-v3-base, 512-token)
//      — used automatically when the local head is not found, so a host without
//      the model still works out of the box.
// ---------------------------------------------------------------------------

/** Legacy fallback classifier id (zero-shot NLI, 512-token context). */
export const CLASSIFIER_NLI_MODEL_ID = "Xenova/nli-deberta-v3-base";

/** Candidate labels for the legacy zero-shot NLI pipeline. */
export const CLASSIFIER_LABELS = [
  "the assistant claiming it cannot perform the task",
  "the assistant providing its actual answer or results",
] as const;

export const CLASSIFIER_HYPOTHESIS_TEMPLATE = "This message shows {}.";

/**
 * Directory of the preferred local fine-tuned head. Override with
 * `M365_CLASSIFIER_MODEL` (absolute path). Defaults under the app config dir.
 */
export const CLASSIFIER_LOCAL_MODEL_DIR =
  process.env.M365_CLASSIFIER_MODEL ??
  join(homedir(), ".config", "opencode-m365", "models", "natong19");

/**
 * Regex matching the local head's "refusal" label in its `id2label`.
 * Default `^refus` matches `refusal` but not `non-refusal`.
 * Override with `M365_CLASSIFIER_POSITIVE_LABEL`.
 */
export const CLASSIFIER_POSITIVE_LABEL =
  process.env.M365_CLASSIFIER_POSITIVE_LABEL ?? "^refus";

const POSITIVE_LABEL_RE = new RegExp(CLASSIFIER_POSITIVE_LABEL, "i");

// ---------------------------------------------------------------------------
// Singleton backend — lazy-loaded once per process
// ---------------------------------------------------------------------------

export interface ClassifierBackend {
  kind: "seq" | "nli";
  pipe: (text: string, ...rest: any[]) => Promise<any>;
}

let backendPromise: Promise<ClassifierBackend> | null = null;

/** Test hook: inject a fake backend (or null to reset). */
export function setClassifierBackend(backend: Promise<ClassifierBackend> | null): void {
  backendPromise = backend;
}

/** @deprecated alias kept for callers that used the old hook name. */
export const setClassifierPipelinePromise = setClassifierBackend;

function localHeadAvailable(dir: string): boolean {
  try {
    return existsSync(join(dir, "config.json")) && existsSync(join(dir, "onnx", "model.onnx"));
  } catch {
    return false;
  }
}

async function loadBackend(): Promise<ClassifierBackend> {
  const { pipeline } = await import("@huggingface/transformers");

  if (localHeadAvailable(CLASSIFIER_LOCAL_MODEL_DIR)) {
    log.info(`Classifier: loading local fine-tuned head from ${CLASSIFIER_LOCAL_MODEL_DIR}`);
    const pipe = await pipeline("text-classification", CLASSIFIER_LOCAL_MODEL_DIR, {
      dtype: "fp32",
      device: "cpu",
    });
    return { kind: "seq", pipe };
  }

  log.warn(
    `Classifier: local head not found at ${CLASSIFIER_LOCAL_MODEL_DIR} — ` +
      `falling back to zero-shot NLI (${CLASSIFIER_NLI_MODEL_ID}). ` +
      `See docs/classifier-model.md to install the local head.`,
  );
  const pipe = await pipeline("zero-shot-classification", CLASSIFIER_NLI_MODEL_ID, {
    dtype: "q8",
    device: "cpu",
  });
  return { kind: "nli", pipe };
}

async function getBackend(): Promise<ClassifierBackend> {
  if (!backendPromise) {
    backendPromise = loadBackend();
    // On failure, evict so the next call can retry
    backendPromise.catch(() => {
      backendPromise = null;
    });
  }
  return backendPromise;
}

/**
 * Trigger the lazy model load at startup. Safe to call and ignore the return value.
 */
export async function warmupClassifier(): Promise<void> {
  try {
    await getBackend();
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

async function infer(backend: ClassifierBackend, text: string): Promise<"REFUSAL" | "DELIVERABLE"> {
  if (backend.kind === "seq") {
    // Sequence classifier: pipeline returns [{ label, score }] (or a single object).
    const out = await backend.pipe(text);
    const top = Array.isArray(out) ? out[0] : out;
    const label = String(top?.label ?? "");
    return POSITIVE_LABEL_RE.test(label) ? "REFUSAL" : "DELIVERABLE";
  }
  // Zero-shot NLI: the top label is one of CLASSIFIER_LABELS; index 0 = refusal.
  const result = await backend.pipe(text, CLASSIFIER_LABELS, {
    hypothesis_template: CLASSIFIER_HYPOTHESIS_TEMPLATE,
  });
  return result.labels[0] === CLASSIFIER_LABELS[0] ? "REFUSAL" : "DELIVERABLE";
}

/**
 * Classify an assistant turn as REFUSAL or DELIVERABLE.
 *
 * Prefers a locally-hosted fine-tuned ModernBERT head (8k context); falls back to
 * the built-in zero-shot NLI when the local head is absent.
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
      const backend = await getBackend();
      return infer(backend, key);
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
