import {
  isDegradationBackoff,
  getRemainingDegradationCooldownMs,
  getDegradationBackoffReason,
} from "@m365-copilot/core";
import {
  getStaggerQueueState,
  getGovernorState,
  getTurnQueueState,
  type SessionPool,
} from "./handler.js";
import { scheduleStateSave } from "./persistence.js";

export interface TimeBucketPoint {
  timestamp: number; // epoch ms (aligned to minute)
  turns: number;
  newSessions: number;
  throttles: number;
  maxPacingDelayMs: number;
  cleanTurns?: number;
  salvagedTurns?: number;
  refusedTurns?: number;
}

export interface TurnQualityMetrics {
  clientRequests: number;
  wireTurns: number;
  cleanTurns: number;
  salvagedTurns: number;
  refusedTurns: number;
  firstPassYieldPercent: number;
  salvageRatePercent: number;
  refusalRatePercent: number;
  wireMultiplier: number;
}

export interface SessionItemSnapshot {
  fingerprint: string;
  sessionId: string;
  conversationId: string;
  turnCount: number;
  maxTurns: number; // dynamically sourced
  lastAccessedAt: number;
  idleSeconds: number;
  status: "streaming" | "governor" | "stagger" | "idle";
}

export interface SystemMetricsConfig {
  burstWindowMs: number;
  burstMaxTurns: number;
  burstSoftTurns: number;
  sustainedWindowMs: number;
  sustainedMaxTurns: number;
  sustainedWarnTurns: number;
  sessionDanger10m: number;
  sessionWarn10m: number;
  sessionDanger60m: number;
  sessionWarn60m: number;
  sessionDangerThreshold10m: number;
  sessionWarnThreshold10m: number;
  sessionDangerThreshold60m: number;
  sessionWarnThreshold60m: number;
  maxNumUserMessagesInConversation: number;
  sessionBucketCapacity: number;
  sessionRefillMs: number;
  minSpacingMs: number;
  newSessionSpacingMs: number;
  throttleCooldownSec: number;
  userThrottleCooldownSec: number;
  maxRetryAfterSec: number;
}

export function getSystemMetricsConfig(): SystemMetricsConfig {
  const burstMaxTurns = Number(process.env.M365_BURST_MAX_TURNS ?? 35);
  const burstSoftTurns = Number(process.env.M365_BURST_SOFT_TURNS ?? Math.max(1, burstMaxTurns - 5));
  const sustainedMaxTurns = Number(process.env.M365_SUSTAINED_MAX_TURNS ?? 120);
  const sustainedWarnTurns = Number(process.env.M365_SUSTAINED_WARN_TURNS ?? 90);
  const sessionDanger10m = Number(process.env.M365_10M_DANGER_SESSIONS ?? 15);
  const sessionWarn10m = Number(process.env.M365_10M_WARN_SESSIONS ?? 10);
  const sessionDanger60m = Number(process.env.M365_60M_DANGER_SESSIONS ?? 50);
  const sessionWarn60m = Number(process.env.M365_60M_WARN_SESSIONS ?? 35);
  const minSpacingMs = Number(process.env.M365_NEW_SESSION_SPACING_MS ?? 15_000);

  return {
    burstWindowMs: Number(process.env.M365_BURST_WINDOW_MS ?? 600_000),
    burstMaxTurns,
    burstSoftTurns,
    sustainedWindowMs: Number(process.env.M365_SUSTAINED_WINDOW_MS ?? 3_600_000),
    sustainedMaxTurns,
    sustainedWarnTurns,
    sessionDanger10m,
    sessionWarn10m,
    sessionDanger60m,
    sessionWarn60m,
    sessionDangerThreshold10m: sessionDanger10m,
    sessionWarnThreshold10m: sessionWarn10m,
    sessionDangerThreshold60m: sessionDanger60m,
    sessionWarnThreshold60m: sessionWarn60m,
    maxNumUserMessagesInConversation: Number(process.env.M365_MAX_TURNS_PER_CONVERSATION ?? 600),
    sessionBucketCapacity: Number(process.env.M365_SESSION_BUCKET_CAPACITY ?? 10),
    sessionRefillMs: Number(process.env.M365_SESSION_REFILL_MS ?? 150_000),
    minSpacingMs,
    newSessionSpacingMs: minSpacingMs,
    throttleCooldownSec: Number(process.env.M365_THROTTLE_COOLDOWN_SEC ?? 1800),
    userThrottleCooldownSec: Number(process.env.M365_USER_THROTTLE_COOLDOWN_SEC ?? 1200),
    maxRetryAfterSec: Number(process.env.M365_MAX_RETRY_AFTER_SEC ?? 60),
  };
}

