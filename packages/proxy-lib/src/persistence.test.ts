import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isDegradationBackoff,
  getRemainingDegradationCooldownMs,
  getDegradationLevel,
} from "@m365-copilot/core";
import {
  saveProxyState,
  loadProxyState,
  getProxyStatePath,
  scheduleStateSave,
  flushStateSave,
  cancelScheduledSave,
  type PersistentProxyState,
  resetMetrics,
  resetNewSessionPacing,
  resetTurnVelocityPacing,
  getRecentTurnTimestamps,
  setRecentTurnTimestamps,
  getStaggerQueueInternalState,
  setStaggerQueueInternalState,
  recordTurn,
  recordNewSession,
  recordThrottle,
  getMetricsTotals,
  getMetricsBuckets,
  getGovernorState,
} from "./index.js";

describe("JSON State Persistence (proxy-lib)", () => {
  let testDir: string;
  let testFile: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `m365-persist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    testFile = join(testDir, "proxy-state.json");

    resetMetrics();
    resetNewSessionPacing();
    resetTurnVelocityPacing();
    cancelScheduledSave();
  });

  afterEach(() => {
    cancelScheduledSave();
    resetMetrics();
    resetNewSessionPacing();
    resetTurnVelocityPacing();

    try {
      if (existsSync(testFile)) unlinkSync(testFile);
    } catch {
      // ignore cleanup errors
    }
  });

  it("1. getProxyStatePath correctly resolves paths and respects env overrides", () => {
    const custom = "/custom/path/proxy-state.json";
    expect(getProxyStatePath(custom)).toBe(custom);

    const prevFile = process.env.M365_STATE_FILE;
    const prevDir = process.env.M365_DATA_DIR;
    try {
      process.env.M365_STATE_FILE = "/env/state.json";
      expect(getProxyStatePath()).toBe("/env/state.json");

      delete process.env.M365_STATE_FILE;
      process.env.M365_DATA_DIR = "/env/data-dir";
      expect(getProxyStatePath()).toBe(join("/env/data-dir", "proxy-state.json"));
    } finally {
      if (prevFile !== undefined) process.env.M365_STATE_FILE = prevFile;
      else delete process.env.M365_STATE_FILE;

      if (prevDir !== undefined) process.env.M365_DATA_DIR = prevDir;
      else delete process.env.M365_DATA_DIR;
    }
  });

  it("2. saveProxyState atomically dumps governor, staggerQueue, circuitBreaker, and metrics", () => {
    const now = Date.now();
    setRecentTurnTimestamps([now - 5000, now - 2000]);
    setStaggerQueueInternalState({
      sessionTokens: 7,
      lastTokenRefillAt: now - 30_000,
      nextNewSessionAllowedAt: now + 10_000,
      recentSessionTimestamps: [now - 15_000],
    });

    recordTurn(now, 1200);
    recordNewSession(now, 2500);
    recordThrottle(now);

    saveProxyState(testFile);

    expect(existsSync(testFile)).toBe(true);
    const raw = readFileSync(testFile, "utf-8");
    const state = JSON.parse(raw) as PersistentProxyState;

    expect(state.version).toBe(1);
    expect(state.savedAt).toBeGreaterThanOrEqual(now);
    expect(state.governor.recentTurnTimestamps).toEqual([now - 5000, now - 2000]);
    expect(state.staggerQueue.sessionTokens).toBe(7);
    expect(state.staggerQueue.recentSessionTimestamps).toEqual([now - 15_000]);
    expect(state.staggerQueue.nextNewSessionAllowedAt).toBe(now + 10_000);
    expect(state.circuitBreaker.throttleCount).toBeGreaterThanOrEqual(1);
    expect(state.metrics.totals.lifetimeTurns).toBeGreaterThanOrEqual(1);
    expect(state.metrics.totals.lifetimeSessions).toBeGreaterThanOrEqual(1);
    expect(state.metrics.totals.lifetimeThrottles).toBeGreaterThanOrEqual(1);
    expect(state.metrics.buckets.length).toBeGreaterThan(0);
  });

  it("3. loadProxyState restores state, pruning turns older than 60m and buckets older than 24h", () => {
    const now = Date.now();
    const tRecentTurn = now - 5 * 60 * 1000; // 5 min ago (keep)
    const tOldTurn = now - 90 * 60 * 1000; // 90 min ago (prune > 60m)

    const tRecentSession = now - 10 * 60 * 1000; // 10 min ago (keep)
    const tOldSession = now - 120 * 60 * 1000; // 2h ago (prune > 60m)

    const tRecentBucket = Math.floor((now - 30 * 60 * 1000) / 60_000) * 60_000; // 30m ago (keep)
    const tOldBucket = Math.floor((now - 30 * 60 * 60 * 1000) / 60_000) * 60_000; // 30h ago (prune > 24h)

    const customState: PersistentProxyState = {
      version: 1,
      savedAt: now,
      governor: {
        recentTurnTimestamps: [tOldTurn, tRecentTurn],
      },
      staggerQueue: {
        sessionTokens: 4,
        lastTokenRefillAt: now - 40_000,
        nextNewSessionAllowedAt: now + 5000,
        recentSessionTimestamps: [tOldSession, tRecentSession],
      },
      circuitBreaker: {
        backoffUntil: 0,
        level: 0,
        throttleCount: 3,
      },
      metrics: {
        totals: {
          lifetimeTurns: 42,
          lifetimeSessions: 11,
          lifetimeThrottles: 3,
        },
        buckets: [
          {
            timestamp: tOldBucket,
            turns: 10,
            newSessions: 2,
            throttles: 1,
            maxPacingDelayMs: 0,
          },
          {
            timestamp: tRecentBucket,
            turns: 5,
            newSessions: 1,
            throttles: 0,
            maxPacingDelayMs: 1500,
          },
        ],
      },
    };

    writeFileSync(testFile, JSON.stringify(customState), "utf-8");

    const loaded = loadProxyState(testFile);
    expect(loaded).toBe(true);

    // Governor should have pruned turn older than 60m
    const turns = getRecentTurnTimestamps();
    expect(turns).toEqual([tRecentTurn]);

    // Stagger queue should have pruned session older than 60m
    const queue = getStaggerQueueInternalState();
    expect(queue.sessionTokens).toBe(4);
    expect(queue.nextNewSessionAllowedAt).toBe(now + 5000);
    expect(queue.recentSessionTimestamps).toEqual([tRecentSession]);

    // Metrics totals restored
    const totals = getMetricsTotals();
    expect(totals.lifetimeTurns).toBe(42);
    expect(totals.lifetimeSessions).toBe(11);
    expect(totals.lifetimeThrottles).toBe(3);

    // Metrics buckets should have pruned bucket older than 24h
    const buckets = getMetricsBuckets();
    expect(buckets.some(b => b.timestamp === tOldBucket)).toBe(false);
    const restoredBucket = buckets.find(b => b.timestamp === tRecentBucket);
    expect(restoredBucket).toBeDefined();
    expect(restoredBucket?.turns).toBe(5);
  });

  it("4. loadProxyState re-arms circuit breaker when backoffUntil is in the future", () => {
    const futureBackoff = Date.now() + 15_000;

    const stateWithThrottle: PersistentProxyState = {
      version: 1,
      savedAt: Date.now(),
      governor: { recentTurnTimestamps: [] },
      staggerQueue: {
        sessionTokens: 10,
        lastTokenRefillAt: Date.now(),
        nextNewSessionAllowedAt: 0,
        recentSessionTimestamps: [],
      },
      circuitBreaker: {
        backoffUntil: futureBackoff,
        level: 1,
        throttleCount: 5,
      },
      metrics: {
        totals: { lifetimeTurns: 0, lifetimeSessions: 0, lifetimeThrottles: 5 },
        buckets: [],
      },
    };

    writeFileSync(testFile, JSON.stringify(stateWithThrottle), "utf-8");

    const loaded = loadProxyState(testFile);
    expect(loaded).toBe(true);

    // Verify circuit breaker was re-armed
    expect(isDegradationBackoff()).toBe(true);
    expect(getRemainingDegradationCooldownMs()).toBeGreaterThan(0);
    expect(getDegradationLevel()).toBeGreaterThanOrEqual(1);
  });

  it("5. loadProxyState gracefully handles missing, corrupted, or incompatible files", () => {
    // Missing file returns false
    expect(loadProxyState(join(testDir, "does-not-exist.json"))).toBe(false);

    // Corrupt JSON returns false
    writeFileSync(testFile, "INVALID JSON", "utf-8");
    expect(loadProxyState(testFile)).toBe(false);

    // Version mismatch returns false
    writeFileSync(testFile, JSON.stringify({ version: 99 }), "utf-8");
    expect(loadProxyState(testFile)).toBe(false);
  });

  it("6. scheduleStateSave debounces writes and flushStateSave writes immediately", async () => {
    recordTurn();
    scheduleStateSave(testFile, 50);

    // Immediately after scheduling, file might not exist yet
    // Flush synchronously forces write
    flushStateSave(testFile);
    expect(existsSync(testFile)).toBe(true);

    const raw = readFileSync(testFile, "utf-8");
    const state = JSON.parse(raw) as PersistentProxyState;
    expect(state.metrics.totals.lifetimeTurns).toBeGreaterThanOrEqual(1);
  });
});
