import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelSession } from "./model.js";
import { CopilotSession } from "./session.js";

describe("ModelSession reconnect accounting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("awaits the reconnect permit before a second upstream chat attempt", async () => {
    const order: string[] = [];
    const stream = { fullText: "ok" } as any;
    const chat = vi.spyOn(CopilotSession.prototype, "chat")
      .mockImplementationOnce(async () => {
        order.push("chat-1");
        throw new Error("transport failed");
      })
      .mockImplementationOnce(async () => {
        order.push("chat-2");
        return stream;
      });
    const beforeReconnectAttempt = vi.fn(async () => {
      order.push("permit");
    });
    const session = new ModelSession({
      getToken: async () => "header.eyJvaWQiOiJvIiwidGlkIjoidCJ9.signature",
      useAgent: false,
    });

    await expect(session.run("hello", "m365-copilot", undefined, false, {
      beforeReconnectAttempt,
    })).resolves.toBe(stream);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(beforeReconnectAttempt).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["chat-1", "permit", "chat-2"]);
  });

  it("does not request a reconnect permit when the first chat attempt succeeds", async () => {
    const stream = { fullText: "ok" } as any;
    vi.spyOn(CopilotSession.prototype, "chat").mockResolvedValue(stream);
    const beforeReconnectAttempt = vi.fn(async () => {});
    const session = new ModelSession({
      getToken: async () => "header.eyJvaWQiOiJvIiwidGlkIjoidCJ9.signature",
      useAgent: false,
    });

    await session.run("hello", "m365-copilot", undefined, false, {
      beforeReconnectAttempt,
    });

    expect(beforeReconnectAttempt).not.toHaveBeenCalled();
  });
});
