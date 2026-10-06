import { describe, expect, it } from "vitest";
import { getAvailableModels, getToneForModel } from "./copilot.js";

describe("GPT-5.6 and GPT-6 model routing", () => {
  it("maps the advertised model ID to the live-validated reasoning tone", () => {
    expect(getToneForModel("gpt-5.6-think-deeper")).toBe("Gpt_5_6_Reasoning");
    expect(getAvailableModels()).toContain("gpt-5.6-think-deeper");
  });

  it("maps GPT-5.6 quick and chat variants to Gpt_5_6_Chat", () => {
    expect(getToneForModel("gpt-5.6-quick")).toBe("Gpt_5_6_Chat");
    expect(getToneForModel("gpt-5.6-chat")).toBe("Gpt_5_6_Chat");
    expect(getToneForModel("5.6-chat")).toBe("Gpt_5_6_Chat");
    expect(getToneForModel("custom-5.6-quick")).toBe("Gpt_5_6_Chat");
  });

  it("maps GPT-5.6 reasoning variants to Gpt_5_6_Reasoning", () => {
    expect(getToneForModel("gpt-5.6")).toBe("Gpt_5_6_Reasoning");
    expect(getToneForModel("5.6")).toBe("Gpt_5_6_Reasoning");
    expect(getToneForModel("gpt-5.6-reasoning")).toBe("Gpt_5_6_Reasoning");
    expect(getToneForModel("gpt-5.6-think-deeper")).toBe("Gpt_5_6_Reasoning");
    expect(getToneForModel("custom-5.6-model")).toBe("Gpt_5_6_Reasoning");
  });

  it("maps GPT-6 aliases to Gpt_6_Astra", () => {
    expect(getToneForModel("gpt-6")).toBe("Gpt_6_Astra");
    expect(getToneForModel("gpt-6-astra")).toBe("Gpt_6_Astra");
    expect(getToneForModel("astra")).toBe("Gpt_6_Astra");
  });
});

describe("Claude model routing", () => {
  it("maps Claude Sonnet 5 variants to Claude_Sonnet_5", () => {
    expect(getToneForModel("claude-sonnet-5")).toBe("Claude_Sonnet_5");
    expect(getToneForModel("sonnet-5")).toBe("Claude_Sonnet_5");
    expect(getToneForModel("claude-5-sonnet")).toBe("Claude_Sonnet_5");
    expect(getToneForModel("custom-sonnet-5")).toBe("Claude_Sonnet_5");
  });

  it("maps Claude Sonnet 5.5 and default Claude variants to Claude_Sonnet", () => {
    expect(getToneForModel("claude-sonnet-5.5")).toBe("Claude_Sonnet");
    expect(getToneForModel("sonnet-5.5")).toBe("Claude_Sonnet");
    expect(getToneForModel("claude-5.5-sonnet")).toBe("Claude_Sonnet");
    expect(getToneForModel("claude-sonnet")).toBe("Claude_Sonnet");
    expect(getToneForModel("claude")).toBe("Claude_Sonnet");
    expect(getToneForModel("claude-3-7-sonnet")).toBe("Claude_Sonnet");
  });

  it("maps Claude Opus variants to Claude_Opus", () => {
    expect(getToneForModel("claude-opus-5.5")).toBe("Claude_Opus");
    expect(getToneForModel("opus-5.5")).toBe("Claude_Opus");
    expect(getToneForModel("claude-5.5-opus")).toBe("Claude_Opus");
    expect(getToneForModel("claude-opus")).toBe("Claude_Opus");
    expect(getToneForModel("opus")).toBe("Claude_Opus");
  });

  it("includes all newly supported models in getAvailableModels()", () => {
    const available = getAvailableModels();
    expect(available).toContain("gpt-5.6-quick");
    expect(available).toContain("gpt-5.6-chat");
    expect(available).toContain("gpt-5.6");
    expect(available).toContain("gpt-5.6-think-deeper");
    expect(available).toContain("gpt-5.6-reasoning");
    expect(available).toContain("5.6");

    expect(available).toContain("claude-sonnet-5");
    expect(available).toContain("claude-5-sonnet");
    expect(available).toContain("sonnet-5");

    expect(available).toContain("claude-sonnet-5.5");
    expect(available).toContain("claude-5.5-sonnet");
    expect(available).toContain("sonnet-5.5");

    expect(available).toContain("claude-opus-5.5");
    expect(available).toContain("claude-5.5-opus");
    expect(available).toContain("opus-5.5");
  });
});
