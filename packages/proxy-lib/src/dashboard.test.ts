import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getDashboardHtml,
  createApp,
  resetMetrics,
  resetNewSessionPacing,
  resetTurnVelocityPacing,
} from "./index.js";

describe("Web Dashboard & Telemetry API", () => {
  beforeEach(() => {
    resetMetrics();
    resetNewSessionPacing();
    resetTurnVelocityPacing();
  });

  afterEach(() => {
    resetMetrics();
    resetNewSessionPacing();
    resetTurnVelocityPacing();
  });

  describe("getDashboardHtml()", () => {
    it("returns standalone, self-contained HTML with zero external CDN dependencies", () => {
      const html = getDashboardHtml();
      expect(typeof html).toBe("string");
      expect(html.length).toBeGreaterThan(1000);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<title>M365 Copilot Proxy · Observability Console</title>");

      // Verify zero external CDN links
      expect(html).not.toMatch(/https?:\/\/[^"'\s]+\.(?:css|js)/i);
      expect(html).not.toContain("cdn.jsdelivr.net");
      expect(html).not.toContain("cdnjs.cloudflare.com");
      expect(html).not.toContain("unpkg.com");
      expect(html).not.toContain("fonts.googleapis.com");
    });

    it("contains dark-mode developer console theme and required header elements", () => {
      const html = getDashboardHtml();
      expect(html).toContain("#0b0f17"); // slate-900 background
      expect(html).toContain("#151c28"); // slate-800 card background
      expect(html).toContain("#232f45"); // border
      expect(html).toContain("#06b6d4"); // cyan
      expect(html).toContain("#10b981"); // emerald
      expect(html).toContain("#f59e0b"); // amber
      expect(html).toContain("#f43f5e"); // rose
      expect(html).toContain("#a855f7"); // purple

      // Header components
      expect(html).toContain('id="healthBadge"');
      expect(html).toContain('id="clockDisplay"');
      expect(html).toContain("Live Polling (2s)");
    });

    it("contains all 4 top metric cards with tooltips and progress bars", () => {
      const html = getDashboardHtml();

      // Card 1: Thread Creation (10m)
      expect(html).toContain("Thread Creation (10m)");
      expect(html).toContain('id="threadPrimary"');
      expect(html).toContain('id="threadBar"');
      expect(html).toContain('id="threadWarnMarker"');

      // Card 2: Turn Burst (10m)
      expect(html).toContain("Turn Burst (10m)");
      expect(html).toContain('id="burstPrimary"');
      expect(html).toContain('id="burstBar"');
      expect(html).toContain('id="burstSoftMarker"');

      // Card 3: Sustained Turns (60m)
      expect(html).toContain("Sustained Turns (60m)");
      expect(html).toContain('id="sustainedPrimary"');
      expect(html).toContain('id="sustainedBar"');
      expect(html).toContain('id="sustainedWarnMarker"');

      // Card 4: Circuit Shield & Gatekeeper
      expect(html).toContain("Circuit Shield &amp; Gatekeeper");
      expect(html).toContain('id="circuitBadge"');
      expect(html).toContain('id="queueDelayPrimary"');
      expect(html).toContain('id="queueDelaySecondary"');
      expect(html).toContain('id="queueBar"');
    });

    it("contains historical timeline with pure SVG chart and view/range toggles", () => {
      const html = getDashboardHtml();
      expect(html).toContain("Historical Timeline &amp; Risk Zones");

      // View mode toggle buttons
      expect(html).toContain('id="viewSplitBtn"');
      expect(html).toContain('id="viewCombinedBtn"');
      expect(html).toContain("view-toggle");
      expect(html).toContain("range-toggle");

      // Range selector buttons
      expect(html).toContain('data-range="1h"');
      expect(html).toContain('data-range="6h"');
      expect(html).toContain('data-range="24h"');

      // SVG charts for Split View and Combined View
      expect(html).toContain('id="chartSvgTurns"');
      expect(html).toContain('id="chartSvgSessions"');
      expect(html).toContain('id="chartSvg"');
      expect(html).toContain('id="splitViewContainer"');
      expect(html).toContain('id="combinedViewContainer"');
      expect(html).toContain('id="chartTooltip"');

      // Legend items
      expect(html).toContain("Turns Filled Area");
      expect(html).toContain("New Sessions (Turn 0)");
      expect(html).toContain("Upstream Throttle (PerScenario / PerUser)");
      expect(html).toContain("Safe Zone");
      expect(html).toContain("Guarded Zone");
      expect(html).toContain("Danger Zone");
    });

    it("contains Fleet Session Directory table and empty state", () => {
      const html = getDashboardHtml();
      expect(html).toContain("Fleet Session Directory");
      expect(html).toContain("Conversation / Session ID");
      expect(html).toContain("Turn Meter");
      expect(html).toContain("Idle Time");
      expect(html).toContain("Status");
      expect(html).toContain('id="sessionsTableBody"');
      expect(html).toContain("No active conversations in memory");
    });

    it("contains System Primer & Architectural Knowledge Base accordion with dynamic placeholders", () => {
      const html = getDashboardHtml();
      expect(html).toContain("System Primer &amp; Architectural Knowledge Base");
      expect(html).toContain('What is the difference between a "Session" and a "Turn"?');
      expect(html).toContain("What are Microsoft's two distinct throttling horizons (Thread Creation vs Turn Volume)?");
      expect(html).toContain("How does the Dual-Horizon Governor calculate elastic braking?");
      expect(html).toContain("What does the Session Stagger Queue do?");
      expect(html).toContain("How does the Local Circuit Breaker protect the account?");

      // Dynamic config placeholder classes in primer text
      expect(html).toContain("cfg-max-turns");
      expect(html).toContain("cfg-burst-max");
      expect(html).toContain("cfg-burst-soft");
      expect(html).toContain("cfg-sustained-max");
      expect(html).toContain("cfg-sustained-warn");
      expect(html).toContain("cfg-spacing-sec");
      expect(html).toContain("cfg-bucket-capacity");
      expect(html).toContain("cfg-throttle-cooldown-sec");
    });

    it("contains client-side JS engine polling /api/metrics dynamically without hardcoded limits", () => {
      const html = getDashboardHtml();
      expect(html).toContain("fetch(\"/api/metrics?range=\"");
      expect(html).toContain("renderDashboard(data)");
      expect(html).toContain("data.config");
      expect(html).toContain("cfg.sessionDangerThreshold10m");
      expect(html).toContain("cfg.sessionWarnThreshold10m");
      expect(html).toContain("cfg.burstMaxTurns");
      expect(html).toContain("cfg.burstSoftTurns");
      expect(html).toContain("cfg.sustainedMaxTurns");
      expect(html).toContain("cfg.sustainedWarnTurns");
      expect(html).toContain("cfg.throttleCooldownSec");
    });

    it("renders zero-bleed inside-plot zone badges, clean numeric ticks, and synchronized split crosshairs", () => {
      const html = getDashboardHtml();
      // Timeline header with cumulative rolling velocity
      expect(html).toContain("Cumulative Rolling 10-Minute Velocity (Upstream Sliding Window)");
      expect(html).toContain("Displays the rolling 10m load evaluated by Microsoft's leaky bucket limiters at each point in time.");

      // Legend with dual-axis ranges
      expect(html).toContain("Turns Filled Area (Left Axis: 0-40)");
      expect(html).toContain("New Sessions (Turn 0) · Right Axis: 0-20");

      // SVG dual-axis mapping functions and logic
      expect(html).toContain("points[i].rolling10mTurns = rTurns");
      expect(html).toContain("points[i].rolling10mSessions = rSessions");
      expect(html).toContain("getYTurnSplit(val)");
      expect(html).toContain("getYSessionSplit(val)");
      expect(html).toContain("getYTurnComb(val)");
      expect(html).toContain("getYSessionComb(val)");
      expect(html).toContain("pinnedMaxTurns");
      expect(html).toContain("pinnedMaxSessions");

      // Zone badges positioned inside plot area with dark pill background
      expect(html).toContain("renderZoneBadge(x, y, text, color)");
      expect(html).toContain("🔴 DANGER (≥");
      expect(html).toContain("🟡 GUARDED (");
      expect(html).toContain("🟢 SAFE (0-");
      expect(html).toContain('text-anchor="end"');

      // Ticks are pure numbers without text bleed
      expect(html).toContain("splitPadL - 8");
      expect(html).toContain("combPadL - 8");
      expect(html).toContain("combPadL + combPlotW + 8");
      expect(html).not.toContain("val + \" (Burst Max)\"");
      expect(html).not.toContain("val + \" (Session Danger)\"");

      // Column headers
      expect(html).toContain("TURNS (10m · max");
      expect(html).toContain("SESSIONS (10m · max");

      // Synchronized crosshairs and hover dots on both split charts
      expect(html).toContain('id="crosshairTurn"');
      expect(html).toContain('id="crosshairSession"');
      expect(html).toContain('id="dotTurn"');
      expect(html).toContain('id="dotSession"');
      expect(html).toContain("handleSplitPointer(evt, activeSvg)");

      // Tooltip items
      expect(html).toContain("Rolling 10m Turns:");
      expect(html).toContain("Rolling 10m Sessions:");
      expect(html).toContain("Discrete 1m Delta:");

      // View mode persistence
      expect(html).toContain("proxy_dashboard_view_mode");
    });
  });

  describe("Dashboard Graph Mathematics & Dual-Axis Scaling", () => {
    it("computes cumulative rolling 10-minute velocity across minute points", () => {
      interface Point {
        turns: number;
        newSessions: number;
        rolling10mTurns?: number;
        rolling10mSessions?: number;
      }

      // Simulate 15 consecutive 1-minute buckets with 3 turns each and a session every 3 minutes
      const points: Point[] = [];
      for (let i = 0; i < 15; i++) {
        points.push({
          turns: 3,
          newSessions: i % 3 === 0 ? 1 : 0,
        });
      }

      // Apply rolling 10m window algorithm
      for (let i = 0; i < points.length; i++) {
        let rTurns = 0;
        let rSessions = 0;
        for (let j = Math.max(0, i - 9); j <= i; j++) {
          rTurns += points[j].turns || 0;
          rSessions += points[j].newSessions || 0;
        }
        points[i].rolling10mTurns = rTurns;
        points[i].rolling10mSessions = rSessions;
      }

      // Point 0 (1 minute): 3 turns, 1 session
      expect(points[0].rolling10mTurns).toBe(3);
      expect(points[0].rolling10mSessions).toBe(1);

      // Point 4 (5 minutes): 5 * 3 = 15 turns
      expect(points[4].rolling10mTurns).toBe(15);

      // Point 9 (10 minutes full window): 10 * 3 = 30 turns
      expect(points[9].rolling10mTurns).toBe(30);

      // Point 14 (10 minutes sliding window): exactly 10 * 3 = 30 turns
      expect(points[14].rolling10mTurns).toBe(30);
      // Sessions in window [5..14] are minutes 6, 9, 12 -> 3 sessions
      expect(points[14].rolling10mSessions).toBe(3);
    });

    it("pins dual Y-axis scales to stable limits under normal traffic and scales dynamically on burst", () => {
      const cfg = {
        burstMaxTurns: 35,
        burstSoftTurns: 30,
        sessionDangerThreshold10m: 15,
        sessionWarnThreshold10m: 10,
      };

      // Case A: Normal load (max rolling turns = 18, max rolling sessions = 6)
      const normalPoints = [
        { rolling10mTurns: 18, rolling10mSessions: 6, turns: 2, newSessions: 1 },
      ];

      const pinnedMaxTurns = Math.max(cfg.burstMaxTurns + 5, 40);
      const pinnedMaxSessions = Math.max(cfg.sessionDangerThreshold10m + 5, 20);

      const maxObservedTurnsNormal = Math.max(...normalPoints.map((p) => Math.max(p.rolling10mTurns, p.turns)));
      const maxTurnsYNormal = Math.max(pinnedMaxTurns, Math.ceil(maxObservedTurnsNormal * 1.1));

      const maxObservedSessionsNormal = Math.max(
        ...normalPoints.map((p) => Math.max(p.rolling10mSessions, p.newSessions))
      );
      const maxSessionsYNormal = Math.max(pinnedMaxSessions, Math.ceil(maxObservedSessionsNormal * 1.1));

      expect(maxTurnsYNormal).toBe(40); // Stably pinned to 40
      expect(maxSessionsYNormal).toBe(20); // Stably pinned to 20

      // Case B: Massive burst load (e.g. 50 rolling turns, 24 rolling sessions)
      const burstPoints = [
        { rolling10mTurns: 50, rolling10mSessions: 24, turns: 8, newSessions: 3 },
      ];

      const maxObservedTurnsBurst = Math.max(...burstPoints.map((p) => Math.max(p.rolling10mTurns, p.turns)));
      const maxTurnsYBurst = Math.max(pinnedMaxTurns, Math.ceil(maxObservedTurnsBurst * 1.1));

      const maxObservedSessionsBurst = Math.max(
        ...burstPoints.map((p) => Math.max(p.rolling10mSessions, p.newSessions))
      );
      const maxSessionsYBurst = Math.max(pinnedMaxSessions, Math.ceil(maxObservedSessionsBurst * 1.1));

      expect(maxTurnsYBurst).toBe(Math.ceil(50 * 1.1)); // 56 (scaled dynamically with 10% headroom)
      expect(maxSessionsYBurst).toBe(27); // Scaled dynamically with 10% headroom
    });

    it("verifies risk band alignment between left turn warn (30/40) and right session danger (15/20)", () => {
      const maxTurnsY = 40;
      const maxSessionsY = 20;
      const turnBurstWarn = 30;
      const sessionDanger = 15;

      const turnWarnRatio = turnBurstWarn / maxTurnsY;
      const sessionDangerRatio = sessionDanger / maxSessionsY;

      // Both critical thresholds sit at exactly 75% height of the plot!
      expect(turnWarnRatio).toBe(0.75);
      expect(sessionDangerRatio).toBe(0.75);
    });
  });

  describe("createApp() HTTP Routes", () => {
    it("serves HTML dashboard on GET / and GET /dashboard", async () => {
      const app = createApp();

      const resRoot = await app.fetch(new Request("http://localhost/"));
      expect(resRoot.status).toBe(200);
      expect(resRoot.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(resRoot.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const htmlRoot = await resRoot.text();
      expect(htmlRoot).toContain("<title>M365 Copilot Proxy · Observability Console</title>");

      const resDash = await app.fetch(new Request("http://localhost/dashboard"));
      expect(resDash.status).toBe(200);
      expect(resDash.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      const htmlDash = await resDash.text();
      expect(htmlDash).toContain("<title>M365 Copilot Proxy · Observability Console</title>");
    });

    it("serves metrics JSON on GET /api/metrics with default 1h range", async () => {
      const app = createApp();

      const res = await app.fetch(new Request("http://localhost/api/metrics"));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");

      const body = await res.json();
      expect(body.health).toBe("healthy");
      expect(body.history.range).toBe("1h");
      expect(body.history.points).toHaveLength(60);
      expect(body.circuitBreaker).toBeDefined();
      expect(body.staggerQueue).toBeDefined();
      expect(body.governor).toBeDefined();
      expect(body.config).toBeDefined();
      expect(body.config.burstMaxTurns).toBeGreaterThan(0);
      expect(body.config.sessionDangerThreshold10m).toBeGreaterThan(0);
      expect(body.config.newSessionSpacingMs).toBeGreaterThan(0);
    });

    it("serves metrics JSON on GET /api/metrics with 6h and 24h ranges", async () => {
      const app = createApp();

      const res6h = await app.fetch(new Request("http://localhost/api/metrics?range=6h"));
      expect(res6h.status).toBe(200);
      const body6h = await res6h.json();
      expect(body6h.history.range).toBe("6h");
      expect(body6h.history.points).toHaveLength(360);

      const res24h = await app.fetch(new Request("http://localhost/api/metrics?range=24h"));
      expect(res24h.status).toBe(200);
      const body24h = await res24h.json();
      expect(body24h.history.range).toBe("24h");
      expect(body24h.history.points).toHaveLength(1440);
    });

    it("handles OPTIONS preflight for / and /api/metrics", async () => {
      const app = createApp();

      const res1 = await app.fetch(new Request("http://localhost/", { method: "OPTIONS" }));
      expect(res1.status).toBe(204);
      expect(res1.headers.get("Access-Control-Allow-Origin")).toBe("*");

      const res2 = await app.fetch(new Request("http://localhost/api/metrics", { method: "OPTIONS" }));
      expect(res2.status).toBe(204);
      expect(res2.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });
});
