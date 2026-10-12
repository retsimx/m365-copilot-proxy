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
  turnDelayTotalMs?: number;
  turnDelayedCount?: number;
  turnDelaySamplesMs?: number[];
  turnDelayCauses?: Record<string, number>;
  sessionDelayTotalMs?: number;
  sessionDelayedCount?: number;
  sessionDelaySamplesMs?: number[];
  clientRequests?: number;
  retryAttempts?: number;
  transportReconnects?: number;
  disengagedRecoveries?: number;
  throttleReasons?: Record<string, number>;
  rolling10mTurns?: number;
  rolling60mTurns?: number;
  rolling10mSessions?: number;
  rolling60mSessions?: number;
  averageTurnDelayMs?: number;
  averageSessionDelayMs?: number;
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

export interface RequestConsumptionMetrics {
  clientRequests: number;
  upstreamAttempts: number;
  retryAttempts: number;
  transportReconnects: number;
  disengagedRecoveries: number;
}

export interface DispatchDelayMetrics {
  delayedTurns: number;
  totalDelayMs: number;
  averageDelayMs: number;
  p50DelayMs: number;
  p95DelayMs: number;
  maxDelayMs: number;
  byCause: Record<string, number>;
  delayedSessions: number;
  sessionDelayMs: number;
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
  requestedModel?: string;
  resolvedTone?: string;
  agentAttached?: boolean;
  upstreamAttempts?: number;
  retryAttempts?: number;
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
  const sustainedMaxTurns = Number(process.env.M365_SUSTAINED_MAX_TURNS ?? 115);
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
    lastThrottleAt?: number;
    shieldedRequests: number;
  };
  turnQueue: {
    depth: number;
    priorityCount: number;
    minSpacingMs: number;
    isProcessing: boolean;
    oldestWaitMs: number;
    nextDispatchMs: number;
    delayCause: string;
  };
  staggerQueue: {
    delayMs: number;
    sessionTokens: number;
    tokenCapacity: number;
    minSpacingMs: number;
    nextRefillMs: number;
    nextEligibleMs: number;
  };
  governor: {
    tenMinute: {
      turns: number;
      maxTurns: number;
      softTurns: number;
      freshSessions: number;
      dangerSessions: number;
      currentDelayMs: number;
      recoveryMs: number;
      status: "safe" | "guarded" | "danger";
    };
    sixtyMinute: {
      turns: number;
      maxTurns: number;
      warnTurns: number;
      freshSessions: number;
      dangerSessions: number;
      currentDelayMs: number;
      recoveryMs: number;
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
  consumption: RequestConsumptionMetrics;
  dispatchDelay: DispatchDelayMetrics;
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
        turnDelayTotalMs: 0,
        turnDelayedCount: 0,
        turnDelaySamplesMs: [],
        turnDelayCauses: {},
        sessionDelayTotalMs: 0,
        sessionDelayedCount: 0,
        sessionDelaySamplesMs: [],
        clientRequests: 0,
        retryAttempts: 0,
        transportReconnects: 0,
        disengagedRecoveries: 0,
        throttleReasons: {},
        cleanTurns: 0,
        salvagedTurns: 0,
        refusedTurns: 0,
      };
      this.buckets.set(minuteKey, bucket);
    }
    return bucket;
  }

  recordTurn(timestamp = Date.now(), delayMs = 0, delayCause = "none"): void {
    this.lifetimeTurns += 1;
    const key = this.alignToMinute(timestamp);
    const bucket = this.getOrCreateBucket(key);
    bucket.turns += 1;
    if (delayMs > bucket.maxPacingDelayMs) {
      bucket.maxPacingDelayMs = delayMs;
    }
    if (delayMs > 0) {
      bucket.turnDelayTotalMs = (bucket.turnDelayTotalMs ?? 0) + delayMs;
      bucket.turnDelayedCount = (bucket.turnDelayedCount ?? 0) + 1;
      (bucket.turnDelaySamplesMs ??= []).push(delayMs);
      const causes = (bucket.turnDelayCauses ??= {});
      causes[delayCause] = (causes[delayCause] ?? 0) + 1;
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
    if (delayMs > 0) {
      bucket.sessionDelayTotalMs = (bucket.sessionDelayTotalMs ?? 0) + delayMs;
      bucket.sessionDelayedCount = (bucket.sessionDelayedCount ?? 0) + 1;
      (bucket.sessionDelaySamplesMs ??= []).push(delayMs);
    }
    this.prune(timestamp);
  }

  recordThrottle(timestamp = Date.now(), reason = "Throttled"): void {
    this.lifetimeThrottles += 1;
    const key = this.alignToMinute(timestamp);
    const bucket = this.getOrCreateBucket(key);
    bucket.throttles += 1;
    const reasons = (bucket.throttleReasons ??= {});
    reasons[reason] = (reasons[reason] ?? 0) + 1;
    this.prune(timestamp);
  }

  recordRequestConsumption(
    outcome: { wireTurns: number; retryAttempts?: number; transportReconnects?: number; disengagedRecoveries?: number },
    timestamp = Date.now(),
  ): void {
    const bucket = this.getOrCreateBucket(this.alignToMinute(timestamp));
    bucket.clientRequests = (bucket.clientRequests ?? 0) + 1;
    bucket.retryAttempts = (bucket.retryAttempts ?? 0) + (outcome.retryAttempts ?? 0);
    bucket.transportReconnects = (bucket.transportReconnects ?? 0) + (outcome.transportReconnects ?? 0);
    bucket.disengagedRecoveries = (bucket.disengagedRecoveries ?? 0) + (outcome.disengagedRecoveries ?? 0);
  }

  getRequestConsumption(windowMs = 3_600_000, now = Date.now()): RequestConsumptionMetrics {
    this.prune(now);
    const cutoff = now - windowMs;
    let clientRequests = 0;
    let retryAttempts = 0;
    let transportReconnects = 0;
    let disengagedRecoveries = 0;
    let upstreamAttempts = 0;
    for (const bucket of this.buckets.values()) {
      if (bucket.timestamp < cutoff) continue;
      clientRequests += bucket.clientRequests ?? 0;
      retryAttempts += bucket.retryAttempts ?? 0;
      transportReconnects += bucket.transportReconnects ?? 0;
      disengagedRecoveries += bucket.disengagedRecoveries ?? 0;
      upstreamAttempts += bucket.turns;
    }
    return { clientRequests, upstreamAttempts, retryAttempts, transportReconnects, disengagedRecoveries };
  }

  getDispatchDelayMetrics(windowMs = 3_600_000, now = Date.now()): DispatchDelayMetrics {
    this.prune(now);
    const cutoff = now - windowMs;
    const samples: number[] = [];
    const byCause: Record<string, number> = {};
    let delayedTurns = 0;
    let totalDelayMs = 0;
    let delayedSessions = 0;
    let sessionDelayMs = 0;
    for (const bucket of this.buckets.values()) {
      if (bucket.timestamp < cutoff) continue;
      delayedTurns += bucket.turnDelayedCount ?? 0;
      totalDelayMs += bucket.turnDelayTotalMs ?? 0;
      samples.push(...(bucket.turnDelaySamplesMs ?? []));
      delayedSessions += bucket.sessionDelayedCount ?? 0;
      sessionDelayMs += bucket.sessionDelayTotalMs ?? 0;
      for (const [cause, count] of Object.entries(bucket.turnDelayCauses ?? {})) {
        byCause[cause] = (byCause[cause] ?? 0) + count;
      }
    }
    samples.sort((a, b) => a - b);
    const percentile = (p: number) => samples.length ? samples[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)] : 0;
    return {
      delayedTurns,
      totalDelayMs,
      averageDelayMs: delayedTurns ? Math.round(totalDelayMs / delayedTurns) : 0,
      p50DelayMs: percentile(0.5),
      p95DelayMs: percentile(0.95),
      maxDelayMs: samples.at(-1) ?? 0,
      byCause,
      delayedSessions,
      sessionDelayMs,
    };
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
      let rolling10mTurns = 0;
      let rolling60mTurns = 0;
      let rolling10mSessions = 0;
      let rolling60mSessions = 0;
      for (let h = t - 59 * 60_000; h <= t; h += 60_000) {
        const hb = this.buckets.get(h);
        if (!hb) continue;
        rolling60mTurns += hb.turns;
        rolling60mSessions += hb.newSessions;
        if (h >= t - 9 * 60_000) {
          rolling10mTurns += hb.turns;
          rolling10mSessions += hb.newSessions;
        }
      }
      const turnDelayedCount = b?.turnDelayedCount ?? 0;
      const sessionDelayedCount = b?.sessionDelayedCount ?? 0;
      points.push({
        timestamp: t,
        turns: b?.turns ?? 0,
        newSessions: b?.newSessions ?? 0,
        throttles: b?.throttles ?? 0,
        maxPacingDelayMs: b?.maxPacingDelayMs ?? 0,
        turnDelayTotalMs: b?.turnDelayTotalMs ?? 0,
        turnDelayedCount,
        turnDelaySamplesMs: b?.turnDelaySamplesMs ?? [],
        turnDelayCauses: b?.turnDelayCauses ?? {},
        sessionDelayTotalMs: b?.sessionDelayTotalMs ?? 0,
        sessionDelayedCount,
        sessionDelaySamplesMs: b?.sessionDelaySamplesMs ?? [],
        clientRequests: b?.clientRequests ?? 0,
        retryAttempts: b?.retryAttempts ?? 0,
        transportReconnects: b?.transportReconnects ?? 0,
        disengagedRecoveries: b?.disengagedRecoveries ?? 0,
        throttleReasons: b?.throttleReasons ?? {},
        rolling10mTurns,
        rolling60mTurns,
        rolling10mSessions,
        rolling60mSessions,
        averageTurnDelayMs: turnDelayedCount ? Math.round((b?.turnDelayTotalMs ?? 0) / turnDelayedCount) : 0,
        averageSessionDelayMs: sessionDelayedCount ? Math.round((b?.sessionDelayTotalMs ?? 0) / sessionDelayedCount) : 0,
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

  getLastThrottleAt(): number | undefined {
    let latest: number | undefined;
    for (const bucket of this.buckets.values()) {
      if (bucket.throttles > 0 && (latest === undefined || bucket.timestamp > latest)) latest = bucket.timestamp;
    }
    return latest;
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

export function recordTurn(timestamp?: number, delayMs?: number, delayCause?: string): void {
  defaultMetricsCollector.recordTurn(timestamp, delayMs, delayCause);
  scheduleStateSave();
}

export function recordNewSession(timestamp?: number, delayMs?: number): void {
  defaultMetricsCollector.recordNewSession(timestamp, delayMs);
  scheduleStateSave();
}

export function recordThrottle(timestamp?: number, reason?: string): void {
  defaultMetricsCollector.recordThrottle(timestamp, reason);
  scheduleStateSave();
}

export function recordRequestQuality(
  outcome: { kind: "clean" | "salvaged" | "refused"; wireTurns: number },
  timestamp = Date.now(),
): void {
  defaultMetricsCollector.recordRequestQuality(outcome, timestamp);
  scheduleStateSave();
}

export function recordRequestConsumption(
  outcome: { wireTurns: number; retryAttempts?: number; transportReconnects?: number; disengagedRecoveries?: number },
  timestamp = Date.now(),
): void {
  defaultMetricsCollector.recordRequestConsumption(outcome, timestamp);
  scheduleStateSave();
}

export function getRequestConsumption(windowMs = 3_600_000, now = Date.now()): RequestConsumptionMetrics {
  return defaultMetricsCollector.getRequestConsumption(windowMs, now);
}

export function getDispatchDelayMetrics(windowMs = 3_600_000, now = Date.now()): DispatchDelayMetrics {
  return defaultMetricsCollector.getDispatchDelayMetrics(windowMs, now);
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
      lastThrottleAt: defaultMetricsCollector.getLastThrottleAt(),
      shieldedRequests: 0,
    },
    turnQueue: getTurnQueueState(),
    staggerQueue,
    governor,
    activeSessions,
    history,
    totals,
    quality: defaultMetricsCollector.getQualityMetrics(3_600_000, serverTime),
    consumption: defaultMetricsCollector.getRequestConsumption(3_600_000, serverTime),
    dispatchDelay: defaultMetricsCollector.getDispatchDelayMetrics(3_600_000, serverTime),
    config,
  };
}
