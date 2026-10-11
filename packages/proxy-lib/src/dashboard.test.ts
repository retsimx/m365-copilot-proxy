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
    it("returns standalone zero-dependency HTML", () => {
      const html = getDashboardHtml();
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<title>M365 Copilot Proxy · Observability Console</title>");
      expect(html).not.toMatch(/https?:\/\/[^"'\s]+\.(?:css|js)/i);
      expect(html).not.toContain("cdn.jsdelivr.net");
      expect(html).not.toContain("fonts.googleapis.com");
    });

    it("uses a compact responsive four-column card grid", () => {
      const html = getDashboardHtml();
      expect(html).toContain("grid-template-columns:repeat(4,minmax(0,1fr))");
      expect(html).toContain("min-height:148px");
      expect(html).toContain("@media(max-width:1100px)");
      expect(html).toContain("grid-template-columns:repeat(2,1fr)");
      expect(html).toContain("@media(max-width:650px)");
    });

    it("contains exactly eight operational summary cards", () => {
      const html = getDashboardHtml();
      expect((html.match(/<article class="card">/g) ?? [])).toHaveLength(8);
      expect(html).toContain("Sustained Turns · 60m");
      expect(html).toContain("Burst Turns · 10m");
      expect(html).toContain("Fresh-Session Capacity");
      expect(html).toContain("Upstream Circuit Breaker");
      expect(html).toContain("Next Turn / Queue");
      expect(html).toContain("Request Consumption · 60m");
      expect(html).toContain("Current Throughput");
      expect(html).toContain("Dispatch Delay · 60m");
    });

    it("keeps turn and session governing visibly separate", () => {
      const html = getDashboardHtml();
      expect(html).toContain('id="turnStatus"');
      expect(html).toContain('id="sessionStatus"');
      expect(html).toContain('id="sustainedDelay"');
      expect(html).toContain('id="burstDelay"');
      expect(html).toContain('id="sessionRefill"');
      expect(html).toContain('id="sessionEligible"');
      expect(html).toContain('id="sessionDelay"');
      expect(html).toContain("Waiting for turn capacity");
      expect(html).toContain("Waiting for session capacity");
    });

    it("shows factual request consumption instead of model quality scoring", () => {
      const html = getDashboardHtml();
      expect(html).toContain('id="consumptionValue"');
      expect(html).toContain('id="clientRequests"');
      expect(html).toContain('id="retryAttempts"');
      expect(html).toContain('id="reconnectAttempts"');
      expect(html).toContain('id="disengagedAttempts"');
      expect(html).not.toContain("First-Pass Yield");
      expect(html).not.toContain("Turn Quality");
      expect(html).not.toContain("qualityStatusBadge");
    });

    it("contains four separate operational history charts with range controls", () => {
      const html = getDashboardHtml();
      expect(html).toContain("Governor History");
      expect(html).toContain('id="turn60Chart"');
      expect(html).toContain('id="turn10Chart"');
      expect(html).toContain('id="delayChart"');
      expect(html).toContain('id="sessionChart"');
      expect(html).toContain('data-range="1h"');
      expect(html).toContain('data-range="6h"');
      expect(html).toContain('data-range="24h"');
      expect(html).toContain("rolling60mTurns");
      expect(html).toContain("rolling10mTurns");
      expect(html).toContain("rolling10mSessions");
      expect(html).toContain("averageTurnDelayMs");
      expect(html).not.toContain("Combined");
    });

    it("contains newest-first recently active conversation rendering", () => {
      const html = getDashboardHtml();
      expect(html).toContain("Recently Active Conversations");
      expect(html).toContain("Newest activity first");
      expect(html).toContain("Turns: ");
      expect(html).toContain("Model / route");
      expect(html).toContain("Upstream");
      expect(html).toContain("Last active");
      expect(html).toContain("sort((a,b)=>b.lastAccessedAt-a.lastAccessedAt)");
      expect(html).toContain("running · ");
      expect(html).toContain("waiting · ");
    });

    it("polls the metrics endpoint and renders dynamic policy values", () => {
      const html = getDashboardHtml();
      expect(html).toContain('fetch("/api/metrics?range="+range)');
      expect(html).toContain("cfg.sustainedMaxTurns");
      expect(html).toContain("cfg.sustainedWarnTurns");
      expect(html).toContain("cfg.burstMaxTurns");
      expect(html).toContain("cfg.burstSoftTurns");
      expect(html).toContain("c.sessionDangerThreshold10m");
      expect(html).toContain("c.sessionWarnThreshold10m");
      expect(html).toContain("setInterval(fetchMetrics,2000)");
    });

    it("contains corrected empirical operating notes", () => {
      const html = getDashboardHtml();
      expect(html).toContain("conservative local operating policy");
      expect(html).toContain("130 and 135 recorded attempts");
      expect(html).toContain("PerUserThrottled");
      expect(html).toContain("PerScenarioThrottled");
      expect(html).toContain("exact upstream accounting function remains unknown");
      expect(html).toContain("transport reconnects");
      expect(html).toContain("Disengaged recovery");
    });
  });

  describe("createApp() HTTP Routes", () => {
    it("serves HTML dashboard on GET / and GET /dashboard", async () => {
      const app = createApp();
      for (const path of ["/", "/dashboard"]) {
        const res = await app.fetch(new Request("http://localhost" + path));
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
        expect(await res.text()).toContain("Recently Active Conversations");
      }
    });

    it("serves the operational metrics contract", async () => {
      const app = createApp();
      const res = await app.fetch(new Request("http://localhost/api/metrics"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.history.points).toHaveLength(60);
      expect(body.turnQueue).toMatchObject({
        depth: 0,
        priorityCount: 0,
        oldestWaitMs: 0,
        nextDispatchMs: 0,
        delayCause: "ready",
      });
      expect(body.staggerQueue).toHaveProperty("nextRefillMs");
      expect(body.staggerQueue).toHaveProperty("nextEligibleMs");
      expect(body.consumption).toBeDefined();
      expect(body.dispatchDelay).toBeDefined();
      expect(body.history.points[0]).toHaveProperty("rolling10mTurns");
      expect(body.history.points[0]).toHaveProperty("rolling60mTurns");
      expect(body.history.points[0]).toHaveProperty("rolling10mSessions");
    });

    it("supports 6h and 24h history ranges", async () => {
      const app = createApp();
      const six = await (await app.fetch(new Request("http://localhost/api/metrics?range=6h"))).json();
      const day = await (await app.fetch(new Request("http://localhost/api/metrics?range=24h"))).json();
      expect(six.history.points).toHaveLength(360);
      expect(day.history.points).toHaveLength(1440);
    });

    it("handles OPTIONS preflight", async () => {
      const app = createApp();
      const res = await app.fetch(new Request("http://localhost/api/metrics", { method: "OPTIONS" }));
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });
});
