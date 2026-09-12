import { createLogger } from "./log.js";

const log = createLogger("classifier");

export const CLASSIFIER_SYSTEM_PROMPT =
  "You are an automated proxy classifier evaluating whether an AI assistant's message is an operational REFUSAL to act or a completed DELIVERABLE.\n\n" +
  "Classify the message into exactly one category:\n\n" +
  "- REFUSAL: The assistant refuses to use available tools or perform requested actions by claiming operational inability. Specifically, it:\n" +
  "  * Claims it lacks access to tools, terminal, filesystem, bash, or execution capabilities (EVEN if formatted as a status report, note, or error reason).\n" +
  "  * States that files, scripts, or artefacts could not be written, generated, or verified because tools or capabilities are not available or disabled.\n" +
  "  * Apologizes that it is only an AI language model and cannot interact with the environment, run code, or write files.\n" +
  "  * Asks the user to run commands, edit files, or paste contents instead of doing it itself.\n" +
  "  * Falsely claims tools are not available or not provided in this session.\n" +
  "  * The presence of follow-up analysis, critique, or advice does NOT make the message a deliverable if the assistant begins or explains that it could not or will not modify/generate/write requested files or execute commands due to missing tools or capabilities.\n\n" +
  "- DELIVERABLE: The assistant actually responds to the request or reports results from executing the task. This includes:\n" +
  "  * Answering the user's prompt, providing code, reviews, audits, explanations, or analysis.\n" +
  "  * Reporting the empirical outcome of an executed command, test, or task — such as when commands exit with non-zero exit codes, tests fail, builds break, or verification fails on disk. (Reporting a real execution error or test failure is an empirical diagnostic result, NOT an operational refusal. However, claiming tools do not exist or are disabled is an operational refusal).\n" +
  "  * Concluding a workflow or summarizing what happened.\n\n" +
  "Think carefully first, then end with either [CLASSIFICATION: REFUSAL] or [CLASSIFICATION: DELIVERABLE].";

/**
 * Normalizes an OpenAI-compatible URL so that it ends with `/chat/completions`.
 */
export function normalizeChatCompletionsUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

/**
 * Parses the classification tag or trailing unambiguous decision from content and reasoning.
 */
export function parseClassificationTag(
  content: string,
  reasoning?: string
): "REFUSAL" | "DELIVERABLE" | null {
  const tagRegex = /\[CLASSIFICATION:\s*(REFUSAL|DELIVERABLE)\]/i;

  if (content) {
    const match = content.match(tagRegex);
    if (match) {
      return match[1].toUpperCase() as "REFUSAL" | "DELIVERABLE";
    }
  }

  if (reasoning) {
    const match = reasoning.match(tagRegex);
    if (match) {
      return match[1].toUpperCase() as "REFUSAL" | "DELIVERABLE";
    }
  }

  const checkTrailing = (str?: string): "REFUSAL" | "DELIVERABLE" | null => {
    if (!str) return null;
    const trailing = str.slice(-200);
    const hasRefusal = /\brefusal\b/i.test(trailing);
    const hasDeliverable = /\bdeliverable\b/i.test(trailing);
    if (hasRefusal && !hasDeliverable) return "REFUSAL";
    if (hasDeliverable && !hasRefusal) return "DELIVERABLE";
    return null;
  };

  const trailingFromContent = checkTrailing(content);
  if (trailingFromContent) return trailingFromContent;

  const trailingFromReasoning = checkTrailing(reasoning);
  if (trailingFromReasoning) return trailingFromReasoning;

  return null;
}

export interface RemoteClassifierOptions {
  url?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
}

/**
 * Classifies an assistant turn using a remote OpenAI-compatible endpoint.
 */