export interface MetricsSnapshot {
  serverTime: number;
  health: "healthy" | "warning" | "danger" | "throttled";
  circuitBreaker: {
    isArmed: boolean;
    remainingCooldownSec: number;
    throttleCount: number;
    reason?: string;
  };
  turnQueue: {
    depth: number;
    priorityCount: number;
    minSpacingMs: number;
    isProcessing: boolean;
  };
  staggerQueue: {
    delayMs: number;
    sessionTokens: number;
    tokenCapacity: number;
    minSpacingMs: number;
  };
  governor: {
    tenMinute: {
      turns: number;
      maxTurns: number;
      softTurns: number;
      freshSessions: number;
      dangerSessions: number;
      currentDelayMs: number;
      status: "safe" | "guarded" | "danger";
    };
    sixtyMinute: {
      turns: number;
      maxTurns: number;
      warnTurns: number;
      freshSessions: number;
      dangerSessions: number;
      currentDelayMs: number;
      status: "safe" | "guarded" | "danger";
    };
  };
  activeSessions: SessionItemSnapshot[];
  history: {
    range: "1h" | "6h" | "24h";
    points: TimeBucketPoint[];
  };
  totals: {
    lifetimeTurns: number;
    lifetimeSessions: number;
    lifetimeThrottles: number;
    lifetimeClientRequests: number;
    lifetimeCleanTurns: number;
    lifetimeSalvagedTurns: number;
    lifetimeRefusedTurns: number;
  };
  quality: TurnQualityMetrics;
  config: SystemMetricsConfig;
}

const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000; // 1440 minutes

export class MetricsCollector {
  private buckets = new Map<number, TimeBucketPoint>();
  private lifetimeTurns = 0;
  private lifetimeSessions = 0;
  private lifetimeThrottles = 0;
  private lifetimeClientRequests = 0;
  private lifetimeCleanTurns = 0;
  private lifetimeSalvagedTurns = 0;
  private lifetimeRefusedTurns = 0;

  private alignToMinute(ts: number): number {
    return Math.floor(ts / 60_000) * 60_000;
  }

  private prune(now = Date.now()): void {
    const cutoff = now - ROLLING_WINDOW_MS;
    for (const key of this.buckets.keys()) {
      if (key < cutoff) {
        this.buckets.delete(key);
      }
    }
  }

  private getOrCreateBucket(minuteKey: number): TimeBucketPoint {
    let bucket = this.buckets.get(minuteKey);
    if (!bucket) {
      bucket = {
        timestamp: minuteKey,
        turns: 0,
        newSessions: 0,
        throttles: 0,
        maxPacingDelayMs: 0,
        cleanTurns: 0,
        salvagedTurns: 0,
        refusedTurns: 0,
      };
      this.buckets.set(minuteKey, bucket);
    }
    return bucket;
  }

  recordTurn(timestamp = Date.now(), delayMs = 0): void {
    this.lifetimeTurns += 1;
    const key = this.alignToMinute(timestamp);
    const bucket = this.getOrCreateBucket(key);
    bucket.turns += 1;
    if (delayMs > bucket.maxPacingDelayMs) {
      bucket.maxPacingDelayMs = delayMs;
    }
    this.prune(timestamp);
  }

  recordNewSession(timestamp = Date.now(), delayMs = 0): void {
    this.lifetimeSessions += 1;
    const key = this.alignToMinute(timestamp);
    const bucket = this.getOrCreateBucket(key);
    bucket.newSessions += 1;
    if (delayMs > bucket.maxPacingDelayMs) {
      bucket.maxPacingDelayMs = delayMs;
    }
    this.prune(timestamp);
  }

  recordThrottle(timestamp = Date.now()): void {
    this.lifetimeThrottles += 1;
    const key = this.alignToMinute(timestamp);
    const bucket = this.getOrCreateBucket(key);
    bucket.throttles += 1;
    this.prune(timestamp);
  }

