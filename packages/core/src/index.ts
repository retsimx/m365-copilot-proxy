export {
  getToken,
  getTokenSilent,
  getTokenForScope,
  getImageArtifactToken,
  loginAutomated,
  loadSecrets,
  forceReauth,
} from "./auth.js";

export {
  generateImage,
  fetchImageBytes,
  buildImagePrompt,
  classifyImageFailure,
  ImageGenerationError,
  type GeneratedImage,
  type GenerateImageOptions,
  type ImageOrientation,
  type ImageStyle,
  type ImageGenFailureReason,
} from "./image.js";

export {
  noteRequestOutcome,
  isDegradationBackoff,
  getRemainingDegradationCooldownMs,
  getDegradationLevel,
  getDegradationBackoffReason,
  triggerDegradationBackoff,
  createBackoffController,
  type BackoffController,
  type BackoffOptions,
} from "./auth-recovery.js";

export { getOrCreateAgent } from "./agent.js";

export {
  decodeJwt,
  getToneForModel,
  getAvailableModels,
  type CopilotStream,
  type CapturedImage,
} from "./copilot.js";

export {
  CopilotSession,
  isThrottled,
  type CopilotSessionOptions,
  type ChatTurnOptions,
  type NativeActionConfig,
} from "./session.js";

export {
  parseActionConfirmation,
  buildResumeInvokeAction,
  shouldAutoConfirm,
  buildNativeActionPrompt,
  NATIVE_ACTION_INSTRUCTIONS,
  ACTION_ALLOWED_MESSAGE_TYPES,
  ACTION_CONFIRM_MESSAGE_TYPES,
  type ActionConfirmation,
} from "./native-actions.js";

export {
  ModelSession,
  type ModelSessionOptions,
  type ModelRunOptions,
} from "./model.js";

export {
  formatMessages,
  formatSessionFraming,
  formatToolChoiceInstruction,
  getMessageContent,
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeRemoteArtifactCompletion,
  isProseDocument,
  type Message,
  type ToolDef,
  type ToolFunction,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
} from "./tools.js";

export {
  currentFramingVariant,
  framingVariantForTone,
  isAdvisorTone,
  restoreM365Fences,
  agentTurnProhibition,
  buildSpecMap,
  SHELL_LANGS,
  createProseStreamGate,
  createFenceBodyState,
  feedToolBodyLine,
  type FencedToolSpec,
  type FenceBodyState,
  type ProseStreamGate,
} from "./fenced.js";

export { createLogger, trunc, LOG_PATH } from "./log.js";

export {
  CLASSIFIER_MODEL_ID,
  CLASSIFIER_LABELS,
  CLASSIFIER_HYPOTHESIS_TEMPLATE,
  classifyTurnResponse,
  warmupClassifier,
  setClassifierPipelinePromise,
  resetClassifierCache,
} from "./classifier.js";
