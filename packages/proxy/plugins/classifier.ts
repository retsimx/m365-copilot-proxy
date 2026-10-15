import { warmupClassifier } from "@m365-copilot/core";

// Preload the in-process refusal classifier at startup. The classifier is loaded
// lazily on first use otherwise, so the first tool-mode turn that needs a decision —
// possibly a mid-loop *retry* decision — would stall on the cold model load (a local
// fine-tuned head is a few seconds; it also fails fast here if M365_CLASSIFIER_MODEL
// points at a broken/partial head). Fire-and-forget: a load failure falls back to the
// bundled NLI and is retried on first use, so a warmup error must never block startup.
export default defineNitroPlugin(() => {
  warmupClassifier().catch(() => {});
});
