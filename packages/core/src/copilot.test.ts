import { describe, expect, it } from "vitest";
import { getAvailableModels, getToneForModel } from "./copilot.js";

describe("GPT-5.6 and GPT-6 model routing", () => {
  it("maps the advertised model ID to the live-validated reasoning tone", () => {
    expect(getToneForModel("gpt-5.6-think-deeper")).toBe("Gpt_5_6_Reasoning");
    expect(getAvailableModels()).toContain("gpt-5.6-think-deeper");
  });

  it("maps GPT-5.6 aliases and variants to Gpt_5_6_Reasoning", () => {
    expect(getToneForModel("gpt-5.6")).toBe("Gpt_5_6_Reasoning");
    expect(getToneForModel("5.6")).toBe("Gpt_5_6_Reasoning");
    expect(getToneForModel("gpt-5.6-chat")).toBe("Gpt_5_6_Reasoning");
    expect(getToneForModel("gpt-5.6-quick")).toBe("Gpt_5_6_Reasoning");
    expect(getToneForModel("gpt-5.6-reasoning")).toBe("Gpt_5_6_Reasoning");
    expect(getToneForModel("custom-5.6-model")).toBe("Gpt_5_6_Reasoning");
  });

  it("maps GPT-6 aliases to Gpt_6_Astra", () => {
    expect(getToneForModel("gpt-6")).toBe("Gpt_6_Astra");
    expect(getToneForModel("gpt-6-astra")).toBe("Gpt_6_Astra");
    expect(getToneForModel("astra")).toBe("Gpt_6_Astra");
  });
});
