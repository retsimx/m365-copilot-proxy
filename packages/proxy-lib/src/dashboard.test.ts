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

      // Card 4: Circuit Shield & Queue
      expect(html).toContain("Circuit Shield &amp; Queue");
      expect(html).toContain('id="circuitBadge"');
      expect(html).toContain('id="queueDelayPrimary"');
      expect(html).toContain('id="queueBar"');
    });

    it("contains historical timeline with pure SVG chart and range toggles", () => {
      const html = getDashboardHtml();
      expect(html).toContain("Historical Timeline &amp; Risk Zones");
      expect(html).toContain('data-range="1h"');
      expect(html).toContain('data-range="6h"');
      expect(html).toContain('data-range="24h"');
      expect(html).toContain('id="chartSvg"');
      expect(html).toContain('id="chartTooltip"');
      expect(html).toContain("Turns Filled Area");
      expect(html).toContain("New Sessions (Turn 0)");
      expect(html).toContain("Throttle Event (PerScenarioThrottled)");
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
      expect(html).toContain("Why does Microsoft throttle Thread Creation rather than Token Count?");
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
