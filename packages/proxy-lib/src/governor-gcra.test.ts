import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  turnPaceWait,
  reconstructTat,
  advanceTatAfterDispatch,
  getSustainedTatMs,
  setSustainedTatMs,
  setRecentTurnTimestamps,
  resetTurnVelocityPacing,
  paceTurnVelocity,
  type PaceConfig,
} from "./handler.js";
import { saveProxyState, loadProxyState } from "./persistence.js";

/**
 * Regression suite for the 2026-10-13 production incident: a single turn stalled
 * 630.8 s and the 60-minute window pinned at 110/110. Root cause: the shipped
 * "proportional-taper" soft pace went dormant after an idle gap (its debt signal was
 * measured from the window's OLDEST entry), was bypassed at the cap, and could not
 * prevent an uncapped hard-window drain.
 *
 * RED  = behaviour of the shipped taper (reimplemented below as `shippedTurnPaceWait`
 *        purely to demonstrate the defect the fix must eliminate).
 * GREEN = behaviour of the GCRA governor now shipped.
 */

const T = 3_600_000 / 110; // ≈ 32_727.27 ms — the sustainable interval (110/hr)

const cfg: PaceConfig = {
  windowMs: 3_600_000,
  maxTurns: 110,
  burstWindowMs: 60_000,
  burstMaxTurns: 8,
  burstAllowance: 6,
  minSpacingMs: 1_500,
};

interface OldCfg {
  windowMs: number;
  maxTurns: number;
  burstWindowMs: number;
  burstMaxTurns: number;
  burstAllowance: number;
  ceilingMs: number;
}
const oldCfg: OldCfg = {
  windowMs: 3_600_000,
  maxTurns: 110,
  burstWindowMs: 60_000,
  burstMaxTurns: 8,
  burstAllowance: 6,
  ceilingMs: 45_000,
};

/** Verbatim reimplementation of the shipped (pre-fix) taper, for RED assertions only. */
function shippedTurnPaceWait(
  timestamps: number[],
  now: number,
  lastDispatch: number,
  c: OldCfg,
): number {
  const { windowMs, maxTurns, burstWindowMs, burstMaxTurns, burstAllowance, ceilingMs } = c;
  const count = timestamps.length;
  let hardWait = 0;
  if (maxTurns > 0 && windowMs > 0 && count >= maxTurns) {
    hardWait = Math.max(1000, timestamps[count - maxTurns] + windowMs - now);
  }
  let burstCount = 0;
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (now - timestamps[i] < burstWindowMs) burstCount++;
    else break;
  }
  if (burstMaxTurns > 0 && burstWindowMs > 0 && burstCount >= burstMaxTurns) {
    const burstOldest = timestamps[count - burstCount];
    hardWait = Math.max(hardWait, Math.max(1000, burstOldest + burstWindowMs - now));
  }
  let softWait = 0;
  if (count > 0 && maxTurns > count && windowMs > 0 && burstAllowance > 0) {
    const oldest = timestamps[0];
    const ideal = (now - oldest) / (windowMs / maxTurns);
    const debt = count - ideal;
    if (debt > 0) {
      const amortized = (oldest + windowMs - now) / (maxTurns - count);
      const pace = Math.min(amortized * Math.min(1, debt / burstAllowance), ceilingMs);
      const sinceLast = lastDispatch > 0 ? now - lastDispatch : 0;
      softWait = Math.max(0, pace - sinceLast);
    }
  }
  return Math.max(hardWait, softWait);
}

const fixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/governor-trace-2026-10-13.json", import.meta.url), "utf-8"),
) as { timestamps: number[]; derived: { first: number; last: number; maxGapMs: number } };
const TRACE: number[] = fixture.timestamps;

const PACE_ENV = [
  "M365_MIN_TURN_SPACING_MS",
  "M365_SUSTAINED_WINDOW_MS",
  "M365_SUSTAINED_MAX_TURNS",
  "M365_BURST_WINDOW_MS",
  "M365_BURST_MAX_TURNS",
  "M365_PACE_BURST_ALLOWANCE",
];

