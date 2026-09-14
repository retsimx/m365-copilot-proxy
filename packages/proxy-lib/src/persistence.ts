import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  isDegradationBackoff,
  getRemainingDegradationCooldownMs,
  getDegradationLevel,
  triggerDegradationBackoff,
} from "@m365-copilot/core";
import {
  getRecentTurnTimestamps,
  setRecentTurnTimestamps,
  getStaggerQueueInternalState,
  setStaggerQueueInternalState,
} from "./handler.js";
import {
  defaultMetricsCollector,
  type TimeBucketPoint,
} from "./metrics.js";

export interface PersistentProxyState {
  version: 1;
  savedAt: number;
  governor: {
    recentTurnTimestamps: number[];
  };
  staggerQueue: {
    sessionTokens: number;
    lastTokenRefillAt: number;
    nextNewSessionAllowedAt: number;
    recentSessionTimestamps: number[];
  };
  circuitBreaker: {
    backoffUntil: number;
    level: number;
    throttleCount: number;
  };
  metrics: {
    totals: {
      lifetimeTurns: number;
      lifetimeSessions: number;
      lifetimeThrottles: number;
    };
    buckets: TimeBucketPoint[];
  };
}

export function getProxyStatePath(customPath?: string): string {
  return (
    customPath ??
    process.env.M365_STATE_FILE ??
    join(
      process.env.M365_DATA_DIR ?? join(homedir(), ".config", "opencode-m365"),
      "proxy-state.json",
    )
  );
}

export function saveProxyState(filePath?: string): void {
  const targetPath = getProxyStatePath(filePath);
  const now = Date.now();

  const isArmed = isDegradationBackoff();
  const remainingCooldownMs = getRemainingDegradationCooldownMs();
  const level = getDegradationLevel();
  const backoffUntil = isArmed ? now + remainingCooldownMs : 0;

  const state: PersistentProxyState = {
    version: 1,
    savedAt: now,
    governor: {
      recentTurnTimestamps: getRecentTurnTimestamps(),
    },
    staggerQueue: getStaggerQueueInternalState(),
    circuitBreaker: {
      backoffUntil,
      level,
      throttleCount: defaultMetricsCollector.getLifetimeThrottles(),
    },
    metrics: {
      totals: defaultMetricsCollector.getTotals(),
      buckets: defaultMetricsCollector.getBuckets(),
    },
  };

  try {
    const dir = dirname(targetPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmpPath, targetPath);
  } catch (err: any) {
    // Non-fatal, persistence errors should not crash the proxy
  }
}

export function loadProxyState(filePath?: string): boolean {
  const targetPath = getProxyStatePath(filePath);
  if (!existsSync(targetPath)) {
    return false;
  }

  try {
    const raw = readFileSync(targetPath, "utf-8");
    if (!raw.trim()) return false;
    const state = JSON.parse(raw) as PersistentProxyState;

    if (!state || state.version !== 1) {
      return false;
    }

    const now = Date.now();
    const sustainedWindowMs = Number(process.env.M365_SUSTAINED_WINDOW_MS ?? 3_600_000);

    // 1. Restore governor turn timestamps (pruning entries > 60m)
    if (state.governor && Array.isArray(state.governor.recentTurnTimestamps)) {
      const validTurns = state.governor.recentTurnTimestamps.filter(
        (t) => typeof t === "number" && now - t < sustainedWindowMs,
      );
      setRecentTurnTimestamps(validTurns);
    }

    // 2. Restore session stagger queue tokens and timestamps
    if (state.staggerQueue) {
      const validSessionTs = (state.staggerQueue.recentSessionTimestamps ?? []).filter(
        (t) => typeof t === "number" && now - t < sustainedWindowMs,
      );
      setStaggerQueueInternalState({
        sessionTokens: state.staggerQueue.sessionTokens,
        lastTokenRefillAt: state.staggerQueue.lastTokenRefillAt,
        nextNewSessionAllowedAt: state.staggerQueue.nextNewSessionAllowedAt,
        recentSessionTimestamps: validSessionTs,
      });
    }

    // 3. Re-arm circuit breaker if backoffUntil > Date.now()
    if (state.circuitBreaker && typeof state.circuitBreaker.backoffUntil === "number") {
      if (state.circuitBreaker.backoffUntil > now) {
        const remainingMs = state.circuitBreaker.backoffUntil - now;
        triggerDegradationBackoff(remainingMs, "Restored circuit breaker state from disk");
      }
    }

    // 4. Restore metrics 24h buckets and totals
    if (state.metrics) {
      if (state.metrics.totals) {
        defaultMetricsCollector.setTotals(state.metrics.totals);
      }
      if (Array.isArray(state.metrics.buckets)) {
        defaultMetricsCollector.setBuckets(state.metrics.buckets, now);
      }
    }

    return true;
  } catch {
    return false;
  }
}

let saveTimeout: NodeJS.Timeout | undefined;
let activeFilePath: string | undefined;
let hooksInstalled = false;

function installProcessHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;

  const flush = () => {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = undefined;
    }
    saveProxyState(activeFilePath);
  };

  process.on("exit", flush);
  process.on("SIGINT", () => {
    flush();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    flush();
    process.exit(0);
  });
}

export function scheduleStateSave(filePath?: string, delayMs = 1000): void {
  if (filePath) activeFilePath = filePath;
  installProcessHooks();

  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }

  saveTimeout = setTimeout(() => {
    saveTimeout = undefined;
    saveProxyState(activeFilePath);
  }, delayMs);

  if (typeof saveTimeout.unref === "function") {
    saveTimeout.unref();
  }
}

export function flushStateSave(filePath?: string): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = undefined;
  }
  saveProxyState(filePath ?? activeFilePath);
}

export function cancelScheduledSave(): void {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = undefined;
  }
}