  recordRequestQuality(outcome: { kind: "clean" | "salvaged" | "refused"; wireTurns: number }, timestamp = Date.now()): void {
    const bucket = this.getOrCreateBucket(this.alignToMinute(timestamp));
    this.lifetimeClientRequests++;
    if (outcome.kind === "clean") {
      bucket.cleanTurns = (bucket.cleanTurns ?? 0) + 1;
      this.lifetimeCleanTurns++;
    } else if (outcome.kind === "salvaged") {
      bucket.salvagedTurns = (bucket.salvagedTurns ?? 0) + 1;
      this.lifetimeSalvagedTurns++;
    } else if (outcome.kind === "refused") {
      bucket.refusedTurns = (bucket.refusedTurns ?? 0) + 1;
      this.lifetimeRefusedTurns++;
    }
  }

  getQualityMetrics(windowMs = 3_600_000, now = Date.now()): TurnQualityMetrics {
    this.prune(now);
    const cutoff = now - windowMs;
    let cleanTurns = 0;
    let salvagedTurns = 0;
    let refusedTurns = 0;
    let wireTurns = 0;
    for (const bucket of this.buckets.values()) {
      if (bucket.timestamp >= cutoff) {
        cleanTurns += bucket.cleanTurns ?? 0;
        salvagedTurns += bucket.salvagedTurns ?? 0;
        refusedTurns += bucket.refusedTurns ?? 0;
        wireTurns += bucket.turns ?? 0;
      }
    }
    const clientRequests = cleanTurns + salvagedTurns + refusedTurns;
    const firstPassYieldPercent = clientRequests > 0 ? Number(((cleanTurns / clientRequests) * 100).toFixed(1)) : 100;
    const salvageRatePercent = clientRequests > 0 ? Number(((salvagedTurns / clientRequests) * 100).toFixed(1)) : 0;
    const refusalRatePercent = clientRequests > 0 ? Number(((refusedTurns / clientRequests) * 100).toFixed(1)) : 0;
    const wireMultiplier = clientRequests > 0 ? Number((Math.max(clientRequests, wireTurns) / clientRequests).toFixed(2)) : 1.0;

    return {
      clientRequests,
      wireTurns,
      cleanTurns,
      salvagedTurns,
      refusedTurns,
      firstPassYieldPercent,
      salvageRatePercent,
      refusalRatePercent,
      wireMultiplier,
    };
  }

  getNewSessionsInWindow(windowMs: number, now = Date.now()): number {
    this.prune(now);
    const cutoff = now - windowMs;
    let count = 0;
    for (const bucket of this.buckets.values()) {
      if (bucket.timestamp >= cutoff) {
        count += bucket.newSessions;
      }
    }
    return count;
  }

  getTurnsInWindow(windowMs: number, now = Date.now()): number {
    this.prune(now);
    const cutoff = now - windowMs;
    let count = 0;
    for (const bucket of this.buckets.values()) {
      if (bucket.timestamp >= cutoff) {
        count += bucket.turns;
      }
    }
    return count;
  }

  getThrottlesInWindow(windowMs: number, now = Date.now()): number {
    this.prune(now);
    const cutoff = now - windowMs;
    let count = 0;
    for (const bucket of this.buckets.values()) {
      if (bucket.timestamp >= cutoff) {
        count += bucket.throttles;
      }
    }
    return count;
  }

  getHistoryPoints(range: "1h" | "6h" | "24h" = "1h", now = Date.now()): TimeBucketPoint[] {
    this.prune(now);
    const durationMs =
      range === "24h"
        ? 24 * 60 * 60 * 1000
        : range === "6h"
          ? 6 * 60 * 60 * 1000
          : 60 * 60 * 1000;
    const minutes = Math.round(durationMs / 60_000);
    const currentMinute = this.alignToMinute(now);
    const startMinute = currentMinute - (minutes - 1) * 60_000;

    const points: TimeBucketPoint[] = [];
    for (let t = startMinute; t <= currentMinute; t += 60_000) {
      const b = this.buckets.get(t);
      points.push({
        timestamp: t,
        turns: b?.turns ?? 0,
        newSessions: b?.newSessions ?? 0,
        throttles: b?.throttles ?? 0,
        maxPacingDelayMs: b?.maxPacingDelayMs ?? 0,
        cleanTurns: b?.cleanTurns ?? 0,
        salvagedTurns: b?.salvagedTurns ?? 0,
        refusedTurns: b?.refusedTurns ?? 0,
      });
    }
    return points;
  }