export async function classifyWithRemoteOpenAI(
  text: string,
  options?: RemoteClassifierOptions
): Promise<"REFUSAL" | "DELIVERABLE"> {
  const rawUrl = options?.url ?? process.env.M365_CLASSIFIER_OPENAI_URL;
  if (!rawUrl || rawUrl.trim().length === 0) {
    throw new Error("M365_CLASSIFIER_OPENAI_URL not configured");
  }

  const model = options?.model ?? process.env.M365_CLASSIFIER_OPENAI_MODEL ?? "gemma4:e2b";
  const timeoutMs = options?.timeoutMs ?? Number(process.env.M365_CLASSIFIER_TIMEOUT_MS ?? 10000);
  const maxTokens = options?.maxTokens ?? Number(process.env.M365_CLASSIFIER_MAX_TOKENS ?? 1000);

  const endpoint = normalizeChatCompletionsUrl(rawUrl);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const apiKey = process.env.M365_CLASSIFIER_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: `Message to classify:\n"""\n${text}\n"""\n` },
      ],
      temperature: 0.0,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (res.status !== 200) {
    throw new Error(`Remote classifier returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as any;
  const choice = data?.choices?.[0];
  const content = (typeof choice?.message?.content === "string" ? choice.message.content : "") || "";
  const reasoning =
    (typeof choice?.message?.reasoning === "string"
      ? choice.message.reasoning
      : typeof choice?.message?.reasoning_content === "string"
      ? choice.message.reasoning_content
      : "") || "";

  const tag = parseClassificationTag(content, reasoning);
  return tag ?? "DELIVERABLE";
}

let localGemmaPromise: Promise<any> | null = null;

/**
 * Test hook to override or inject the local Gemma singleton promise.
 */
export function setLocalGemmaPromise(promise: Promise<any> | null): void {
  localGemmaPromise = promise;
}

/**
 * Test hook to reset the local Gemma singleton promise.
 */
export function resetLocalGemma(): void {
  localGemmaPromise = null;
}

async function getLocalGemma(): Promise<any> {
  if (!localGemmaPromise) {
    localGemmaPromise = (async () => {
      const { Gemma } = await import("@kessler/gemma");
      const gemma = new Gemma({ model: "gemma-4-e2b", device: "cpu" });
      if (typeof (gemma as any).init === "function") {
        await (gemma as any).init();
      } else if (typeof (gemma as any).load === "function") {
        await (gemma as any).load();
      }
      return gemma;
    })();
  }
  return localGemmaPromise;
}

export interface LocalGemmaOptions {
  maxTokens?: number;
}

/**
 * Classifies an assistant turn using an in-process local Gemma instance.
 */
export async function classifyWithLocalGemma(
  text: string,
  options?: LocalGemmaOptions
): Promise<"REFUSAL" | "DELIVERABLE"> {
  const gemma = await getLocalGemma();
  const userContent = `Message to classify:\n"""\n${text}\n"""\n`;
  const maxTokens = options?.maxTokens ?? Number(process.env.M365_CLASSIFIER_MAX_TOKENS ?? 1000);

  let rawResponse: any;

  if (typeof gemma.chat === "function") {
    rawResponse = await gemma.chat({
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      thinking: true,
      maxTokens,
    });
  } else if (typeof gemma.generate === "function") {
    try {
      rawResponse = await gemma.generate({
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        messages: [
          { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        prompt: `System: ${CLASSIFIER_SYSTEM_PROMPT}\nUser: ${userContent}`,
        thinking: true,
        maxTokens,
      });
    } catch (err: any) {
      if (typeof gemma.load === "function" || err?.message?.includes("images") || err instanceof TypeError) {
        const { buildPrompt } = await import("@kessler/gemma").catch(() => ({ buildPrompt: undefined }));
        const prompt = typeof buildPrompt === "function"
          ? buildPrompt(CLASSIFIER_SYSTEM_PROMPT, [], [{ role: "user", content: userContent }], true)
          : `<|turn>system\n<|think|>${CLASSIFIER_SYSTEM_PROMPT}<turn|>\n<|turn>user\n${userContent}<turn|>\n<|turn>model`;
        rawResponse = await gemma.generate(prompt, [], [], {
          maxTokens,
          thinking: true,
        });
      } else {
        throw err;
      }
    }
  } else {
    throw new Error("Local Gemma instance does not have generate or chat method");
  }

  let content = "";
  let reasoning = "";

  if (typeof rawResponse === "string") {
    try {
      const { extractThinking } = await import("@kessler/gemma").catch(() => ({ extractThinking: undefined }));
      if (typeof extractThinking === "function") {
        const extracted = extractThinking(rawResponse);
        reasoning = extracted.thinking || "";
        content = extracted.rest || rawResponse;
      } else {
        content = rawResponse;
      }
    } catch {
      content = rawResponse;
    }
  } else if (rawResponse && typeof rawResponse === "object") {
    content =
      (typeof rawResponse.content === "string"
        ? rawResponse.content
        : typeof rawResponse.text === "string"
        ? rawResponse.text
        : typeof rawResponse.response === "string"
        ? rawResponse.response
        : typeof rawResponse.message?.content === "string"
        ? rawResponse.message.content
        : "") || "";
    reasoning =
      (typeof rawResponse.reasoning === "string"
        ? rawResponse.reasoning
        : typeof rawResponse.thinking === "string"
        ? rawResponse.thinking
        : typeof rawResponse.message?.reasoning === "string"
        ? rawResponse.message.reasoning
        : "") || "";
  }

  const tag = parseClassificationTag(content, reasoning);
  return tag ?? "DELIVERABLE";
}

/**
 * Unified classifier function.
 * Handles empty/whitespace text, routes to remote OpenAI if configured,
 * and falls back to local Gemma on error or when unconfigured.
 */
export async function classifyTurnResponse(
  text: string | null | undefined
): Promise<"REFUSAL" | "DELIVERABLE"> {
  if (!text || text.trim().length === 0) {
    return "DELIVERABLE";
  }

  if (process.env.M365_CLASSIFIER_OPENAI_URL) {
    try {
      return await classifyWithRemoteOpenAI(text);
    } catch (err: any) {
      log.warn(
        `Remote classifier failed (${err?.message ?? err}) — falling back to local Gemma E2B`
      );
    }
  }

  return await classifyWithLocalGemma(text);
}
