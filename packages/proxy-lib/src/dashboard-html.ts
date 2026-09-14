/**
 * Embedded interactive Web Dashboard for m365-copilot-proxy.
 *
 * Self-contained, zero-external-CDN HTML5/SVG/CSS/JS observability console.
 * Strictly adheres to dynamic config sourcing: all thresholds, limits, and
 * system constants are loaded dynamically from `/api/metrics` (data.config).
 */

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>M365 Copilot Proxy · Observability Console</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2306b6d4'><path d='M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5'/></svg>">
  <style>
    :root {
      --bg: #0b0f17;
      --card-bg: #151c28;
      --card-header: #1c2637;
      --border: #232f45;
      --border-focus: #3b82f6;
      --cyan: #06b6d4;
      --cyan-glow: rgba(6, 182, 212, 0.15);
      --emerald: #10b981;
      --emerald-glow: rgba(16, 185, 129, 0.15);
      --amber: #f59e0b;
      --amber-glow: rgba(245, 158, 11, 0.15);
      --rose: #f43f5e;
      --rose-glow: rgba(244, 63, 94, 0.15);
      --purple: #a855f7;
      --purple-glow: rgba(168, 85, 247, 0.15);
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background-color: var(--bg);
      color: var(--text-main);
      font-family: var(--font-sans);
      line-height: 1.5;
      padding: 1.5rem;
      min-height: 100vh;
    }

    .container {
      max-width: 1360px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    /* Header */
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border);
    }

    .title-group {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .logo-badge {
      width: 36px;
      height: 36px;
      background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 12px var(--cyan-glow);
    }

    .logo-badge svg {
      width: 22px;
      height: 22px;
      fill: #ffffff;
    }

    h1 {
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: #ffffff;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 1rem;
      font-size: 0.875rem;
    }

    .health-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.35rem 0.85rem;
      border-radius: 9999px;
      font-weight: 600;
      font-size: 0.8rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      transition: all 0.3s ease;
      border: 1px solid transparent;
    }

    .health-healthy {
      background: rgba(16, 185, 129, 0.12);
      color: #34d399;
      border-color: rgba(16, 185, 129, 0.3);
    }

    .health-warning {
      background: rgba(245, 158, 11, 0.12);
      color: #fbbf24;
      border-color: rgba(245, 158, 11, 0.3);
    }

    .health-danger {
      background: rgba(244, 63, 94, 0.12);
      color: #fb7185;
      border-color: rgba(244, 63, 94, 0.3);
      animation: pulse-danger 2s infinite;
    }

    .health-throttled {
      background: rgba(168, 85, 247, 0.15);
      color: #c084fc;
      border-color: rgba(168, 85, 247, 0.4);
      animation: pulse-throttled 2s infinite;
    }

    @keyframes pulse-danger {
      0%, 100% { box-shadow: 0 0 0 0 rgba(244, 63, 94, 0.4); }
      50% { box-shadow: 0 0 12px 2px rgba(244, 63, 94, 0.4); }
    }

    @keyframes pulse-throttled {
      0%, 100% { box-shadow: 0 0 0 0 rgba(168, 85, 247, 0.4); }
      50% { box-shadow: 0 0 12px 2px rgba(168, 85, 247, 0.4); }
    }

    .poll-indicator {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      color: var(--text-dim);
      font-family: var(--font-mono);
      font-size: 0.775rem;
    }

    .pulse-dot {
      width: 8px;
      height: 8px;
      background-color: var(--emerald);
      border-radius: 50%;
      display: inline-block;
      box-shadow: 0 0 8px var(--emerald);
      animation: live-pulse 2s infinite;
    }

    @keyframes live-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.8); }
    }

    .clock-display {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    /* Cards Grid */
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.25rem;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 1rem;
      position: relative;
      transition: transform 0.15s ease, border-color 0.15s ease;
    }

    .card:hover {
      border-color: #334155;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .card-title {
      font-size: 0.85rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .tooltip-btn {
      background: transparent;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.85rem;
      line-height: 1;
      padding: 2px;
      border-radius: 50%;
      transition: color 0.2s;
    }

    .tooltip-btn:hover {
      color: var(--cyan);
    }

    .tooltip-container {
      position: relative;
      display: inline-block;
    }

    .tooltip-text {
      visibility: hidden;
      opacity: 0;
      position: absolute;
      bottom: 125%;
      left: 50%;
      transform: translateX(-50%);
      width: 240px;
      background-color: #1e293b;
      color: #f1f5f9;
      font-size: 0.75rem;
      font-weight: 400;
      line-height: 1.4;
      text-transform: none;
      padding: 0.6rem 0.8rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
      z-index: 50;
      pointer-events: none;
      transition: opacity 0.2s ease, visibility 0.2s ease;
    }

    .tooltip-container:hover .tooltip-text {
      visibility: visible;
      opacity: 1;
    }

    .metric-value-row {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
    }

    .metric-primary {
      font-size: 2rem;
      font-weight: 700;
      font-family: var(--font-mono);
      line-height: 1;
      color: var(--text-main);
    }

    .metric-secondary {
      font-size: 1rem;
      font-family: var(--font-mono);
      color: var(--text-dim);
    }

    .progress-container {
      width: 100%;
      height: 8px;
      background: #0f172a;
      border-radius: 4px;
      overflow: hidden;
      position: relative;
      margin-top: 0.25rem;
    }

    .progress-bar {
      height: 100%;
      width: 0%;
      background: var(--cyan);
      border-radius: 4px;
      transition: width 0.4s ease, background-color 0.3s ease;
    }

    .progress-marker {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 2px;
      background: rgba(255, 255, 255, 0.4);
      z-index: 2;
    }

    .card-footer-info {
      font-size: 0.75rem;
      color: var(--text-dim);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* Status badges */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.2rem 0.6rem;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.03em;
    }

    .badge-emerald {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .badge-amber {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .badge-rose {
      background: rgba(244, 63, 94, 0.15);
      color: #fb7185;
      border: 1px solid rgba(244, 63, 94, 0.3);
    }

    .badge-purple {
      background: rgba(168, 85, 247, 0.15);
      color: #c084fc;
      border: 1px solid rgba(168, 85, 247, 0.3);
    }

    .badge-cyan {
      background: rgba(6, 182, 212, 0.15);
      color: #22d3ee;
      border: 1px solid rgba(6, 182, 212, 0.3);
    }

    .badge-slate {
      background: rgba(148, 163, 184, 0.12);
      color: #94a3b8;
      border: 1px solid rgba(148, 163, 184, 0.25);
    }

    /* Chart Section */
    .section-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .section-header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }

    .section-title {
      font-size: 1.1rem;
      font-weight: 700;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .range-selector {
      display: flex;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 3px;
      gap: 3px;
    }

    .range-btn {
      background: transparent;
      border: none;
      color: var(--text-dim);
      padding: 0.35rem 0.85rem;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .range-btn:hover {
      color: var(--text-main);
    }

    .range-btn.active {
      background: var(--card-header);
      color: var(--cyan);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
    }

    .chart-container {
      width: 100%;
      height: 280px;
      position: relative;
    }

    .chart-svg {
      width: 100%;
      height: 100%;
      overflow: visible;
    }

    .chart-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 1.5rem;
      font-size: 0.775rem;
      color: var(--text-muted);
      align-items: center;
      padding-top: 0.5rem;
      border-top: 1px solid rgba(35, 47, 69, 0.5);
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }

    .legend-color {
      width: 12px;
      height: 12px;
      border-radius: 3px;
    }

    .chart-tooltip {
      position: absolute;
      background: #1e293b;
      border: 1px solid var(--border);
      color: #ffffff;
      padding: 0.6rem 0.8rem;
      border-radius: 6px;
      font-size: 0.775rem;
      font-family: var(--font-mono);
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s ease;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
      z-index: 100;
    }

    /* Active Sessions Table */
    .table-container {
      width: 100%;
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.85rem;
    }

    th {
      color: var(--text-muted);
      font-weight: 600;
      text-transform: uppercase;
      font-size: 0.75rem;
      letter-spacing: 0.04em;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border);
      background: var(--card-header);
    }

    th:first-child { border-top-left-radius: 8px; }
    th:last-child { border-top-right-radius: 8px; }

    td {
      padding: 0.85rem 1rem;
      border-bottom: 1px solid rgba(35, 47, 69, 0.4);
      color: var(--text-main);
      vertical-align: middle;
    }

    tr:last-child td {
      border-bottom: none;
    }

    tbody tr:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .conv-id-cell {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-family: var(--font-mono);
      font-size: 0.8rem;
    }

    .copy-btn {
      background: transparent;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      padding: 2px;
      border-radius: 4px;
      transition: color 0.15s;
    }

    .copy-btn:hover {
      color: var(--cyan);
    }

    .table-meter {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      width: 140px;
    }

    .table-meter-bar {
      height: 6px;
      background: #0f172a;
      border-radius: 3px;
      overflow: hidden;
    }

    .table-meter-fill {
      height: 100%;
      background: var(--cyan);
      border-radius: 3px;
    }

    .empty-state {
      padding: 2.5rem 1rem;
      text-align: center;
      color: var(--text-dim);
      font-size: 0.9rem;
    }

    .empty-state svg {
      width: 40px;
      height: 40px;
      stroke: var(--text-dim);
      margin-bottom: 0.75rem;
      opacity: 0.6;
    }

    /* Accordion Primer */
    .accordion-group {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .accordion-item {
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      background: #101623;
      transition: border-color 0.2s;
    }

    .accordion-item:hover {
      border-color: #334155;
    }

    .accordion-toggle {
      width: 100%;
      background: transparent;
      border: none;
      color: var(--text-main);
      padding: 1rem 1.25rem;
      font-size: 0.9rem;
      font-weight: 600;
      text-align: left;
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      transition: background-color 0.2s;
    }

    .accordion-toggle:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .accordion-chevron {
      width: 16px;
      height: 16px;
      stroke: var(--text-dim);
      transition: transform 0.25s ease;
      flex-shrink: 0;
    }

    .accordion-item.open .accordion-chevron {
      transform: rotate(180deg);
      stroke: var(--cyan);
    }

    .accordion-content {
      display: none;
      padding: 0 1.25rem 1.25rem 1.25rem;
      color: var(--text-muted);
      font-size: 0.85rem;
      line-height: 1.6;
      border-top: 1px solid rgba(35, 47, 69, 0.4);
      background: rgba(0, 0, 0, 0.1);
    }

    .accordion-item.open .accordion-content {
      display: block;
      padding-top: 1rem;
    }

    .accordion-content p {
      margin-bottom: 0.5rem;
    }

    .accordion-content p:last-child {
      margin-bottom: 0;
    }

    .highlight-param {
      font-family: var(--font-mono);
      color: var(--cyan);
      background: rgba(6, 182, 212, 0.1);
      padding: 0.1rem 0.35rem;
      border-radius: 4px;
      font-size: 0.8rem;
    }

    /* Utilities */
    .mono { font-family: var(--font-mono); }

    /* Responsive */
    @media (max-width: 768px) {
      body { padding: 1rem; }
      header { flex-direction: column; align-items: flex-start; }
      .header-actions { width: 100%; justify-content: space-between; flex-wrap: wrap; }
      .cards-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <header>
      <div class="title-group">
        <div class="logo-badge">
          <svg viewBox="0 0 24 24">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
        </div>
        <div>
          <h1>M365 Copilot Proxy · Observability Console</h1>
          <div style="font-size: 0.75rem; color: var(--text-dim);">Live Telemetry &amp; Upstream Account Governor</div>
        </div>
      </div>

      <div class="header-actions">
        <span id="healthBadge" class="health-pill health-healthy">HEALTHY</span>
        <div class="poll-indicator">
          <span class="pulse-dot"></span>
          <span>Live Polling (2s)</span>
        </div>
        <div id="clockDisplay" class="clock-display">—</div>
      </div>
    </header>

    <!-- Top Metric Cards -->
    <div class="cards-grid">
      <!-- Card 1: Thread Creation Rate -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">
            Thread Creation (10m)
            <span class="tooltip-container">
              <button class="tooltip-btn" aria-label="Info">ⓘ</button>
              <span class="tooltip-text">Tracks fresh session (turn 0) creation over a rolling 10-minute horizon. Microsoft enforces a thread-creation rate limit (~15-20 threads/10m). Exceeding danger threshold triggers proactive pacing.</span>
            </span>
          </span>
          <span id="threadStatusBadge" class="badge badge-emerald">Safe</span>
        </div>
        <div class="metric-value-row">
          <span id="threadPrimary" class="metric-primary">—</span>
          <span id="threadSecondary" class="metric-secondary">/ — max</span>
        </div>
        <div class="progress-container">
          <div id="threadBar" class="progress-bar"></div>
          <div id="threadWarnMarker" class="progress-marker" title="Warn marker"></div>
        </div>
        <div class="card-footer-info">
          <span id="threadFooter">Horizon: 10m</span>
          <span id="threadWarnFooter" class="mono">Warn: —</span>
        </div>
      </div>

      <!-- Card 2: Turn Burst (10m) -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">
            Turn Burst (10m)
            <span class="tooltip-container">
              <button class="tooltip-btn" aria-label="Info">ⓘ</button>
              <span class="tooltip-text">Monitors total turns across all conversations within the last 10 minutes. When turns cross the soft limit, elastic braking introduces progressive pacing.</span>
            </span>
          </span>
          <span id="burstStatusBadge" class="badge badge-emerald">Safe</span>
        </div>
        <div class="metric-value-row">
          <span id="burstPrimary" class="metric-primary">—</span>
          <span id="burstSecondary" class="metric-secondary">/ — max</span>
        </div>
        <div class="progress-container">
          <div id="burstBar" class="progress-bar"></div>
          <div id="burstSoftMarker" class="progress-marker" title="Soft marker"></div>
        </div>
        <div class="card-footer-info">
          <span id="burstFooter">Horizon: 10m</span>
          <span id="burstSoftFooter" class="mono">Soft: —</span>
        </div>
      </div>

      <!-- Card 3: Sustained Hourly Turns (60m) -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">
            Sustained Turns (60m)
            <span class="tooltip-container">
              <button class="tooltip-btn" aria-label="Info">ⓘ</button>
              <span class="tooltip-text">Tracks cumulative hourly turn velocity across all conversations. Guards against account degradation over long-running automated development sessions.</span>
            </span>
          </span>
          <span id="sustainedStatusBadge" class="badge badge-emerald">Safe</span>
        </div>
        <div class="metric-value-row">
          <span id="sustainedPrimary" class="metric-primary">—</span>
          <span id="sustainedSecondary" class="metric-secondary">/ — max</span>
        </div>
        <div class="progress-container">
          <div id="sustainedBar" class="progress-bar"></div>
          <div id="sustainedWarnMarker" class="progress-marker" title="Warn marker"></div>
        </div>
        <div class="card-footer-info">
          <span id="sustainedFooter">Horizon: 60m</span>
          <span id="sustainedWarnFooter" class="mono">Warn: —</span>
        </div>
      </div>

      <!-- Card 4: Circuit Shield & Queue -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">
            Circuit Shield &amp; Queue
            <span class="tooltip-container">
              <button class="tooltip-btn" aria-label="Info">ⓘ</button>
              <span class="tooltip-text">Monitors local circuit breaker state and the initial session stagger queue. Intercepts traffic locally during cooldown to protect Microsoft account quota.</span>
            </span>
          </span>
          <span id="circuitBadge" class="badge badge-emerald">DISARMED</span>
        </div>
        <div class="metric-value-row">
          <span id="queueDelayPrimary" class="metric-primary">0.0s</span>
          <span class="metric-secondary">queue delay</span>
        </div>
        <div class="progress-container">
          <div id="queueBar" class="progress-bar" style="background: var(--purple);"></div>
        </div>
        <div class="card-footer-info">
          <span id="queueTokensFooter">Tokens: —</span>
          <span id="cooldownFooter" class="mono">Cooldown: 0s</span>
        </div>
      </div>
    </div>

    <!-- Historical Timeline & Risk Zones -->
    <div class="section-card">
      <div class="section-header">
        <div class="section-title">
          <span>Historical Timeline &amp; Risk Zones</span>
        </div>
        <div class="range-selector">
          <button class="range-btn active" data-range="1h">1 Hour</button>
          <button class="range-btn" data-range="6h">6 Hours</button>
          <button class="range-btn" data-range="24h">24 Hours</button>
        </div>
      </div>

      <div class="chart-container" id="chartWrapper">
        <svg class="chart-svg" id="chartSvg" preserveAspectRatio="none" viewBox="0 0 1000 240"></svg>
        <div class="chart-tooltip" id="chartTooltip"></div>
      </div>

      <div class="chart-legend">
        <div class="legend-item">
          <div class="legend-color" style="background: var(--cyan);"></div>
          <span>Turns Filled Area</span>
        </div>
        <div class="legend-item">
          <div class="legend-color" style="background: var(--amber);"></div>
          <span>New Sessions (Turn 0)</span>
        </div>
        <div class="legend-item">
          <div class="legend-color" style="background: var(--purple);"></div>
          <span>⚡ Throttle Event (PerScenarioThrottled)</span>
        </div>
        <div class="legend-item">
          <div class="legend-color" style="background: rgba(16, 185, 129, 0.25);"></div>
          <span>Safe Zone</span>
        </div>
        <div class="legend-item">
          <div class="legend-color" style="background: rgba(245, 158, 11, 0.25);"></div>
          <span>Guarded Zone</span>
        </div>
        <div class="legend-item">
          <div class="legend-color" style="background: rgba(244, 63, 94, 0.25);"></div>
          <span>Danger Zone</span>
        </div>
      </div>
    </div>

    <!-- Fleet Session Directory -->
    <div class="section-card">
      <div class="section-header">
        <div class="section-title">
          <span>Fleet Session Directory</span>
          <span id="activeSessionsCount" class="badge badge-slate">0 Active</span>
        </div>
        <div style="font-size: 0.775rem; color: var(--text-dim);">
          In-Memory Conversations &amp; Turns Quota
        </div>
      </div>

      <div class="table-container">
        <table>
          <thead>
            <tr>
              <th>Conversation / Session ID</th>
              <th>Turn Meter</th>
              <th>Idle Time</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="sessionsTableBody">
            <tr>
              <td colspan="4">
                <div class="empty-state">
                  <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                  </svg>
                  <p>No active conversations in memory. Sessions appear when agent requests arrive.</p>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Collapsible System Primer & Knowledge Base -->
    <div class="section-card">
      <div class="section-header">
        <div class="section-title">
          <span>System Primer &amp; Architectural Knowledge Base</span>
        </div>
        <div style="font-size: 0.775rem; color: var(--text-dim);">
          Operating Principles &amp; Rate-Limiting Mechanics
        </div>
      </div>

      <div class="accordion-group">
        <!-- Section 1 -->
        <div class="accordion-item">
          <button class="accordion-toggle" type="button">
            <span>What is the difference between a "Session" and a "Turn"?</span>
            <svg class="accordion-chevron" viewBox="0 0 24 24" fill="none" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <div class="accordion-content">
            <p>A <strong>Session</strong> represents a distinct conversation thread with Microsoft 365 Copilot Studio. It maintains stateful conversation context in upstream data stores. A <strong>Turn</strong> is an individual prompt-and-response round trip (such as an agent executing a tool call) within an established conversation.</p>
            <p>While a single session can comfortably sustain hundreds of turns (up to <span class="highlight-param cfg-max-turns">—</span> user messages), opening fresh sessions consumes upstream thread creation budget. High-velocity subagent spawning burns threads quickly, whereas deep multiturn conversations in existing sessions are cheap.</p>
          </div>
        </div>

        <!-- Section 2 -->
        <div class="accordion-item">
          <button class="accordion-toggle" type="button">
            <span>Why does Microsoft throttle Thread Creation rather than Token Count?</span>
            <svg class="accordion-chevron" viewBox="0 0 24 24" fill="none" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <div class="accordion-content">
            <p>Empirical reverse engineering of M365 Copilot protocol frames reveals that rate limits track <em>conversations started per unit of time</em> rather than cumulative prompt tokens. Upstream throttling signals explicit <span class="highlight-param">PerScenarioThrottled</span> completion frames when thread creation exceeds roughly 15–20 conversations per 10 minutes.</p>
            <p>An autonomous agent running one persistent thread across dozens of tool calls rarely triggers throttling; however, multi-agent frameworks that spin up fresh conversation threads for every subtask rapidly trip this thread-velocity limit.</p>
          </div>
        </div>

        <!-- Section 3 -->
        <div class="accordion-item">
          <button class="accordion-toggle" type="button">
            <span>How does the Dual-Horizon Governor calculate elastic braking?</span>
            <svg class="accordion-chevron" viewBox="0 0 24 24" fill="none" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <div class="accordion-content">
            <p>The Dual-Horizon Velocity Governor evaluates telemetry across two rolling horizons simultaneously: a 10-minute burst window (capped at <span class="highlight-param cfg-burst-max">—</span> turns with elastic braking starting at <span class="highlight-param cfg-burst-soft">—</span> turns) and a 60-minute sustained window (capped at <span class="highlight-param cfg-sustained-max">—</span> turns with warning at <span class="highlight-param cfg-sustained-warn">—</span> turns).</p>
            <p>When turn velocity enters the guarded zone, the proxy injects progressive micro-delays (elastic braking) into completion requests. This smoothly paces client agents, keeping request rates just below Microsoft's threshold without failing the task.</p>
          </div>
        </div>

        <!-- Section 4 -->
        <div class="accordion-item">
          <button class="accordion-toggle" type="button">
            <span>What does the Session Stagger Queue do?</span>
            <svg class="accordion-chevron" viewBox="0 0 24 24" fill="none" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <div class="accordion-content">
            <p>The Session Stagger Queue guards the initiation of brand-new conversations (<span class="highlight-param">turn === 0</span>). It enforces a minimum spacing of <span class="highlight-param cfg-spacing-sec">—</span>s between new session handshakes and maintains a token bucket capacity of <span class="highlight-param cfg-bucket-capacity">—</span> tokens refilling every <span class="highlight-param cfg-refill-sec">—</span>s.</p>
            <p>This caps new thread creation to approximately 4 threads per minute. Subsequent turns (<span class="highlight-param">turn &gt; 0</span>) bypass the stagger queue entirely, ensuring ongoing agent loops execute at full interactive speed.</p>
          </div>
        </div>

        <!-- Section 5 -->
        <div class="accordion-item">
          <button class="accordion-toggle" type="button">
            <span>How does the Local Circuit Breaker protect the account?</span>
            <svg class="accordion-chevron" viewBox="0 0 24 24" fill="none" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <div class="accordion-content">
            <p>When upstream rate limiting (<span class="highlight-param">PerScenarioThrottled</span>) or consecutive empty responses are detected, the proxy arms a local circuit breaker with a cooldown of <span class="highlight-param cfg-throttle-cooldown-sec">—</span>s (<span class="highlight-param cfg-throttle-cooldown-min">—</span> minutes).</p>
            <p>During cooldown, the proxy locally intercepts requests and returns <span class="highlight-param">HTTP 429 Too Many Requests</span> with a client <span class="highlight-param">Retry-After: <span class="cfg-max-retry">—</span></span> header. <strong>Zero requests reach Microsoft during this window</strong>, allowing the upstream token bucket to recharge while client agents automatically pause and resume without crashing.</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Client-side Telemetry Engine -->
  <script>
    (function () {
      let selectedRange = "1h";
      let isFetching = false;
      let cachedConfig = null;

      // DOM Elements
      const healthBadge = document.getElementById("healthBadge");
      const clockDisplay = document.getElementById("clockDisplay");

      const threadPrimary = document.getElementById("threadPrimary");
      const threadSecondary = document.getElementById("threadSecondary");
      const threadBar = document.getElementById("threadBar");
      const threadWarnMarker = document.getElementById("threadWarnMarker");
      const threadWarnFooter = document.getElementById("threadWarnFooter");
      const threadStatusBadge = document.getElementById("threadStatusBadge");

      const burstPrimary = document.getElementById("burstPrimary");
      const burstSecondary = document.getElementById("burstSecondary");
      const burstBar = document.getElementById("burstBar");
      const burstSoftMarker = document.getElementById("burstSoftMarker");
      const burstSoftFooter = document.getElementById("burstSoftFooter");
      const burstStatusBadge = document.getElementById("burstStatusBadge");

      const sustainedPrimary = document.getElementById("sustainedPrimary");
      const sustainedSecondary = document.getElementById("sustainedSecondary");
      const sustainedBar = document.getElementById("sustainedBar");
      const sustainedWarnMarker = document.getElementById("sustainedWarnMarker");
      const sustainedWarnFooter = document.getElementById("sustainedWarnFooter");
      const sustainedStatusBadge = document.getElementById("sustainedStatusBadge");

      const circuitBadge = document.getElementById("circuitBadge");
      const queueDelayPrimary = document.getElementById("queueDelayPrimary");
      const queueBar = document.getElementById("queueBar");
      const queueTokensFooter = document.getElementById("queueTokensFooter");
      const cooldownFooter = document.getElementById("cooldownFooter");

      const activeSessionsCount = document.getElementById("activeSessionsCount");
      const sessionsTableBody = document.getElementById("sessionsTableBody");

      const chartSvg = document.getElementById("chartSvg");
      const chartTooltip = document.getElementById("chartTooltip");
      const chartWrapper = document.getElementById("chartWrapper");

      // Setup Accordion toggles
      document.querySelectorAll(".accordion-toggle").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const item = this.parentElement;
          item.classList.toggle("open");
        });
      });

      // Setup Range Selector buttons
      document.querySelectorAll(".range-btn").forEach(function (btn) {
        btn.addEventListener("click", function () {
          document.querySelectorAll(".range-btn").forEach(function (b) { b.classList.remove("active"); });
          this.classList.add("active");
          selectedRange = this.getAttribute("data-range");
          fetchMetrics();
        });
      });

      // Clock update
      function updateClock() {
        const now = new Date();
        const utcStr = now.toISOString().substring(11, 19) + " UTC";
        const localStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        clockDisplay.textContent = localStr + " (" + utcStr + ")";
      }
      setInterval(updateClock, 1000);
      updateClock();

      // Main metrics poll
      async function fetchMetrics() {
        if (isFetching) return;
        isFetching = true;
        try {
          const res = await fetch("/api/metrics?range=" + encodeURIComponent(selectedRange));
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          renderDashboard(data);
        } catch (err) {
          // Subtle offline indicator
          healthBadge.className = "health-pill health-warning";
          healthBadge.textContent = "OFFLINE";
        } finally {
          isFetching = false;
        }
      }

      function updateSystemPrimerConstants(cfg) {
        if (cachedConfig && cachedConfig.burstMaxTurns === cfg.burstMaxTurns && cachedConfig.sustainedMaxTurns === cfg.sustainedMaxTurns) {
          return;
        }
        cachedConfig = cfg;

        const maxTurnsEls = document.querySelectorAll(".cfg-max-turns");
        maxTurnsEls.forEach(function (el) { el.textContent = String(cfg.maxNumUserMessagesInConversation); });

        const burstMaxEls = document.querySelectorAll(".cfg-burst-max");
        burstMaxEls.forEach(function (el) { el.textContent = String(cfg.burstMaxTurns); });

        const burstSoftEls = document.querySelectorAll(".cfg-burst-soft");
        burstSoftEls.forEach(function (el) { el.textContent = String(cfg.burstSoftTurns); });

        const sustainedMaxEls = document.querySelectorAll(".cfg-sustained-max");
        sustainedMaxEls.forEach(function (el) { el.textContent = String(cfg.sustainedMaxTurns); });

        const sustainedWarnEls = document.querySelectorAll(".cfg-sustained-warn");
        sustainedWarnEls.forEach(function (el) { el.textContent = String(cfg.sustainedWarnTurns); });

        const spacingSecEls = document.querySelectorAll(".cfg-spacing-sec");
        const spacingSec = (cfg.newSessionSpacingMs || cfg.minSpacingMs || 0) / 1000;
        spacingSecEls.forEach(function (el) { el.textContent = String(spacingSec); });

        const bucketCapacityEls = document.querySelectorAll(".cfg-bucket-capacity");
        bucketCapacityEls.forEach(function (el) { el.textContent = String(cfg.sessionBucketCapacity); });

        const refillSecEls = document.querySelectorAll(".cfg-refill-sec");
        const refillSec = (cfg.sessionRefillMs || 0) / 1000;
        refillSecEls.forEach(function (el) { el.textContent = String(refillSec); });

        const cooldownSecEls = document.querySelectorAll(".cfg-throttle-cooldown-sec");
        cooldownSecEls.forEach(function (el) { el.textContent = String(cfg.throttleCooldownSec); });

        const cooldownMinEls = document.querySelectorAll(".cfg-throttle-cooldown-min");
        const cooldownMin = Math.round((cfg.throttleCooldownSec || 0) / 60);
        cooldownMinEls.forEach(function (el) { el.textContent = String(cooldownMin); });

        const maxRetryEls = document.querySelectorAll(".cfg-max-retry");
        maxRetryEls.forEach(function (el) { el.textContent = String(cfg.maxRetryAfterSec); });
      }

      function renderDashboard(data) {
        const cfg = data.config;
        if (!cfg) return;

        updateSystemPrimerConstants(cfg);

        // 1. Health Status
        const health = (data.health || "healthy").toLowerCase();
        healthBadge.className = "health-pill health-" + health;
        healthBadge.textContent = health.toUpperCase();

        // 2. Thread Creation Rate (10m)
        const freshSessions = (data.governor && data.governor.tenMinute && data.governor.tenMinute.freshSessions) || 0;
        const sessionDangerThreshold = cfg.sessionDangerThreshold10m || cfg.sessionDanger10m;
        const sessionWarnThreshold = cfg.sessionWarnThreshold10m || cfg.sessionWarn10m;

        threadPrimary.textContent = String(freshSessions);
        threadSecondary.textContent = "/ " + sessionDangerThreshold + " max";
        threadWarnFooter.textContent = "Warn: " + sessionWarnThreshold;

        const threadRatio = Math.min(1, sessionDangerThreshold > 0 ? freshSessions / sessionDangerThreshold : 0);
        threadBar.style.width = (threadRatio * 100) + "%";

        if (sessionDangerThreshold > 0) {
          const warnMarkerPercent = (sessionWarnThreshold / sessionDangerThreshold) * 100;
          threadWarnMarker.style.left = warnMarkerPercent + "%";
        }

        if (freshSessions >= sessionDangerThreshold) {
          threadBar.style.background = "var(--rose)";
          threadStatusBadge.className = "badge badge-rose";
          threadStatusBadge.textContent = "Danger";
        } else if (freshSessions >= sessionWarnThreshold) {
          threadBar.style.background = "var(--amber)";
          threadStatusBadge.className = "badge badge-amber";
          threadStatusBadge.textContent = "Guarded";
        } else {
          threadBar.style.background = "var(--emerald)";
          threadStatusBadge.className = "badge badge-emerald";
          threadStatusBadge.textContent = "Safe";
        }

        // 3. Turn Burst (10m)
        const burstTurns = (data.governor && data.governor.tenMinute && data.governor.tenMinute.turns) || 0;
        const burstMax = cfg.burstMaxTurns;
        const burstSoft = cfg.burstSoftTurns;

        burstPrimary.textContent = String(burstTurns);
        burstSecondary.textContent = "/ " + burstMax + " max";
        burstSoftFooter.textContent = "Soft: " + burstSoft;

        const burstRatio = Math.min(1, burstMax > 0 ? burstTurns / burstMax : 0);
        burstBar.style.width = (burstRatio * 100) + "%";

        if (burstMax > 0) {
          const softMarkerPercent = (burstSoft / burstMax) * 100;
          burstSoftMarker.style.left = softMarkerPercent + "%";
        }

        if (burstTurns >= burstMax) {
          burstBar.style.background = "var(--rose)";
          burstStatusBadge.className = "badge badge-rose";
          burstStatusBadge.textContent = "Danger";
        } else if (burstTurns >= burstSoft) {
          burstBar.style.background = "var(--amber)";
          burstStatusBadge.className = "badge badge-amber";
          burstStatusBadge.textContent = "Guarded";
        } else {
          burstBar.style.background = "var(--cyan)";
          burstStatusBadge.className = "badge badge-emerald";
          burstStatusBadge.textContent = "Safe";
        }

        // 4. Sustained Turns (60m)
        const sustainedTurns = (data.governor && data.governor.sixtyMinute && data.governor.sixtyMinute.turns) || 0;
        const sustainedMax = cfg.sustainedMaxTurns;
        const sustainedWarn = cfg.sustainedWarnTurns;

        sustainedPrimary.textContent = String(sustainedTurns);
        sustainedSecondary.textContent = "/ " + sustainedMax + " max";
        sustainedWarnFooter.textContent = "Warn: " + sustainedWarn;

        const sustainedRatio = Math.min(1, sustainedMax > 0 ? sustainedTurns / sustainedMax : 0);
        sustainedBar.style.width = (sustainedRatio * 100) + "%";

        if (sustainedMax > 0) {
          const sustainedMarkerPercent = (sustainedWarn / sustainedMax) * 100;
          sustainedWarnMarker.style.left = sustainedMarkerPercent + "%";
        }

        if (sustainedTurns >= sustainedMax) {
          sustainedBar.style.background = "var(--rose)";
          sustainedStatusBadge.className = "badge badge-rose";
          sustainedStatusBadge.textContent = "Danger";
        } else if (sustainedTurns >= sustainedWarn) {
          sustainedBar.style.background = "var(--amber)";
          sustainedStatusBadge.className = "badge badge-amber";
          sustainedStatusBadge.textContent = "Guarded";
        } else {
          sustainedBar.style.background = "var(--cyan)";
          sustainedStatusBadge.className = "badge badge-emerald";
          sustainedStatusBadge.textContent = "Safe";
        }

        // 5. Circuit Shield & Stagger Queue
        const isArmed = data.circuitBreaker && data.circuitBreaker.isArmed;
        const remainingCooldown = (data.circuitBreaker && data.circuitBreaker.remainingCooldownSec) || 0;
        const queueDelaySec = ((data.staggerQueue && data.staggerQueue.delayMs) || 0) / 1000;
        const sessionTokens = (data.staggerQueue && data.staggerQueue.sessionTokens) != null ? data.staggerQueue.sessionTokens : 0;
        const tokenCapacity = (data.staggerQueue && data.staggerQueue.tokenCapacity) != null ? data.staggerQueue.tokenCapacity : cfg.sessionBucketCapacity;

        if (isArmed) {
          circuitBadge.className = "badge badge-rose";
          circuitBadge.textContent = "ARMED";
          cooldownFooter.textContent = "Remaining: " + remainingCooldown + "s";
          cooldownFooter.style.color = "var(--rose)";
        } else {
          circuitBadge.className = "badge badge-emerald";
          circuitBadge.textContent = "DISARMED";
          cooldownFooter.textContent = "Cooldown: " + cfg.throttleCooldownSec + "s";
          cooldownFooter.style.color = "var(--text-dim)";
        }

        queueDelayPrimary.textContent = queueDelaySec.toFixed(1) + "s";
        queueTokensFooter.textContent = "Tokens: " + sessionTokens + " / " + tokenCapacity;

        const queueCapacity = cfg.newSessionSpacingMs || cfg.minSpacingMs || 15000;
        const queueFillRatio = Math.min(1, queueCapacity > 0 ? (data.staggerQueue.delayMs || 0) / queueCapacity : 0);
        queueBar.style.width = (queueFillRatio * 100) + "%";

        // 6. Active Sessions Table
        const sessions = data.activeSessions || [];
        activeSessionsCount.textContent = sessions.length + " Active";

        if (sessions.length === 0) {
          sessionsTableBody.innerHTML = '<tr><td colspan="4"><div class="empty-state">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>' +
            '<p>No active conversations in memory. Sessions appear when agent requests arrive.</p>' +
            '</div></td></tr>';
        } else {
          let rowsHtml = "";
          for (let i = 0; i < sessions.length; i++) {
            const s = sessions[i];
            const maxTurns = s.maxTurns || cfg.maxNumUserMessagesInConversation;
            const turnPercent = Math.min(100, maxTurns > 0 ? (s.turnCount / maxTurns) * 100 : 0);

            let statusBadgeClass = "badge-slate";
            let statusText = s.status || "idle";
            if (s.status === "streaming") statusBadgeClass = "badge-cyan";
            else if (s.status === "governor") statusBadgeClass = "badge-amber";
            else if (s.status === "stagger") statusBadgeClass = "badge-purple";

            // Relative idle time formatting
            const idleSec = s.idleSeconds || 0;
            let idleStr = idleSec + "s ago";
            if (idleSec >= 60) {
              const idleMin = Math.floor(idleSec / 60);
              idleStr = idleMin + "m ago";
            }

            const cid = s.conversationId || s.sessionId || "—";
            const shortId = cid.length > 20 ? cid.substring(0, 10) + "..." + cid.substring(cid.length - 8) : cid;

            rowsHtml += '<tr>' +
              '<td>' +
                '<div class="conv-id-cell">' +
                  '<span title="' + escapeHtml(cid) + '">' + escapeHtml(shortId) + '</span>' +
                  '<button class="copy-btn" data-copy="' + escapeHtml(cid) + '" title="Copy conversation ID">' +
                    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
                  '</button>' +
                '</div>' +
              '</td>' +
              '<td>' +
                '<div class="table-meter">' +
                  '<div style="display:flex; justify-content:space-between; font-size:0.75rem; font-family:var(--font-mono);">' +
                    '<span>' + s.turnCount + '</span><span style="color:var(--text-dim);">/ ' + maxTurns + '</span>' +
                  '</div>' +
                  '<div class="table-meter-bar">' +
                    '<div class="table-meter-fill" style="width:' + turnPercent + '%;"></div>' +
                  '</div>' +
                '</div>' +
              '</td>' +
              '<td class="mono" style="color:var(--text-muted); font-size:0.8rem;">' + idleStr + '</td>' +
              '<td><span class="badge ' + statusBadgeClass + '">' + escapeHtml(statusText) + '</span></td>' +
            '</tr>';
          }
          sessionsTableBody.innerHTML = rowsHtml;

          // Attach copy event handlers
          sessionsTableBody.querySelectorAll(".copy-btn").forEach(function (btn) {
            btn.addEventListener("click", function () {
              const text = this.getAttribute("data-copy");
              if (navigator.clipboard) {
                navigator.clipboard.writeText(text);
                const originalColor = this.style.color;
                this.style.color = "var(--emerald)";
                const self = this;
                setTimeout(function () { self.style.color = originalColor; }, 1200);
              }
            });
          });
        }

        // 7. Render Pure SVG Chart
        renderSvgChart(data);
      }

      function escapeHtml(str) {
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function renderSvgChart(data) {
        const history = data.history;
        const points = (history && history.points) || [];
        const cfg = data.config;
        if (!points.length || !cfg) return;

        const svgW = 1000;
        const svgH = 240;
        const padL = 48;
        const padR = 24;
        const padT = 20;
        const padB = 30;
        const plotW = svgW - padL - padR;
        const plotH = svgH - padT - padB;

        // Dynamic Y scale maximum based on config thresholds and data points
        const maxTurnsPoint = points.reduce(function (max, p) { return Math.max(max, p.turns || 0); }, 0);
        const maxSessionsPoint = points.reduce(function (max, p) { return Math.max(max, p.newSessions || 0); }, 0);
        const dangerSessions = cfg.sessionDangerThreshold10m || cfg.sessionDanger10m;
        const warnSessions = cfg.sessionWarnThreshold10m || cfg.sessionWarn10m;

        let maxY = Math.max(cfg.burstMaxTurns, dangerSessions, maxTurnsPoint, maxSessionsPoint, 1);
        maxY = Math.ceil(maxY * 1.15); // headroom

        function getX(index) {
          if (points.length <= 1) return padL;
          return padL + (index / (points.length - 1)) * plotW;
        }

        function getY(val) {
          const clamped = Math.min(val, maxY);
          return padT + plotH - (clamped / maxY) * plotH;
        }

        // Risk bands positions
        const yDanger = getY(dangerSessions);
        const yWarn = getY(warnSessions);
        const yZero = getY(0);

        let svgContent = '';

        // Definitions: Gradients and Markers
        svgContent += '<defs>' +
          '<linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="#06b6d4" stop-opacity="0.4"/>' +
            '<stop offset="100%" stop-color="#06b6d4" stop-opacity="0.02"/>' +
          '</linearGradient>' +
          '<filter id="glow" x="-20%" y="-20%" width="140%" height="140%">' +
            '<feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#a855f7" flood-opacity="0.8"/>' +
          '</filter>' +
        '</defs>';

        // Background Risk Zones
        // Safe Zone (< warnSessions)
        const safeH = Math.max(0, yZero - yWarn);
        svgContent += '<rect x="' + padL + '" y="' + yWarn + '" width="' + plotW + '" height="' + safeH + '" fill="rgba(16, 185, 129, 0.05)" />';

        // Guarded Zone (warnSessions to dangerSessions)
        const guardedH = Math.max(0, yWarn - yDanger);
        svgContent += '<rect x="' + padL + '" y="' + yDanger + '" width="' + plotW + '" height="' + guardedH + '" fill="rgba(245, 158, 11, 0.07)" />';

        // Danger Zone (>= dangerSessions)
        const dangerH = Math.max(0, yDanger - padT);
        svgContent += '<rect x="' + padL + '" y="' + padT + '" width="' + plotW + '" height="' + dangerH + '" fill="rgba(244, 63, 94, 0.09)" />';

        // Horizontal Gridlines & Y-Axis Labels
        const gridSteps = [0, warnSessions, dangerSessions, maxY];
        for (let i = 0; i < gridSteps.length; i++) {
          const val = gridSteps[i];
          const y = getY(val);
          svgContent += '<line x1="' + padL + '" y1="' + y + '" x2="' + (padL + plotW) + '" y2="' + y + '" stroke="rgba(35, 47, 69, 0.5)" stroke-dasharray="3,3" />';
          let labelText = String(val);
          let labelFill = "var(--text-dim)";
          if (val === dangerSessions) { labelText = val + " (Danger)"; labelFill = "var(--rose)"; }
          else if (val === warnSessions) { labelText = val + " (Warn)"; labelFill = "var(--amber)"; }
          svgContent += '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" fill="' + labelFill + '" font-size="10" font-family="monospace" text-anchor="end">' + labelText + '</text>';
        }

        // Vertical Bars for New Sessions
        const barWidth = Math.max(2, (plotW / points.length) * 0.45);
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          if (p.newSessions > 0) {
            const x = getX(i) - barWidth / 2;
            const y = getY(p.newSessions);
            const h = yZero - y;
            svgContent += '<rect class="bar-session" data-idx="' + i + '" x="' + x + '" y="' + y + '" width="' + barWidth + '" height="' + h + '" fill="var(--amber)" opacity="0.85" rx="1" />';
          }
        }

        // Turns Area Path and Stroke
        let pathD = 'M ' + getX(0) + ' ' + getY(points[0].turns);
        for (let i = 1; i < points.length; i++) {
          pathD += ' L ' + getX(i) + ' ' + getY(points[i].turns);
        }

        const areaD = pathD + ' L ' + getX(points.length - 1) + ' ' + yZero + ' L ' + getX(0) + ' ' + yZero + ' Z';

        svgContent += '<path d="' + areaD + '" fill="url(#areaGrad)" />';
        svgContent += '<path d="' + pathD + '" fill="none" stroke="var(--cyan)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />';

        // Throttle Markers (Purple Lightning Bolt)
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          if (p.throttles > 0) {
            const tx = getX(i);
            const ty = Math.max(padT + 12, getY(p.turns) - 10);
            svgContent += '<g transform="translate(' + (tx - 6) + ',' + (ty - 8) + ')" filter="url(#glow)">' +
              '<path d="M7 1L1 8h5l-1 7 7-8H7l1-6z" fill="var(--purple)" stroke="#ffffff" stroke-width="0.75" />' +
            '</g>';
          }
        }

        // Interactive Hover Crosshair (hidden initially)
        svgContent += '<line id="chartCrosshair" x1="0" y1="' + padT + '" x2="0" y2="' + (padT + plotH) + '" stroke="#cbd5e1" stroke-width="1.2" stroke-dasharray="3,3" opacity="0" pointer-events="none" />';
        svgContent += '<circle id="chartHoverDot" cx="0" cy="0" r="4.5" fill="#ffffff" stroke="var(--cyan)" stroke-width="2.5" opacity="0" pointer-events="none" />';

        // Transparent Overlay to capture mouse events
        svgContent += '<rect id="chartEventOverlay" x="' + padL + '" y="' + padT + '" width="' + plotW + '" height="' + plotH + '" fill="transparent" pointer-events="all" style="cursor:crosshair;" />';

        chartSvg.innerHTML = svgContent;

        // Attach Mouse Hover Events on Overlay
        const overlay = document.getElementById("chartEventOverlay");
        const crosshair = document.getElementById("chartCrosshair");
        const hoverDot = document.getElementById("chartHoverDot");

        function handlePointer(evt) {
          const rect = chartSvg.getBoundingClientRect();
          const clientX = evt.clientX || (evt.touches && evt.touches[0] && evt.touches[0].clientX);
          if (!clientX) return;

          const mouseSvgX = ((clientX - rect.left) / rect.width) * svgW;
          const clampedX = Math.max(padL, Math.min(padL + plotW, mouseSvgX));
          const ratio = (clampedX - padL) / plotW;
          const index = Math.round(ratio * (points.length - 1));
          const p = points[index];
          if (!p) return;

          const pointX = getX(index);
          const pointY = getY(p.turns);

          crosshair.setAttribute("x1", pointX);
          crosshair.setAttribute("x2", pointX);
          crosshair.setAttribute("opacity", "0.85");

          hoverDot.setAttribute("cx", pointX);
          hoverDot.setAttribute("cy", pointY);
          hoverDot.setAttribute("opacity", "1");

          // Tooltip formatting
          const date = new Date(p.timestamp);
          const timeUtc = date.toISOString().substring(11, 16) + " UTC";
          const timeLocal = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const delaySec = ((p.maxPacingDelayMs || 0) / 1000).toFixed(1);

          chartTooltip.innerHTML = '<div style="font-weight:700; color:var(--text-main); margin-bottom:4px;">' + timeLocal + ' (' + timeUtc + ')</div>' +
            '<div style="display:flex; justify-content:space-between; gap:12px;"><span style="color:var(--cyan);">Turns:</span><strong>' + p.turns + '</strong></div>' +
            '<div style="display:flex; justify-content:space-between; gap:12px;"><span style="color:var(--amber);">New Sessions:</span><strong>' + p.newSessions + '</strong></div>' +
            '<div style="display:flex; justify-content:space-between; gap:12px;"><span style="color:var(--text-dim);">Pacing Delay:</span><strong>' + delaySec + 's</strong></div>' +
            (p.throttles > 0 ? '<div style="display:flex; justify-content:space-between; gap:12px; color:var(--purple);"><span>Throttles:</span><strong>' + p.throttles + ' ⚡</strong></div>' : '');

          chartTooltip.style.opacity = "1";

          // Position tooltip relative to container
          const wrapperRect = chartWrapper.getBoundingClientRect();
          const tooltipW = chartTooltip.offsetWidth || 150;
          let leftPx = (clientX - wrapperRect.left) + 12;
          if (leftPx + tooltipW > wrapperRect.width - 10) {
            leftPx = (clientX - wrapperRect.left) - tooltipW - 12;
          }
          chartTooltip.style.left = Math.max(10, leftPx) + "px";
          chartTooltip.style.top = "15px";
        }

        function hidePointer() {
          crosshair.setAttribute("opacity", "0");
          hoverDot.setAttribute("opacity", "0");
          chartTooltip.style.opacity = "0";
        }

        overlay.addEventListener("mousemove", handlePointer);
        overlay.addEventListener("touchmove", handlePointer, { passive: true });
        overlay.addEventListener("mouseleave", hidePointer);
        overlay.addEventListener("touchend", hidePointer);
      }

      // Initial fetch immediately on DOM ready
      document.addEventListener("DOMContentLoaded", function () {
        fetchMetrics();
        setInterval(fetchMetrics, 2000);
      });
    })();
  </script>
</body>
</html>`;
}