  getLifetimeTurns(): number {
    return this.lifetimeTurns;
  }

  getLifetimeSessions(): number {
    return this.lifetimeSessions;
  }

  getLifetimeThrottles(): number {
    return this.lifetimeThrottles;
  }

  getLifetimeClientRequests(): number {
    return this.lifetimeClientRequests;
  }

  getLifetimeCleanTurns(): number {
    return this.lifetimeCleanTurns;
  }

  getLifetimeSalvagedTurns(): number {
    return this.lifetimeSalvagedTurns;
  }

  getLifetimeRefusedTurns(): number {
    return this.lifetimeRefusedTurns;
  }

  getBuckets(): TimeBucketPoint[] {
    return Array.from(this.buckets.values());
  }

  setBuckets(points: TimeBucketPoint[], now = Date.now()): void {
    this.buckets.clear();
    const cutoff = now - ROLLING_WINDOW_MS;
    for (const point of points) {
      if (point.timestamp >= cutoff) {
        this.buckets.set(point.timestamp, { ...point });
      }
    }
  }

  getTotals(): {
    lifetimeTurns: number;
    lifetimeSessions: number;
    lifetimeThrottles: number;
    lifetimeClientRequests: number;
    lifetimeCleanTurns: number;
    lifetimeSalvagedTurns: number;
    lifetimeRefusedTurns: number;
  } {
    return {
      lifetimeTurns: this.lifetimeTurns,
      lifetimeSessions: this.lifetimeSessions,
      lifetimeThrottles: this.lifetimeThrottles,
      lifetimeClientRequests: this.lifetimeClientRequests,
      lifetimeCleanTurns: this.lifetimeCleanTurns,
      lifetimeSalvagedTurns: this.lifetimeSalvagedTurns,
      lifetimeRefusedTurns: this.lifetimeRefusedTurns,
    };
  }

  setTotals(totals: {
    lifetimeTurns?: number;
    lifetimeSessions?: number;
    lifetimeThrottles?: number;
    lifetimeClientRequests?: number;
    lifetimeCleanTurns?: number;
    lifetimeSalvagedTurns?: number;
    lifetimeRefusedTurns?: number;
  }): void {
    if (typeof totals.lifetimeTurns === "number") this.lifetimeTurns = totals.lifetimeTurns;
    if (typeof totals.lifetimeSessions === "number") this.lifetimeSessions = totals.lifetimeSessions;
    if (typeof totals.lifetimeThrottles === "number") this.lifetimeThrottles = totals.lifetimeThrottles;
    if (typeof totals.lifetimeClientRequests === "number") this.lifetimeClientRequests = totals.lifetimeClientRequests;
    if (typeof totals.lifetimeCleanTurns === "number") this.lifetimeCleanTurns = totals.lifetimeCleanTurns;
    if (typeof totals.lifetimeSalvagedTurns === "number") this.lifetimeSalvagedTurns = totals.lifetimeSalvagedTurns;
    if (typeof totals.lifetimeRefusedTurns === "number") this.lifetimeRefusedTurns = totals.lifetimeRefusedTurns;
  }

  reset(): void {
    this.buckets.clear();
    this.lifetimeTurns = 0;
    this.lifetimeSessions = 0;
    this.lifetimeThrottles = 0;
    this.lifetimeClientRequests = 0;
    this.lifetimeCleanTurns = 0;
    this.lifetimeSalvagedTurns = 0;
    this.lifetimeRefusedTurns = 0;
  }
}

export const defaultMetricsCollector = new MetricsCollector();

export function recordTurn(timestamp?: number, delayMs?: number): void {
  defaultMetricsCollector.recordTurn(timestamp, delayMs);
  scheduleStateSave();
}

export function recordNewSession(timestamp?: number, delayMs?: number): void {
  defaultMetricsCollector.recordNewSession(timestamp, delayMs);
  scheduleStateSave();
}

