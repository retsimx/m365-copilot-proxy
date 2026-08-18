import { describe, it, expect } from "vitest";
import { SessionPool } from "./handler.js";

describe("SessionPool session isolation & fingerprinting", () => {
  const bashTool = [{
    type: "function" as const,
    function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } },
  }];

  it("isolates concurrent title generator and main agent requests with identical user message (fallback fingerprinting)", () => {
    const pool = new SessionPool();

    const titleGenMessages = [
      { role: "system" as const, content: "You are a title generator. You output ONLY a thread title. Nothing else." },
      { role: "user" as const, content: "/issue-autopilot 124" },
    ];

    const mainAgentMessages = [
      { role: "system" as const, content: "You are the execution core of an automated agent, not a chat assistant." },
      { role: "user" as const, content: "/issue-autopilot 124" },
    ];

    const titleSession = pool.resolve(titleGenMessages, undefined);
    const mainSession = pool.resolve(mainAgentMessages, bashTool);

    expect(pool.size).toBe(2);
    expect(titleSession).not.toBe(mainSession);
    expect(titleSession.session.conversationId).not.toBe(mainSession.session.conversationId);
  });

  it("routes multiple turns of the same conversation to the same session when no explicit sessionId is passed", () => {
    const pool = new SessionPool();

    const turn1Messages = [
      { role: "system" as const, content: "You are the execution core of an automated agent." },
      { role: "user" as const, content: "fix bug 123" },
    ];

    const turn2Messages = [
      { role: "system" as const, content: "You are the execution core of an automated agent." },
      { role: "user" as const, content: "fix bug 123" },
      { role: "assistant" as const, content: "```bash\nls\n```" },
      { role: "tool" as const, content: "file.ts", name: "bash", tool_call_id: "call_1" },
    ];

    const session1 = pool.resolve(turn1Messages, bashTool);
    const session2 = pool.resolve(turn2Messages, bashTool);

    expect(pool.size).toBe(1);
    expect(session1).toBe(session2);
  });

  it("uses explicit sessionId when provided, isolating different sessions with identical prompts", () => {
    const pool = new SessionPool();

    const messages = [
      { role: "system" as const, content: "You are an agent." },
      { role: "user" as const, content: "hello" },
    ];

    const sessionA = pool.resolve(messages, undefined, "sess-1234");
    const sessionB = pool.resolve(messages, undefined, "sess-5678");
    const sessionARepeat = pool.resolve(messages, undefined, "sess-1234");

    expect(pool.size).toBe(2);
    expect(sessionA).not.toBe(sessionB);
    expect(sessionA).toBe(sessionARepeat);
  });
});
