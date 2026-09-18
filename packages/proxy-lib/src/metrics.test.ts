import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as core from "@m365-copilot/core";
import {
  handleChatCompletion,
  getSystemMetricsConfig,
  recordTurn,
  recordNewSession,
  recordThrottle,
  recordRequestQuality,
  getQualityMetrics,
  resetMetrics,
  getMetricsSnapshot,
  getMetricsTotals,
  setMetricsTotals,
  getNewSessionsInWindow,
  getTurnsInWindow,
  MetricsCollector,
  SessionPool,
  resetNewSessionPacing,
  resetTurnVelocityPacing,
  createApp,
} from "./index.js";

describe("Telemetry Metrics Engine (proxy-lib)", () => {
  beforeEach(() => {
    resetMetrics();
    resetNewSessionPacing();
    resetTurnVelocityPacing();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetMetrics();
    resetNewSessionPacing();
    resetTurnVelocityPacing();
    vi.restoreAllMocks();
  });

  it("1. getSystemMetricsConfig dynamically resolves environment variables", () => {
    const originalBurst = process.env.M365_BURST_MAX_TURNS;
    const originalWarn = process.env.M365_SUSTAINED_WARN_TURNS;
    const originalMaxTurns = process.env.M365_MAX_TURNS_PER_CONVERSATION;

    try {
      process.env.M365_BURST_MAX_TURNS = "42";
      process.env.M365_SUSTAINED_WARN_TURNS = "99";
      process.env.M365_MAX_TURNS_PER_CONVERSATION = "750";

      const config = getSystemMetricsConfig();
      expect(config.burstMaxTurns).toBe(42);
      expect(config.burstSoftTurns).toBe(37); // 42 - 5
      expect(config.sustainedWarnTurns).toBe(99);
      expect(config.maxNumUserMessagesInConversation).toBe(750);
    } finally {
      if (originalBurst !== undefined) process.env.M365_BURST_MAX_TURNS = originalBurst;
      else delete process.env.M365_BURST_MAX_TURNS;

      if (originalWarn !== undefined) process.env.M365_SUSTAINED_WARN_TURNS = originalWarn;
      else delete process.env.M365_SUSTAINED_WARN_TURNS;

      if (originalMaxTurns !== undefined) process.env.M365_MAX_TURNS_PER_CONVERSATION = originalMaxTurns;
      else delete process.env.M365_MAX_TURNS_PER_CONVERSATION;
    }
  });

  it("2. recordTurn, recordNewSession, and recordThrottle increment buckets and totals", () => {
    const now = Date.now();

    recordTurn(now, 1500);
    recordTurn(now, 3000);
    recordNewSession(now, 500);
    recordThrottle(now);

    expect(getTurnsInWindow(600_000, now)).toBe(2);
    expect(getNewSessionsInWindow(600_000, now)).toBe(1);

    const snapshot = getMetricsSnapshot(undefined, "1h");
    expect(snapshot.totals.lifetimeTurns).toBe(2);
    expect(snapshot.totals.lifetimeSessions).toBe(1);
    expect(snapshot.totals.lifetimeThrottles).toBe(1);

    // Latest history point should show the aggregated values
    const latestPoint = snapshot.history.points[snapshot.history.points.length - 1];
    expect(latestPoint.turns).toBe(2);
    expect(latestPoint.newSessions).toBe(1);
    expect(latestPoint.throttles).toBe(1);
    expect(latestPoint.maxPacingDelayMs).toBe(3000);
  });

  it("3. evaluates safe / guarded / danger statuses for 10m and 60m horizons", () => {
    const collector = new MetricsCollector();
    const now = Date.now();

    // Fresh instance is safe
    expect(collector.getTurnsInWindow(600_000, now)).toBe(0);
    expect(collector.getNewSessionsInWindow(600_000, now)).toBe(0);

    const snapshot = getMetricsSnapshot(undefined, "1h");
    expect(snapshot.governor.tenMinute.status).toBe("safe");
    expect(snapshot.governor.sixtyMinute.status).toBe("safe");
    expect(snapshot.health).toBe("healthy");

    // Simulate 31 turns within 10 minutes (over softTurns = 30)
    for (let i = 0; i < 31; i++) {
      recordTurn(now - i * 1000, 2000);
    }

    const guardedSnapshot = getMetricsSnapshot(undefined, "1h");
    // 31 turns >= 30 soft limit -> guarded
    expect(guardedSnapshot.governor.tenMinute.turns).toBe(31);
    expect(guardedSnapshot.governor.tenMinute.status).toBe("guarded");
    expect(guardedSnapshot.health).toBe("warning");

    // Simulate 36 turns (over burstMax = 35) -> danger
    for (let i = 0; i < 5; i++) {
      recordTurn(now - i * 1000, 5000);
    }
    const dangerSnapshot = getMetricsSnapshot(undefined, "1h");
    expect(dangerSnapshot.governor.tenMinute.turns).toBe(36);
    expect(dangerSnapshot.governor.tenMinute.status).toBe("danger");
    expect(dangerSnapshot.health).toBe("danger");
  });

  it("4. SessionPool.getSessionsSnapshot() returns accurate session snapshots", () => {
    const pool = new SessionPool();

    const messages1 = [
      { role: "system" as const, content: "You are an agent." },
      { role: "user" as const, content: "Task 1" },
    ];

    const messages2 = [
      { role: "system" as const, content: "You are an agent." },
      { role: "user" as const, content: "Task 2" },
    ];

    const conv1 = pool.resolve(messages1, undefined, "session-alpha");
    conv1.turnCount = 5;

    const conv2 = pool.resolve(messages2, undefined, "session-beta");
    conv2.turnCount = 12;
    conv2.status = "streaming";

    const snapshots = pool.getSessionsSnapshot();
    expect(snapshots).toHaveLength(2);

    const snapAlpha = snapshots.find(s => s.sessionId === "session-alpha");
    expect(snapAlpha).toBeDefined();
    expect(snapAlpha?.turnCount).toBe(5);
    expect(snapAlpha?.status).toBe("idle");
    expect(snapAlpha?.maxTurns).toBe(600);
    expect(snapAlpha?.idleSeconds).toBeGreaterThanOrEqual(0);

    const snapBeta = snapshots.find(s => s.sessionId === "session-beta");
    expect(snapBeta).toBeDefined();
    expect(snapBeta?.turnCount).toBe(12);
    expect(snapBeta?.status).toBe("streaming");

    // Verify getMetricsSnapshot incorporates active sessions
    const fullSnapshot = getMetricsSnapshot(pool, "1h");
    expect(fullSnapshot.activeSessions).toHaveLength(2);
  });

  it("5. time bucket aggregation across 1h, 6h, and 24h ranges", () => {
    // 1h range = 60 points
    const snap1h = getMetricsSnapshot(undefined, "1h");
    expect(snap1h.history.range).toBe("1h");
    expect(snap1h.history.points).toHaveLength(60);

    // 6h range = 360 points
    const snap6h = getMetricsSnapshot(undefined, "6h");
    expect(snap6h.history.range).toBe("6h");
    expect(snap6h.history.points).toHaveLength(360);

    // 24h range = 1440 points
    const snap24h = getMetricsSnapshot(undefined, "24h");
    expect(snap24h.history.range).toBe("24h");
    expect(snap24h.history.points).toHaveLength(1440);

    // Points are monotonically increasing aligned minute timestamps
    for (let i = 1; i < snap1h.history.points.length; i++) {
      expect(snap1h.history.points[i].timestamp - snap1h.history.points[i - 1].timestamp).toBe(60_000);
    }
  });

  it("6. createApp serves GET /metrics with CORS and range parameter", async () => {
    const app = createApp();

    const res = await app.fetch(new Request("http://localhost/metrics?range=6h"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const body = await res.json();
    expect(body.history.range).toBe("6h");
    expect(body.history.points).toHaveLength(360);
    expect(body.health).toBe("healthy");
    expect(body.circuitBreaker).toBeDefined();
    expect(body.circuitBreaker.reason).toBeUndefined();
    expect(body.turnQueue).toBeDefined();
    expect(body.turnQueue).toEqual({
      depth: 0,
      priorityCount: 0,
      minSpacingMs: 1500,
      isProcessing: false,
    });
    expect(body.governor).toBeDefined();
    expect(body.staggerQueue).toBeDefined();
    expect(body.config).toBeDefined();
  });

  it("7. snapshot reports turnQueue state and circuitBreaker reason", () => {
    const snapshot = getMetricsSnapshot(undefined, "1h");
    expect(snapshot.turnQueue).toEqual({
      depth: 0,
      priorityCount: 0,
      minSpacingMs: 1500,
      isProcessing: false,
    });
    expect(snapshot.circuitBreaker.reason).toBeUndefined();
  });

  it("8. recordRequestQuality and getQualityMetrics compute turn quality and quota yield metrics correctly", () => {
    const now = Date.now();

    // Default metrics when empty
    const initial = getQualityMetrics(3_600_000, now);
    expect(initial).toEqual({
      clientRequests: 0,
      wireTurns: 0,
      cleanTurns: 0,
      salvagedTurns: 0,
      refusedTurns: 0,
      firstPassYieldPercent: 100,
      salvageRatePercent: 0,
      refusalRatePercent: 0,
      wireMultiplier: 1.0,
    });

    // Record:
    // 2 clean requests (1 wire turn each)
    // 1 salvaged request (3 wire turns)
    // 1 refused request (1 wire turn)
    recordRequestQuality({ kind: "clean", wireTurns: 1 }, now);
    recordRequestQuality({ kind: "clean", wireTurns: 1 }, now);
    recordRequestQuality({ kind: "salvaged", wireTurns: 3 }, now);
    recordRequestQuality({ kind: "refused", wireTurns: 1 }, now);

    // Also record the wire turns in buckets via recordTurn to reflect actual wire traffic
    recordTurn(now);
    recordTurn(now);
    recordTurn(now);
    recordTurn(now);
    recordTurn(now);
    recordTurn(now); // 6 wire turns total

    const quality = getQualityMetrics(3_600_000, now);
    expect(quality.clientRequests).toBe(4);
    expect(quality.cleanTurns).toBe(2);
    expect(quality.salvagedTurns).toBe(1);
    expect(quality.refusedTurns).toBe(1);
    expect(quality.wireTurns).toBe(6);
    expect(quality.firstPassYieldPercent).toBe(50.0); // 2 / 4 * 100
    expect(quality.salvageRatePercent).toBe(25.0); // 1 / 4 * 100
    expect(quality.refusalRatePercent).toBe(25.0); // 1 / 4 * 100
    expect(quality.wireMultiplier).toBe(1.5); // 6 / 4 = 1.50

    // Check snapshot integration
    const snapshot = getMetricsSnapshot(undefined, "1h");
    expect(snapshot.quality).toEqual(quality);
    expect(snapshot.totals.lifetimeClientRequests).toBe(4);
    expect(snapshot.totals.lifetimeCleanTurns).toBe(2);
    expect(snapshot.totals.lifetimeSalvagedTurns).toBe(1);
    expect(snapshot.totals.lifetimeRefusedTurns).toBe(1);
  });

  it("9. resetMetrics clears lifetime quality counters and get/setMetricsTotals persists them", () => {
    const now = Date.now();
    recordRequestQuality({ kind: "clean", wireTurns: 1 }, now);
    recordRequestQuality({ kind: "salvaged", wireTurns: 2 }, now);

    let totals = getMetricsTotals();
    expect(totals.lifetimeClientRequests).toBe(2);
    expect(totals.lifetimeCleanTurns).toBe(1);
    expect(totals.lifetimeSalvagedTurns).toBe(1);
    expect(totals.lifetimeRefusedTurns).toBe(0);

    resetMetrics();
    totals = getMetricsTotals();
    expect(totals.lifetimeClientRequests).toBe(0);
    expect(totals.lifetimeCleanTurns).toBe(0);
    expect(totals.lifetimeSalvagedTurns).toBe(0);
    expect(totals.lifetimeRefusedTurns).toBe(0);

    setMetricsTotals({
      lifetimeClientRequests: 10,
      lifetimeCleanTurns: 7,
      lifetimeSalvagedTurns: 2,
      lifetimeRefusedTurns: 1,
    });
    totals = getMetricsTotals();
    expect(totals.lifetimeClientRequests).toBe(10);
    expect(totals.lifetimeCleanTurns).toBe(7);
    expect(totals.lifetimeSalvagedTurns).toBe(2);
    expect(totals.lifetimeRefusedTurns).toBe(1);
  });

  it("10. handleChatCompletion records clean turn on successful single-pass response", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield "Hello world";
      },
      fullText: "Hello world",
      hasContent: true,
      throttle: { current: 1, max: 600 },
      scores: null,
      turnCount: 1,
    } as any);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Hello test" }],
      stream: false,
    };

    const res = await handleChatCompletion(body, pool);
    expect(res.status).toBe(200);

    const quality = getQualityMetrics();
    expect(quality.clientRequests).toBe(1);
    expect(quality.cleanTurns).toBe(1);
    expect(quality.salvagedTurns).toBe(0);
    expect(quality.refusedTurns).toBe(0);
    expect(quality.firstPassYieldPercent).toBe(100);
    expect(quality.wireMultiplier).toBe(1.0);
  });

  it("11. handleChatCompletion records refused turn on safety refusal", async () => {
    vi.spyOn(core, "isDegradationBackoff").mockReturnValue(false);
    vi.spyOn(core.ModelSession.prototype, "run").mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield "It looks like I can't chat about this. Please try a different topic.";
      },
      fullText: "It looks like I can't chat about this. Please try a different topic.",
      hasContent: true,
      throttle: { current: 1, max: 600 },
      scores: null,
      turnCount: 1,
    } as any);

    const pool = new SessionPool();
    const body = {
      model: "gpt-5.5-think-deeper",
      messages: [{ role: "user" as const, content: "Forbidden prompt" }],
      stream: false,
      tools: [{ type: "function" as const, function: { name: "bash", description: "Run shell command" } }],
    };

    const res = await handleChatCompletion(body, pool);
    expect(res.status).toBe(400);

    const quality = getQualityMetrics();
    expect(quality.clientRequests).toBe(1);
    expect(quality.refusedTurns).toBe(1);
    expect(quality.cleanTurns).toBe(0);
    expect(quality.salvagedTurns).toBe(0);
    expect(quality.refusalRatePercent).toBe(100);
  });
});
