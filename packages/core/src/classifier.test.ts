import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CLASSIFIER_SYSTEM_PROMPT,
  normalizeChatCompletionsUrl,
  parseClassificationTag,
  classifyWithRemoteOpenAI,
  classifyWithLocalGemma,
  classifyTurnResponse,
  setLocalGemmaPromise,
  resetLocalGemma,
} from "./classifier.js";

describe("Classifier Module", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    resetLocalGemma();
    process.env = { ...originalEnv };
    delete process.env.M365_CLASSIFIER_OPENAI_URL;
    delete process.env.M365_CLASSIFIER_OPENAI_MODEL;
    delete process.env.M365_CLASSIFIER_TIMEOUT_MS;
    delete process.env.M365_CLASSIFIER_MAX_TOKENS;
  });

  afterEach(() => {
    resetLocalGemma();
    process.env = { ...originalEnv };
  });

  describe("normalizeChatCompletionsUrl", () => {
    it("appends /chat/completions to base URL", () => {
      expect(normalizeChatCompletionsUrl("http://localhost:11434/v1")).toBe(
        "http://localhost:11434/v1/chat/completions"
      );
      expect(normalizeChatCompletionsUrl("http://localhost:11434/v1/")).toBe(
        "http://localhost:11434/v1/chat/completions"
      );
    });

    it("preserves URL if it already ends with /chat/completions", () => {
      expect(
        normalizeChatCompletionsUrl("http://localhost:11434/v1/chat/completions")
      ).toBe("http://localhost:11434/v1/chat/completions");
      expect(
        normalizeChatCompletionsUrl("http://localhost:11434/v1/chat/completions/")
      ).toBe("http://localhost:11434/v1/chat/completions");
    });
  });

  describe("parseClassificationTag", () => {
    it("parses explicit tags in content", () => {
      expect(
        parseClassificationTag(
          "Here is the deliverable.\n[CLASSIFICATION: DELIVERABLE]"
        )
      ).toBe("DELIVERABLE");

      expect(
        parseClassificationTag(
          "I cannot do that.\n[CLASSIFICATION: REFUSAL]"
        )
      ).toBe("REFUSAL");

      expect(
        parseClassificationTag("Prefix [classification:  deliverable] suffix")
      ).toBe("DELIVERABLE");
      expect(
        parseClassificationTag("Prefix [classification:  refusal] suffix")
      ).toBe("REFUSAL");
    });

    it("parses tag in reasoning when content is empty", () => {
      expect(
        parseClassificationTag(
          "",
          "Thinking through the user prompt...\n[CLASSIFICATION: DELIVERABLE]"
        )
      ).toBe("DELIVERABLE");

      expect(
        parseClassificationTag(
          "",
          "The model declined to act.\n[CLASSIFICATION: REFUSAL]"
        )
      ).toBe("REFUSAL");
    });

    it("extracts unambiguous trailing classification from reasoning", () => {
      const reasoning =
        "The model reviewed the files, executed the tests, and reported findings. Therefore, this output is clearly a DELIVERABLE.";
      expect(parseClassificationTag("", reasoning)).toBe("DELIVERABLE");

      const refusalReasoning =
        "The assistant stated it cannot modify files in this directory. Overall assessment: REFUSAL.";
      expect(parseClassificationTag("", refusalReasoning)).toBe("REFUSAL");
    });

    it("extracts unambiguous trailing classification from content when tag is omitted", () => {
      const content =
        "Analysis complete. Everything looks solid and is classified as DELIVERABLE.";
      expect(parseClassificationTag(content)).toBe("DELIVERABLE");

      const refusalContent =
        "Sorry, I cannot help with that. Status: REFUSAL.";
      expect(parseClassificationTag(refusalContent)).toBe("REFUSAL");
    });

    it("returns null on gibberish or ambiguous text without tags", () => {
      expect(parseClassificationTag("hello world 12345")).toBeNull();
      expect(parseClassificationTag("some random prose without classification words")).toBeNull();
      expect(parseClassificationTag("", "just thinking about life")).toBeNull();
    });
  });

  describe("classifyWithRemoteOpenAI", () => {
    it("throws error if M365_CLASSIFIER_OPENAI_URL is not configured and url option is missing", async () => {
      await expect(
        classifyWithRemoteOpenAI("test content")
      ).rejects.toThrow("M365_CLASSIFIER_OPENAI_URL not configured");
    });

    it("classifies deliverable content with mock fetch returning 200", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: "Thought complete.\n[CLASSIFICATION: DELIVERABLE]",
              },
            },
          ],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await classifyWithRemoteOpenAI("I have updated the files.", {
        url: "http://localhost:11434/v1",
      });

      expect(result).toBe("DELIVERABLE");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [calledUrl, requestInit] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe("http://localhost:11434/v1/chat/completions");
      expect(requestInit.method).toBe("POST");

      const parsedBody = JSON.parse(requestInit.body);
      expect(parsedBody.model).toBe("gemma4:e2b");
      expect(parsedBody.temperature).toBe(0.0);
      expect(parsedBody.max_tokens).toBe(1000);
      expect(parsedBody.messages).toEqual([
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: 'Message to classify:\n"""\nI have updated the files.\n"""\n' },
      ]);
    });

    it("classifies refusal reasoning with mock fetch returning 200", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: "",
                reasoning: "The assistant refused to write files. [CLASSIFICATION: REFUSAL]",
              },
            },
          ],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await classifyWithRemoteOpenAI("I cannot write to the disk.", {
        url: "http://localhost:11434/v1",
      });

      expect(result).toBe("REFUSAL");
    });

    it("handles custom options (url, model, timeoutMs, maxTokens)", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: "[CLASSIFICATION: DELIVERABLE]",
              },
            },
          ],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await classifyWithRemoteOpenAI("Custom option test", {
        url: "http://gpu-host:11434/v1/chat/completions",
        model: "custom-gemma:latest",
        timeoutMs: 5000,
        maxTokens: 256,
      });

      expect(result).toBe("DELIVERABLE");
      const [calledUrl, requestInit] = mockFetch.mock.calls[0];
      expect(calledUrl).toBe("http://gpu-host:11434/v1/chat/completions");

      const parsedBody = JSON.parse(requestInit.body);
      expect(parsedBody.model).toBe("custom-gemma:latest");
      expect(parsedBody.max_tokens).toBe(256);
    });

    it("handles HTTP 500 error from remote endpoint", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 500,
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        classifyWithRemoteOpenAI("Test message", {
          url: "http://localhost:11434/v1",
        })
      ).rejects.toThrow("Remote classifier returned HTTP 500");
    });

    it("handles abort timeout", async () => {
      const mockFetch = vi.fn().mockRejectedValue(
        new DOMException("The operation was aborted due to timeout", "TimeoutError")
      );
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        classifyWithRemoteOpenAI("Test message", {
          url: "http://localhost:11434/v1",
          timeoutMs: 50,
        })
      ).rejects.toThrow("The operation was aborted");
    });

    it("falls back to DELIVERABLE if tag is null", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: "Some completely ambiguous and unparseable output without any tags",
              },
            },
          ],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await classifyWithRemoteOpenAI("Ambiguous test", {
        url: "http://localhost:11434/v1",
      });
      expect(result).toBe("DELIVERABLE");
    });
  });

  describe("classifyWithLocalGemma", () => {
    it("classifies using injected local Gemma mock with generate", async () => {
      const mockGemma = {
        generate: vi.fn().mockResolvedValue({
          content: "Reviewed code.\n[CLASSIFICATION: DELIVERABLE]",
          reasoning: "Looks like genuine work.",
        }),
      };
      setLocalGemmaPromise(Promise.resolve(mockGemma));

      const result = await classifyWithLocalGemma("Here is the requested patch.");
      expect(result).toBe("DELIVERABLE");
      expect(mockGemma.generate).toHaveBeenCalledTimes(1);
    });

    it("classifies refusal using injected local Gemma mock with chat", async () => {
      const mockGemma = {
        chat: vi.fn().mockResolvedValue({
          content: "I apologize, but I cannot modify files.\n[CLASSIFICATION: REFUSAL]",
        }),
      };
      setLocalGemmaPromise(Promise.resolve(mockGemma));

      const result = await classifyWithLocalGemma("I am unable to assist with editing files.");
      expect(result).toBe("REFUSAL");
      expect(mockGemma.chat).toHaveBeenCalledTimes(1);
    });

    it("resets local Gemma promise via resetLocalGemma", () => {
      const mockGemma = { generate: vi.fn() };
      setLocalGemmaPromise(Promise.resolve(mockGemma));
      resetLocalGemma();
      // localGemmaPromise is now null
    });
  });

  describe("classifyTurnResponse", () => {
    it("returns DELIVERABLE for empty or whitespace text", async () => {
      expect(await classifyTurnResponse("")).toBe("DELIVERABLE");
      expect(await classifyTurnResponse("   \n\t  ")).toBe("DELIVERABLE");
      expect(await classifyTurnResponse(null)).toBe("DELIVERABLE");
      expect(await classifyTurnResponse(undefined)).toBe("DELIVERABLE");
    });

    it("uses remote OpenAI when configured and healthy", async () => {
      process.env.M365_CLASSIFIER_OPENAI_URL = "http://localhost:11434/v1";

      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: "[CLASSIFICATION: REFUSAL]",
              },
            },
          ],
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const localMock = { generate: vi.fn() };
      setLocalGemmaPromise(Promise.resolve(localMock));

      const result = await classifyTurnResponse("I cannot write this code.");
      expect(result).toBe("REFUSAL");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(localMock.generate).not.toHaveBeenCalled();
    });

    it("falls back to local Gemma on remote error/timeout", async () => {
      process.env.M365_CLASSIFIER_OPENAI_URL = "http://localhost:11434/v1";

      const mockFetch = vi.fn().mockRejectedValue(new Error("Connection refused"));
      vi.stubGlobal("fetch", mockFetch);

      const localMock = {
        generate: vi.fn().mockResolvedValue({
          content: "[CLASSIFICATION: DELIVERABLE]",
        }),
      };
      setLocalGemmaPromise(Promise.resolve(localMock));

      const result = await classifyTurnResponse("Finished running test suite.");
      expect(result).toBe("DELIVERABLE");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(localMock.generate).toHaveBeenCalledTimes(1);
    });

    it("uses local Gemma when remote URL is not configured", async () => {
      delete process.env.M365_CLASSIFIER_OPENAI_URL;

      const localMock = {
        generate: vi.fn().mockResolvedValue({
          content: "[CLASSIFICATION: REFUSAL]",
        }),
      };
      setLocalGemmaPromise(Promise.resolve(localMock));

      const result = await classifyTurnResponse("I cannot help with this request.");
      expect(result).toBe("REFUSAL");
      expect(localMock.generate).toHaveBeenCalledTimes(1);
    });
  });
});