export function recordThrottle(timestamp?: number): void {
  defaultMetricsCollector.recordThrottle(timestamp);
  scheduleStateSave();
}

export function recordRequestQuality(
  outcome: { kind: "clean" | "salvaged" | "refused"; wireTurns: number },
  timestamp = Date.now(),
): void {
  defaultMetricsCollector.recordRequestQuality(outcome, timestamp);
  scheduleStateSave();
}

export function getQualityMetrics(windowMs = 3_600_000, now = Date.now()): TurnQualityMetrics {
  return defaultMetricsCollector.getQualityMetrics(windowMs, now);
}

export function resetMetrics(): void {
  defaultMetricsCollector.reset();
}

export function getMetricsBuckets(): TimeBucketPoint[] {
  return defaultMetricsCollector.getBuckets();
}

export function setMetricsBuckets(points: TimeBucketPoint[], now?: number): void {
  defaultMetricsCollector.setBuckets(points, now);
}

export function getMetricsTotals(): {
  lifetimeTurns: number;
  lifetimeSessions: number;
  lifetimeThrottles: number;
  lifetimeClientRequests: number;
  lifetimeCleanTurns: number;
  lifetimeSalvagedTurns: number;
  lifetimeRefusedTurns: number;
} {
  return defaultMetricsCollector.getTotals();
}

export function setMetricsTotals(totals: {
  lifetimeTurns?: number;
  lifetimeSessions?: number;
  lifetimeThrottles?: number;
  lifetimeClientRequests?: number;
  lifetimeCleanTurns?: number;
  lifetimeSalvagedTurns?: number;
  lifetimeRefusedTurns?: number;
}): void {
  defaultMetricsCollector.setTotals(totals);
}

export function getNewSessionsInWindow(windowMs: number, now?: number): number {
  return defaultMetricsCollector.getNewSessionsInWindow(windowMs, now);
}

export function getTurnsInWindow(windowMs: number, now?: number): number {
  return defaultMetricsCollector.getTurnsInWindow(windowMs, now);
}

export function getMetricsSnapshot(
  pool?: SessionPool,
  range: "1h" | "6h" | "24h" = "1h",
): MetricsSnapshot {
  const serverTime = Date.now();
  const config = getSystemMetricsConfig();
  const isArmed = isDegradationBackoff();
  const remainingCooldownSec = isArmed
    ? Math.ceil(getRemainingDegradationCooldownMs() / 1000)
    : 0;
  const throttleCount = defaultMetricsCollector.getLifetimeThrottles();

  const staggerQueue = getStaggerQueueState();
  const governor = getGovernorState();

  let health: "healthy" | "warning" | "danger" | "throttled" = "healthy";
  if (isArmed) {
    health = "throttled";
  } else if (
    governor.tenMinute.status === "danger" ||
    governor.sixtyMinute.status === "danger"
  ) {
    health = "danger";
  } else if (
    governor.tenMinute.status === "guarded" ||
    governor.sixtyMinute.status === "guarded"
  ) {
    health = "warning";
  }

  const activeSessions = pool ? pool.getSessionsSnapshot() : [];
  const history = {
    range,
    points: defaultMetricsCollector.getHistoryPoints(range, serverTime),
  };

  const totals = {
    lifetimeTurns: defaultMetricsCollector.getLifetimeTurns(),
    lifetimeSessions: defaultMetricsCollector.getLifetimeSessions(),
    lifetimeThrottles: defaultMetricsCollector.getLifetimeThrottles(),
    lifetimeClientRequests: defaultMetricsCollector.getLifetimeClientRequests(),
    lifetimeCleanTurns: defaultMetricsCollector.getLifetimeCleanTurns(),
    lifetimeSalvagedTurns: defaultMetricsCollector.getLifetimeSalvagedTurns(),
    lifetimeRefusedTurns: defaultMetricsCollector.getLifetimeRefusedTurns(),
  };

  return {
    serverTime,
    health,
    circuitBreaker: {
      isArmed,
      remainingCooldownSec,
      throttleCount,
      reason: getDegradationBackoffReason(),
    },
    turnQueue: getTurnQueueState(),
    staggerQueue,
    governor,
    activeSessions,
    history,
    totals,
    quality: defaultMetricsCollector.getQualityMetrics(3_600_000, serverTime),
    config,
  };
}