describe("GCRA turn governor — 2026-10-13 stall regression", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of PACE_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    resetTurnVelocityPacing();
  });

  // ---- fixture integrity -------------------------------------------------
  it("uses the real 110-timestamp incident trace (fails if the fixture is wrong)", () => {
    expect(TRACE).toHaveLength(110);
    expect(TRACE[0]).toBe(1_791_869_933_574);
    expect(TRACE[TRACE.length - 1]).toBe(1_791_873_498_494);
    expect(TRACE.every((t, i) => i === 0 || t >= TRACE[i - 1])).toBe(true);
    const maxGap = Math.max(...TRACE.slice(1).map((t, i) => t - TRACE[i]));
    expect(maxGap).toBe(630_797);
  });

  // ---- the headline: real endpoint --------------------------------------
  it("real trace: GCRA reports the accumulated debt (89,451 ms); the shipped taper under-reports it (35,080 ms)", () => {
    const now = TRACE[TRACE.length - 1];
    const tat = reconstructTat(TRACE, T);
    expect(tat).toBeCloseTo(1_791_873_784_307.907, 2);

    const r = turnPaceWait(TRACE, now, now, tat, cfg);
    expect(r.waitMs).toBe(89_451);
    expect(r.cause).toBe("sustained-gcra");

    // RED: at the cap the shipped taper is bypassed and returns only the hard drain —
    // it silently ignores the virtual debt, which is how the window walked into the cliff.
    expect(shippedTurnPaceWait(TRACE, now, now, oldCfg)).toBe(35_080);
  });

  // ---- D1: idle-gap dormancy --------------------------------------------
  it("RED: taper dormant after an idle gap (returns 0); GREEN: GCRA paces within ~23 min of the refill", () => {
    const base = 1_791_800_000_000;
    const ts53 = Array.from({ length: 53 }, (_, i) => base + i * T);
    const afterGap = ts53[52] + 11 * 60_000;

    // The shipped debt signal is negative after the gap → the taper applies no resistance.
    const debt = 53 - (afterGap - ts53[0]) / T;
    expect(debt).toBeLessThan(0);
    expect(shippedTurnPaceWait(ts53, afterGap, ts53[52], oldCfg)).toBe(0); // RED

    // GREEN: replaying 2.1/min arrivals, GCRA's tolerance (6·T) is consumed and pacing
    // starts within the refill — turn 49 (pre-dispatch wait), turn 41 (post-dispatch debt).
    const arr = 60_000 / 2.1;
    let tat = 0;
    let firstPreWait = -1;
    let firstPostDebt = -1;
    for (let i = 0; i < 100; i++) {
      const arrival = i * arr;
      if (Math.max(0, tat - 6 * T - arrival) > 0 && firstPreWait < 0) firstPreWait = i + 1;
      tat = Math.max(tat, arrival) + T;
      if (tat - arrival > 6 * T && firstPostDebt < 0) firstPostDebt = i + 1;
    }
    expect(firstPostDebt).toBe(41);
    expect(firstPreWait).toBe(49);
  });

  // ---- hard windows stay absolute on an already-packed window -----------
  it("an already-packed window still returns the exact hard-window drain (hard caps are absolute)", () => {
    const cliffNow = 1_791_872_432_000;
    const cliffOldest = cliffNow - (3_600_000 - 630_795);
    const cliffTs = [
      cliffOldest,
      ...Array.from(
        { length: 109 },
        (_, i) => cliffOldest + Math.floor(((i + 1) * (cliffNow - cliffOldest)) / 110),
      ),
    ];
    // GCRA cannot retroactively unpack a window that is already full — the exact hard
    // window governs, unchanged. (GCRA's job is to PREVENT such a pack.)
    const r = turnPaceWait(cliffTs, cliffNow, cliffNow, reconstructTat(cliffTs, T), cfg);
    expect(r.cause).toBe("sustained-window");
    expect(r.waitMs).toBe(630_795);
    // RED: the shipped taper returns the very same drain here — proving the model is the
    // very state that produced the production 630.8 s stall.
    expect(shippedTurnPaceWait(cliffTs, cliffNow, cliffNow, oldCfg)).toBe(630_795);
  });

  // ---- GCRA PREVENTS the pack (the actual fix) ---------------------------
  it("zero-think synchronous trace: GCRA prevents the pack, bounding every wait and keeping both windows", () => {
    let ts: number[] = [];
    let last = 0;
    let tat = 0;
    let prevDispatch = 0;
    let maxWait = 0;
    for (let i = 0; i < 120; i++) {
      const arrival = prevDispatch; // client offers the next turn the instant the last returns
      let now = Math.max(arrival, last);
      for (let g = 0; g < 100_000; g++) {
        ts = ts.filter((t) => t > now - cfg.windowMs);
        const r = turnPaceWait(ts, now, last, tat, cfg);
        if (r.waitMs > 0) {
          now += r.waitMs;
          continue;
        }
        break;
      }
      maxWait = Math.max(maxWait, now - arrival);
      ts.push(now);
      last = now;
      prevDispatch = now;
      tat = advanceTatAfterDispatch(tat, now, T);
    }
    const maxWin = (dur: number) =>
      ts.reduce((m, t) => Math.max(m, ts.filter((u) => u > t - dur && u <= t).length), 0);
    expect(maxWin(3_600_000)).toBeLessThanOrEqual(110);
    expect(maxWin(60_000)).toBeLessThanOrEqual(8);
    // The 630 s-class stall is mathematically gone: every wait ≤ (BA+1)·T ≈ 229 s.
    expect(maxWait).toBeLessThanOrEqual(229_101);
  });

  // ---- burst layer preserved --------------------------------------------
  it("preserves the 8/60s hard burst window (a proposed replacement dropped it)", () => {
    const now = 2_000_000;
    const ts8 = [
      now - 7000, now - 6000, now - 5000, now - 4000,
      now - 3000, now - 2000, now - 1000, now,
    ];
    // Isolate the burst layer behind a spent GCRA schedule.
    const isolated = turnPaceWait(ts8, now, now, now - 1_000_000, cfg);
    expect(isolated.waitMs).toBe(53_000);
    expect(isolated.cause).toBe("burst-window");

    // With a GCRA-consistent schedule the burst floor still binds (never returns 0).
    const consistent = turnPaceWait(ts8, now, now, reconstructTat(ts8, T), cfg);
    expect(consistent.waitMs).toBeGreaterThanOrEqual(53_000);
  });

  // ---- remaining-wait semantics -----------------------------------------
  it("returns the REMAINING wait on re-evaluation (never a fresh full interval)", () => {
    const tau = 6 * T;
    const now0 = 1_000_000;
    const tat0 = now0 + tau + 40_000; // admissible in exactly 40 s
    expect(turnPaceWait([], now0, now0, tat0, cfg).waitMs).toBe(40_000);
    expect(turnPaceWait([], now0 + 25_000, now0, tat0, cfg).waitMs).toBe(15_000);
  });

  // ---- sustainable rate is free -----------------------------------------
  it("pays ZERO wait at the sustainable rate (T apart) — no systematic penalty", () => {
    let tat = 0;
    let last = 0;
    for (let i = 0; i < 110; i++) {
      const now = i * T;
      expect(turnPaceWait([], now, last, tat, cfg).waitMs).toBe(0);
      tat = advanceTatAfterDispatch(tat, now, T);
      last = now;
    }
  });

  // ---- reset + TAT lifecycle --------------------------------------------
  it("resetTurnVelocityPacing clears TAT so the first post-reset turn is immediate", async () => {
    resetTurnVelocityPacing();
    expect(getSustainedTatMs()).toBe(0);
    expect(await paceTurnVelocity()).toBe(0); // first turn immediate
    expect(getSustainedTatMs()).toBeGreaterThan(0); // TAT advanced on a real dispatch
    resetTurnVelocityPacing();
    expect(getSustainedTatMs()).toBe(0);
    expect(await paceTurnVelocity()).toBe(0);
  });

  // ---- persistence round-trip -------------------------------------------
  it("persists and restores the GCRA TAT across a reload", () => {
    const file = join(tmpdir(), `m365-gov-tat-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
      resetTurnVelocityPacing();
      const now = Date.now();
      setRecentTurnTimestamps([now - 1000, now]);
      setSustainedTatMs(now + 30_000);
      saveProxyState(file);

      resetTurnVelocityPacing();
      expect(getSustainedTatMs()).toBe(0);

      expect(loadProxyState(file)).toBe(true);
      expect(getSustainedTatMs()).toBe(now + 30_000);
    } finally {
      resetTurnVelocityPacing();
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch {
        /* ignore */
      }
    }
  });
});
