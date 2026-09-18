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

    .chart-controls {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .btn-group {
      display: flex;
      background: #0f172a;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 3px;
      gap: 3px;
    }

    .btn {
      background: transparent;
      border: none;
      color: var(--text-dim);
      padding: 0.35rem 0.85rem;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
    }

    .btn-sm {
      padding: 0.25rem 0.65rem;
      font-size: 0.775rem;
    }

    .btn:hover {
      color: var(--text-main);
    }

    .btn.active {
      background: var(--card-header);
      color: var(--cyan);
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
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
      position: relative;
      overflow: hidden;
      border-radius: 8px;
    }

    .split-view-container {
      display: flex;
      flex-direction: column;
      gap: 0.85rem;
      width: 100%;
    }

    .split-chart-pane {
      background: rgba(15, 23, 42, 0.45);
      border: 1px solid rgba(35, 47, 69, 0.55);
      border-radius: 8px;
      padding: 0.5rem 0.65rem 0.35rem;
      position: relative;
    }

    .split-chart-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.25rem;
      padding: 0 0.4rem;
      font-size: 0.775rem;
    }

    .split-chart-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .split-chart-tag {
      font-weight: 700;
      font-family: var(--font-mono);
      font-size: 0.8rem;
      letter-spacing: 0.03em;
    }

    .split-chart-desc {
      font-size: 0.725rem;
      color: var(--text-dim);
    }

    .split-chart-axis-info {
      font-size: 0.725rem;
      font-family: var(--font-mono);
      color: var(--text-muted);
    }

    .split-svg-wrap {
      width: 100%;
      height: 150px;
      overflow: hidden;
      position: relative;
    }

    .combined-view-container {
      width: 100%;
      height: 240px;
      overflow: hidden;
      position: relative;
    }

    .chart-svg {
      width: 100%;
      height: 100%;
      overflow: hidden;
      display: block;
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
      white-space: nowrap;
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

      <!-- Card 4: Circuit Shield & Gatekeeper -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">
            Circuit Shield &amp; Gatekeeper
            <span class="tooltip-container">
              <button class="tooltip-btn" aria-label="Info">ⓘ</button>
              <span class="tooltip-text">Monitors local circuit breaker state, the Priority FIFO Turn Gatekeeper (1.5s wire pacing), and the initial session stagger queue. Intercepts traffic locally during cooldown to protect Microsoft account quota.</span>
            </span>
          </span>
          <span id="circuitBadge" class="badge badge-emerald">DISARMED</span>
        </div>
        <div class="metric-value-row">
          <span id="queueDelayPrimary" class="metric-primary">0</span>
          <span id="queueDelaySecondary" class="metric-secondary">queued turns</span>
        </div>
        <div class="progress-container">
          <div id="queueBar" class="progress-bar" style="background: var(--purple);"></div>
        </div>
        <div class="card-footer-info">
          <span id="queueTokensFooter">Tokens: —</span>
          <span id="cooldownFooter" class="mono">Cooldown: 0s</span>
        </div>
      </div>

      <!-- Card 5: Turn Quality & Yield (60m) -->
      <div class="card">
        <div class="card-header">
          <span class="card-title">
            Turn Quality &amp; Yield (60m)
            <span class="tooltip-container">
              <button class="tooltip-btn" aria-label="Info">ⓘ</button>
              <span class="tooltip-text">Tracks model turn compliance and quota efficiency over a rolling 60-minute window. First-Pass Yield (FPY) is the % of turns solved on Attempt 0 with zero retries. Wire Multiplier shows upstream turns burned per client request.</span>
            </span>
          </span>
          <span id="qualityStatusBadge" class="badge badge-emerald">Optimal</span>
        </div>
        <div class="metric-value-row">
          <span id="fpyPrimary" class="metric-primary">100%</span>
          <span id="wireMultiplierSecondary" class="metric-secondary">· 1.00x wire</span>
        </div>
        <div class="progress-container">
          <div id="qualityBar" class="progress-bar" style="background: var(--emerald);"></div>
        </div>
        <div class="card-footer-info">
          <span id="qualityBreakdownFooter">Clean: 0 · Salvaged: 0 · Refused: 0</span>
          <span id="qualityReqsFooter" class="mono">0 reqs</span>
        </div>
      </div>
    </div>

    <!-- Historical Timeline & Risk Zones -->
    <div class="section-card">
      <div class="section-header">
        <div>
          <div class="section-title">
            <span>Historical Timeline &amp; Risk Zones · Cumulative Rolling 10-Minute Velocity (Upstream Sliding Window)</span>
          </div>
          <div style="font-size: 0.775rem; color: var(--text-dim); margin-top: 2px;">
            Displays the rolling 10m load evaluated by Microsoft's leaky bucket limiters at each point in time.
          </div>
        </div>
        <div class="chart-controls">
          <div class="btn-group view-toggle">
            <button class="btn btn-sm active" id="viewSplitBtn" title="Split into dedicated synchronized charts for Turns and Sessions">⊞ Split View</button>
            <button class="btn btn-sm" id="viewCombinedBtn" title="Composite both series onto one dual-axis chart">⊡ Combined</button>
          </div>
          <div class="btn-group range-toggle">
            <button class="btn btn-sm active" data-range="1h">1h</button>
            <button class="btn btn-sm" data-range="6h">6h</button>
            <button class="btn btn-sm" data-range="24h">24h</button>
          </div>
        </div>
      </div>

      <div class="chart-container" id="chartWrapper">
        <div id="splitViewContainer" class="split-view-container">
          <div class="split-chart-pane">
            <div class="split-chart-header">
              <div class="split-chart-title">
                <span class="split-chart-tag" style="color: var(--cyan);">◀ TURNS</span>
                <span class="split-chart-desc">Rolling 10m Velocity · Leaky Bucket Burst Horizon</span>
              </div>
              <span id="splitTurnsCeiling" class="split-chart-axis-info">Left Axis: 0-40</span>
            </div>
            <div class="split-svg-wrap">
              <svg class="chart-svg" id="chartSvgTurns" preserveAspectRatio="none" viewBox="0 0 1000 150"></svg>
            </div>
          </div>
          <div class="split-chart-pane">
            <div class="split-chart-header">
              <div class="split-chart-title">
                <span class="split-chart-tag" style="color: var(--amber);">◀ FRESH SESSIONS</span>
                <span class="split-chart-desc">Turn 0 Handshake Rate · New Session Stagger Rate</span>
              </div>
              <span id="splitSessionsCeiling" class="split-chart-axis-info">Left Axis: 0-20</span>
            </div>
            <div class="split-svg-wrap">
              <svg class="chart-svg" id="chartSvgSessions" preserveAspectRatio="none" viewBox="0 0 1000 150"></svg>
            </div>
          </div>
        </div>

        <div id="combinedViewContainer" class="combined-view-container" style="display: none;">
          <svg class="chart-svg" id="chartSvg" preserveAspectRatio="none" viewBox="0 0 1000 240"></svg>
        </div>

        <div class="chart-tooltip" id="chartTooltip"></div>
      </div>

      <div class="chart-legend">
        <div class="legend-item">
          <div class="legend-color" style="background: var(--cyan);"></div>
          <span id="legendTurnsLabel">Turns Filled Area (Left Axis: 0-40)</span>
        </div>
        <div class="legend-item">
          <div class="legend-color" style="background: var(--amber);"></div>
          <span id="legendSessionsLabel">New Sessions (Turn 0) · Right Axis: 0-20</span>
        </div>
        <div class="legend-item">
          <div class="legend-color" style="background: var(--purple);"></div>
          <span>⚡ Upstream Throttle (PerScenario / PerUser)</span>
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
            <span>What are Microsoft's two distinct throttling horizons (Thread Creation vs Turn Volume)?</span>
            <svg class="accordion-chevron" viewBox="0 0 24 24" fill="none" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <div class="accordion-content">
            <p>Empirical reverse engineering reveals that Microsoft enforces rate limits across two distinct operational horizons rather than raw prompt tokens:</p>
            <p>1. <strong>Thread Creation Rate Limit (<span class="highlight-param">PerScenarioThrottled</span>):</strong> Tracks <em>conversations started per unit time</em>. Tripping it signals explicit <span class="highlight-param">PerScenarioThrottled</span> completion frames when fresh thread creation exceeds roughly 15–20 conversations per 10 minutes. A single persistent session running dozens of tool turns rarely trips this limit, but rapid subagent spawning burns it immediately.</p>
            <p>2. <strong>Hourly Turn Volume Ceiling (<span class="highlight-param">PerUserThrottled</span>):</strong> Enforces a hard account ceiling of ~120 turns in a 60-minute rolling window across all active threads. Exceeding this ceiling arms account-wide throttling (<span class="highlight-param">PerUserThrottled</span>) regardless of how many distinct sessions are open.</p>
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
            <p>Requests pass through the <strong>Priority FIFO Turn Gatekeeper</strong>, which enforces strict single-file serialization with a minimum 1500ms wire pacing (<span class="highlight-param">M365_MIN_TURN_SPACING_MS = 1500</span>) to eliminate thundering-herd bursts. The gatekeeper re-evaluates live dual-horizon sliding window limits before dispatching each turn. Forcing retries (<span class="highlight-param">attempt &gt; 0</span>) receive head-of-queue priority so recovering turns execute without waiting behind newer requests.</p>
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
            <p>When upstream rate limiting or consecutive empty responses are detected, the proxy arms a local circuit breaker shield with tailored cooldown periods:</p>
            <p>• <strong>Thread Creation Throttle (<span class="highlight-param">PerScenarioThrottled</span>):</strong> Arms an 1800s (30-minute) cooldown by default (<span class="highlight-param">M365_THROTTLE_COOLDOWN_SEC</span>) to allow upstream scenario buckets to recharge.</p>
            <p>• <strong>Account Turn Throttle (<span class="highlight-param">PerUserThrottled</span>):</strong> Arms a 1200s (20-minute) cooldown by default (<span class="highlight-param">M365_USER_THROTTLE_COOLDOWN_SEC</span>) to clear the rolling hourly turn quota.</p>
            <p>During cooldown, the proxy locally intercepts requests and returns <span class="highlight-param">HTTP 429 Too Many Requests</span> with a client <span class="highlight-param">Retry-After: <span class="cfg-max-retry">—</span></span> header. <strong>Zero requests reach Microsoft during this window</strong>, allowing upstream limiters to recharge while client agents automatically pause and resume without crashing.</p>
          </div>
        </div>

        <!-- Section 6 -->
        <div class="accordion-item">
          <button class="accordion-toggle" type="button">
            <span>What is First-Pass Yield and why does the Wire Multiplier matter?</span>
            <svg class="accordion-chevron" viewBox="0 0 24 24" fill="none" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <div class="accordion-content">
            <p>When an agent sends a request, the proxy attempts to execute it in 1 turn. However, if the upstream model confabulates that tools are unavailable or produces an empty response, the proxy transparently salvages the turn using forced continuation prompts.</p>
            <p><strong>First-Pass Yield (FPY)</strong> measures the percentage of client requests that succeed on Attempt 0 without any retries. <strong>Salvaged turns</strong> succeed from the client's perspective but burn 2 or 3 upstream wire turns. The <strong>Wire Multiplier</strong> ($\frac{\text{wire turns}}{\text{client requests}}$) reveals this hidden multiplier, explaining why account turn quota may deplete faster than the number of user prompts sent.</p>
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
      const queueDelaySecondary = document.getElementById("queueDelaySecondary");
      const queueBar = document.getElementById("queueBar");
      const queueTokensFooter = document.getElementById("queueTokensFooter");
      const cooldownFooter = document.getElementById("cooldownFooter");

      const fpyPrimary = document.getElementById("fpyPrimary");
      const wireMultiplierSecondary = document.getElementById("wireMultiplierSecondary");
      const qualityStatusBadge = document.getElementById("qualityStatusBadge");
      const qualityBar = document.getElementById("qualityBar");
      const qualityBreakdownFooter = document.getElementById("qualityBreakdownFooter");
      const qualityReqsFooter = document.getElementById("qualityReqsFooter");

      const activeSessionsCount = document.getElementById("activeSessionsCount");
      const sessionsTableBody = document.getElementById("sessionsTableBody");

      const chartSvg = document.getElementById("chartSvg");
      const chartSvgTurns = document.getElementById("chartSvgTurns");
      const chartSvgSessions = document.getElementById("chartSvgSessions");
      const chartTooltip = document.getElementById("chartTooltip");
      const chartWrapper = document.getElementById("chartWrapper");
      const splitViewContainer = document.getElementById("splitViewContainer");
      const combinedViewContainer = document.getElementById("combinedViewContainer");
      const viewSplitBtn = document.getElementById("viewSplitBtn");
      const viewCombinedBtn = document.getElementById("viewCombinedBtn");

      let lastMetricsData = null;
      let viewMode = "split";
      try {
        const savedView = localStorage.getItem("proxy_dashboard_view_mode");
        if (savedView === "combined" || savedView === "split") {
          viewMode = savedView;
        }
      } catch (e) {}

      function applyViewMode() {
        if (viewMode === "split") {
          if (viewSplitBtn) viewSplitBtn.classList.add("active");
          if (viewCombinedBtn) viewCombinedBtn.classList.remove("active");
          if (splitViewContainer) splitViewContainer.style.display = "flex";
          if (combinedViewContainer) combinedViewContainer.style.display = "none";
        } else {
          if (viewSplitBtn) viewSplitBtn.classList.remove("active");
          if (viewCombinedBtn) viewCombinedBtn.classList.add("active");
          if (splitViewContainer) splitViewContainer.style.display = "none";
          if (combinedViewContainer) combinedViewContainer.style.display = "block";
        }
      }

      applyViewMode();

      if (viewSplitBtn) {
        viewSplitBtn.addEventListener("click", function () {
          viewMode = "split";
          try { localStorage.setItem("proxy_dashboard_view_mode", "split"); } catch (e) {}
          applyViewMode();
          if (lastMetricsData) renderSvgChart(lastMetricsData);
        });
      }
      if (viewCombinedBtn) {
        viewCombinedBtn.addEventListener("click", function () {
          viewMode = "combined";
          try { localStorage.setItem("proxy_dashboard_view_mode", "combined"); } catch (e) {}
          applyViewMode();
          if (lastMetricsData) renderSvgChart(lastMetricsData);
        });
      }

      // Setup Accordion toggles
      document.querySelectorAll(".accordion-toggle").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const item = this.parentElement;
          item.classList.toggle("open");
        });
      });

      // Setup Range Selector buttons
      document.querySelectorAll(".range-toggle button, .range-btn, [data-range]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          document.querySelectorAll(".range-toggle button, .range-btn, [data-range]").forEach(function (b) { b.classList.remove("active"); });
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

        // 5. Circuit Shield & Gatekeeper
        const isArmed = data.circuitBreaker && data.circuitBreaker.isArmed;
        const remainingCooldown = (data.circuitBreaker && data.circuitBreaker.remainingCooldownSec) || 0;
        const throttleReason = (data.circuitBreaker && data.circuitBreaker.reason) || "";
        const tQueue = data.turnQueue || { depth: 0, priorityCount: 0, minSpacingMs: 1500, isProcessing: false };
        const queueDelaySec = ((data.staggerQueue && data.staggerQueue.delayMs) || 0) / 1000;
        const sessionTokens = (data.staggerQueue && data.staggerQueue.sessionTokens) != null ? data.staggerQueue.sessionTokens : 0;
        const tokenCapacity = (data.staggerQueue && data.staggerQueue.tokenCapacity) != null ? data.staggerQueue.tokenCapacity : cfg.sessionBucketCapacity;

        if (isArmed) {
          circuitBadge.className = "badge badge-rose";
          circuitBadge.textContent = throttleReason ? "ARMED (" + throttleReason + ")" : "ARMED";
          queueDelayPrimary.textContent = remainingCooldown + "s";
          if (queueDelaySecondary) queueDelaySecondary.textContent = "cooldown remaining";
          queueBar.style.background = "var(--rose)";
          const activeCooldownSec = throttleReason === "PerUserThrottled" ? (cfg.userThrottleCooldownSec || 1200) : (cfg.throttleCooldownSec || 1800);
          const cooldownRatio = Math.min(1, activeCooldownSec > 0 ? remainingCooldown / activeCooldownSec : 1);
          queueBar.style.width = (cooldownRatio * 100) + "%";
          queueTokensFooter.textContent = "Shield: Active (" + (throttleReason || "Throttled") + ")";
          cooldownFooter.textContent = "Queued: " + tQueue.depth + " turns";
          cooldownFooter.style.color = "var(--rose)";
        } else {
          circuitBadge.className = "badge badge-emerald";
          circuitBadge.textContent = "DISARMED";
          queueDelayPrimary.textContent = String(tQueue.depth);
          if (queueDelaySecondary) {
            queueDelaySecondary.textContent = tQueue.priorityCount > 0
              ? "queued (" + tQueue.priorityCount + " retries)"
              : "queued turns (" + (tQueue.minSpacingMs / 1000).toFixed(1) + "s pacing)";
          }
          queueBar.style.background = "var(--purple)";
          const queueFillRatio = Math.min(1, tQueue.depth > 0 ? tQueue.depth / 5 : (data.staggerQueue.delayMs || 0) / 15000);
          queueBar.style.width = (queueFillRatio * 100) + "%";
          queueTokensFooter.textContent = "Tokens: " + sessionTokens + " / " + tokenCapacity;
          cooldownFooter.textContent = "Cooldowns: 30m / 20m";
          cooldownFooter.style.color = "var(--text-dim)";
        }

        // 6. Turn Quality & Yield (60m)
        const quality = data.quality || {
          clientRequests: 0,
          wireTurns: 0,
          cleanTurns: 0,
          salvagedTurns: 0,
          refusedTurns: 0,
          firstPassYieldPercent: 100,
          salvageRatePercent: 0,
          refusalRatePercent: 0,
          wireMultiplier: 1.0,
        };

        if (fpyPrimary) fpyPrimary.textContent = quality.firstPassYieldPercent.toFixed(0) + "%";
        if (wireMultiplierSecondary) wireMultiplierSecondary.textContent = "· " + quality.wireMultiplier.toFixed(2) + "x wire";

        if (qualityBar) {
          qualityBar.style.width = Math.max(5, quality.firstPassYieldPercent) + "%";
          if (quality.firstPassYieldPercent >= 85) {
            qualityBar.style.background = "var(--emerald)";
            if (qualityStatusBadge) {
              qualityStatusBadge.className = "badge badge-emerald";
              qualityStatusBadge.textContent = "Optimal";
            }
          } else if (quality.firstPassYieldPercent >= 70) {
            qualityBar.style.background = "var(--amber)";
            if (qualityStatusBadge) {
              qualityStatusBadge.className = "badge badge-amber";
              qualityStatusBadge.textContent = "Guarded";
            }
          } else {
            qualityBar.style.background = "var(--rose)";
            if (qualityStatusBadge) {
              qualityStatusBadge.className = "badge badge-rose";
              qualityStatusBadge.textContent = "Degraded";
            }
          }
        }

        if (qualityBreakdownFooter) {
          qualityBreakdownFooter.textContent =
            "Clean: " + quality.cleanTurns + " · Salvaged: " + quality.salvagedTurns + " · Refused: " + quality.refusedTurns;
        }
        if (qualityReqsFooter) {
          qualityReqsFooter.textContent = quality.clientRequests + " reqs (" + quality.wireTurns + " wire)";
        }

        // 7. Active Sessions Table
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

        lastMetricsData = data;
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

        // 1. Compute rolling 10m window metrics (sum of up to 10 previous 1-minute points)
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

        // Left Axis: Turns (Cyan)
        const burstMax = cfg.burstMaxTurns || 35;
        const burstSoft = cfg.burstSoftTurns || Math.max(1, burstMax - 5); // 30
        const pinnedMaxTurns = Math.max(burstMax + 5, 40);
        let maxObservedTurns = 0;
        for (let i = 0; i < points.length; i++) {
          if (points[i].rolling10mTurns > maxObservedTurns) maxObservedTurns = points[i].rolling10mTurns;
          if ((points[i].turns || 0) > maxObservedTurns) maxObservedTurns = points[i].turns;
        }
        const maxTurnsY = Math.max(pinnedMaxTurns, Math.ceil(maxObservedTurns * 1.1));

        // Right Axis: Fresh Sessions (Amber)
        const dangerSessions = cfg.sessionDangerThreshold10m || cfg.sessionDanger10m || 15;
        const warnSessions = cfg.sessionWarnThreshold10m || cfg.sessionWarn10m || 10;
        const pinnedMaxSessions = Math.max(dangerSessions + 5, 20);
        let maxObservedSessions = 0;
        for (let i = 0; i < points.length; i++) {
          if (points[i].rolling10mSessions > maxObservedSessions) maxObservedSessions = points[i].rolling10mSessions;
          if ((points[i].newSessions || 0) > maxObservedSessions) maxObservedSessions = points[i].newSessions;
        }
        const maxSessionsY = Math.max(pinnedMaxSessions, Math.ceil(maxObservedSessions * 1.1));

        // Dynamic legend & subtitle labels
        const legendTurns = document.getElementById("legendTurnsLabel");
        if (legendTurns) legendTurns.textContent = "Turns Filled Area (Left Axis: 0-" + maxTurnsY + ")";
        const legendSessions = document.getElementById("legendSessionsLabel");
        if (legendSessions) legendSessions.textContent = "New Sessions (Turn 0) · Right Axis: 0-" + maxSessionsY + ")";
        const splitTurnsCeil = document.getElementById("splitTurnsCeiling");
        if (splitTurnsCeil) splitTurnsCeil.textContent = "Left Axis: 0-" + maxTurnsY + " · Leaky Bucket Burst Ceiling";
        const splitSessionsCeil = document.getElementById("splitSessionsCeiling");
        if (splitSessionsCeil) splitSessionsCeil.textContent = "Left Axis: 0-" + maxSessionsY + " · Handshake Rate Limit";

        // Zone Badge Helper: Positions badges strictly INSIDE the plot area with safe margin and dark pill
        function renderZoneBadge(x, y, text, color) {
          const charCount = text.length;
          const pillW = charCount * 6.2 + 12;
          const pillH = 16;
          const pillX = x - pillW;
          const pillY = y - 11;
          return '<g class="zone-badge" pointer-events="none">' +
            '<rect x="' + pillX + '" y="' + pillY + '" width="' + pillW + '" height="' + pillH + '" rx="3" fill="rgba(15, 23, 42, 0.72)" stroke="' + color + '" stroke-opacity="0.25" stroke-width="0.5" />' +
            '<text x="' + (x - 6) + '" y="' + y + '" fill="' + color + '" font-size="9" font-family="monospace" font-weight="600" text-anchor="end">' + text + '</text>' +
          '</g>';
        }

        // Shared Tooltip HTML generator
        function getTooltipHtml(p) {
          const date = new Date(p.timestamp);
          const timeUtc = date.toISOString().substring(11, 16) + " UTC";
          const timeLocal = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const delaySec = (p.maxPacingDelayMs > 0 ? (p.maxPacingDelayMs / 1000).toFixed(1) : "0.0") + "s";

          const rTurns = p.rolling10mTurns || 0;
          const rSessions = p.rolling10mSessions || 0;
          const iTurns = p.turns || 0;
          const iSessions = p.newSessions || 0;

          let statusText = "Safe";
          let statusColor = "var(--emerald)";
          if (rTurns >= burstMax || rSessions >= dangerSessions) {
            statusText = "Danger";
            statusColor = "var(--rose)";
          } else if (rTurns >= burstSoft || rSessions >= warnSessions) {
            statusText = "Guarded";
            statusColor = "var(--amber)";
          }

          return '<div style="font-weight:700; color:var(--text-main); margin-bottom:6px; font-size:0.8rem;">' + timeLocal + ' (' + timeUtc + ')</div>' +
            '<div style="display:flex; justify-content:space-between; gap:12px; margin-bottom:2px;"><span style="color:var(--cyan);">Rolling 10m Turns:</span><strong>' + rTurns + ' / ' + burstMax + ' max</strong></div>' +
            '<div style="display:flex; justify-content:space-between; gap:12px; margin-bottom:2px;"><span style="color:var(--amber);">Rolling 10m Sessions:</span><strong>' + rSessions + ' / ' + dangerSessions + ' danger</strong></div>' +
            '<div style="font-size:0.72rem; color:var(--text-dim); margin-bottom:4px; padding-left:2px;">(Discrete 1m Delta: +' + iTurns + ' turns, +' + iSessions + ' sessions)</div>' +
            '<div style="display:flex; justify-content:space-between; gap:12px; margin-bottom:2px;"><span style="color:var(--text-dim);">Pacing Delay:</span><strong>' + delaySec + '</strong></div>' +
            (p.throttles > 0 ? '<div style="display:flex; justify-content:space-between; gap:12px; color:var(--purple); margin-bottom:2px;"><span>Throttles:</span><strong>' + p.throttles + ' ⚡</strong></div>' : '') +
            '<div style="display:flex; justify-content:space-between; gap:12px; margin-top:4px; padding-top:4px; border-top:1px solid rgba(255,255,255,0.1);"><span>Status:</span><strong style="color:' + statusColor + ';">' + statusText + '</strong></div>';
        }

        function positionTooltip(clientX, clientY) {
          const wrapperRect = chartWrapper.getBoundingClientRect();
          const tooltipW = chartTooltip.offsetWidth || 240;
          let leftPx = (clientX - wrapperRect.left) + 14;
          if (leftPx + tooltipW > wrapperRect.width - 10) {
            leftPx = (clientX - wrapperRect.left) - tooltipW - 14;
          }
          chartTooltip.style.left = Math.max(10, leftPx) + "px";

          if (clientY && wrapperRect) {
            let topPx = (clientY - wrapperRect.top) - 40;
            if (topPx < 10) topPx = 15;
            if (topPx + 160 > wrapperRect.height) topPx = Math.max(10, wrapperRect.height - 170);
            chartTooltip.style.top = topPx + "px";
          } else {
            chartTooltip.style.top = "15px";
          }
        }

        /* -------------------------------------------------------------
         * PART A: SPLIT VIEW (Stacked Synchronized Charts)
         * ----------------------------------------------------------- */
        const splitSvgW = 1000;
        const splitSvgH = 150;
        const splitPadL = 56;
        const splitPadR = 24;
        const splitPadT = 16;
        const splitPadB = 22;
        const splitPlotW = splitSvgW - splitPadL - splitPadR;
        const splitPlotH = splitSvgH - splitPadT - splitPadB;
        const splitYZero = splitPadT + splitPlotH;

        function getSplitX(index) {
          if (points.length <= 1) return splitPadL;
          return splitPadL + (index / (points.length - 1)) * splitPlotW;
        }

        function getYTurnSplit(val) {
          const clamped = Math.min(val, maxTurnsY);
          return splitPadT + splitPlotH - (clamped / maxTurnsY) * splitPlotH;
        }

        function getYSessionSplit(val) {
          const clamped = Math.min(val, maxSessionsY);
          return splitPadT + splitPlotH - (clamped / maxSessionsY) * splitPlotH;
        }

        // --- Split Top: Turns ---
        let svgTurns = '<defs>' +
          '<linearGradient id="areaGradTurns" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="#06b6d4" stop-opacity="0.38"/>' +
            '<stop offset="100%" stop-color="#06b6d4" stop-opacity="0.02"/>' +
          '</linearGradient>' +
        '</defs>';

        const yBurstSoftSplit = getYTurnSplit(burstSoft);
        const yBurstMaxSplit = getYTurnSplit(burstMax);

        // Risk bands
        const safeHTurns = Math.max(0, splitYZero - yBurstSoftSplit);
        svgTurns += '<rect x="' + splitPadL + '" y="' + yBurstSoftSplit + '" width="' + splitPlotW + '" height="' + safeHTurns + '" fill="rgba(16, 185, 129, 0.05)" />';
        const guardedHTurns = Math.max(0, yBurstSoftSplit - yBurstMaxSplit);
        svgTurns += '<rect x="' + splitPadL + '" y="' + yBurstMaxSplit + '" width="' + splitPlotW + '" height="' + guardedHTurns + '" fill="rgba(245, 158, 11, 0.07)" />';
        const dangerHTurns = Math.max(0, yBurstMaxSplit - splitPadT);
        svgTurns += '<rect x="' + splitPadL + '" y="' + splitPadT + '" width="' + splitPlotW + '" height="' + dangerHTurns + '" fill="rgba(244, 63, 94, 0.09)" />';

        // Inside-plot Zone Badges
        const badgeXSplit = splitPadL + splitPlotW - 12;
        svgTurns += renderZoneBadge(badgeXSplit, Math.max(splitPadT + 12, splitPadT + dangerHTurns / 2 + 3.5), '🔴 DANGER (≥' + burstMax + ')', 'var(--rose)');
        svgTurns += renderZoneBadge(badgeXSplit, yBurstMaxSplit + guardedHTurns / 2 + 3.5, '🟡 GUARDED (' + burstSoft + '-' + (burstMax - 1) + ')', 'var(--amber)');
        svgTurns += renderZoneBadge(badgeXSplit, yBurstSoftSplit + safeHTurns / 2 + 3.5, '🟢 SAFE (0-' + (burstSoft - 1) + ')', 'var(--emerald)');

        // Gridlines & Clean Numeric Ticks (Zero bleed)
        const leftTicks = [0, 15, burstSoft, burstMax, maxTurnsY];
        const uniqueLeftTicks = Array.from(new Set(leftTicks)).sort(function (a, b) { return a - b; });
        for (let i = 0; i < uniqueLeftTicks.length; i++) {
          const val = uniqueLeftTicks[i];
          const y = getYTurnSplit(val);
          svgTurns += '<line x1="' + splitPadL + '" y1="' + y + '" x2="' + (splitPadL + splitPlotW) + '" y2="' + y + '" stroke="rgba(35, 47, 69, 0.45)" stroke-dasharray="3,3" />';
          let labelFill = "var(--text-dim)";
          if (val === burstMax) labelFill = "var(--rose)";
          else if (val === burstSoft) labelFill = "var(--amber)";
          else if (val === maxTurnsY) labelFill = "var(--cyan)";
          svgTurns += '<text x="' + (splitPadL - 8) + '" y="' + (y + 3.5) + '" fill="' + labelFill + '" font-size="10" font-family="monospace" text-anchor="end">' + val + '</text>';
        }

        // Curves
        let pathDTurns = 'M ' + getSplitX(0) + ' ' + getYTurnSplit(points[0].rolling10mTurns || 0);
        for (let i = 1; i < points.length; i++) {
          pathDTurns += ' L ' + getSplitX(i) + ' ' + getYTurnSplit(points[i].rolling10mTurns || 0);
        }
        const areaDTurns = pathDTurns + ' L ' + getSplitX(points.length - 1) + ' ' + splitYZero + ' L ' + getSplitX(0) + ' ' + splitYZero + ' Z';
        svgTurns += '<path d="' + areaDTurns + '" fill="url(#areaGradTurns)" />';
        svgTurns += '<path d="' + pathDTurns + '" fill="none" stroke="var(--cyan)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />';

        // Crosshair & Hover Dot
        svgTurns += '<line id="crosshairTurn" x1="0" y1="' + splitPadT + '" x2="0" y2="' + splitYZero + '" stroke="#cbd5e1" stroke-width="1.2" stroke-dasharray="3,3" opacity="0" pointer-events="none" />';
        svgTurns += '<circle id="dotTurn" cx="0" cy="0" r="4.5" fill="#ffffff" stroke="var(--cyan)" stroke-width="2.5" opacity="0" pointer-events="none" />';
        svgTurns += '<rect id="overlayTurns" x="' + splitPadL + '" y="' + splitPadT + '" width="' + splitPlotW + '" height="' + splitPlotH + '" fill="transparent" pointer-events="all" style="cursor:crosshair;" />';

        if (chartSvgTurns) chartSvgTurns.innerHTML = svgTurns;

        // --- Split Bottom: Fresh Sessions ---
        let svgSessions = '<defs>' +
          '<linearGradient id="areaGradSessions" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="#f59e0b" stop-opacity="0.35"/>' +
            '<stop offset="100%" stop-color="#f59e0b" stop-opacity="0.02"/>' +
          '</linearGradient>' +
          '<filter id="glowSplit" x="-20%" y="-20%" width="140%" height="140%">' +
            '<feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#a855f7" flood-opacity="0.8"/>' +
          '</filter>' +
        '</defs>';

        const yWarnSplit = getYSessionSplit(warnSessions);
        const yDangerSplit = getYSessionSplit(dangerSessions);

        // Risk bands
        const safeHSess = Math.max(0, splitYZero - yWarnSplit);
        svgSessions += '<rect x="' + splitPadL + '" y="' + yWarnSplit + '" width="' + splitPlotW + '" height="' + safeHSess + '" fill="rgba(16, 185, 129, 0.05)" />';
        const guardedHSess = Math.max(0, yWarnSplit - yDangerSplit);
        svgSessions += '<rect x="' + splitPadL + '" y="' + yDangerSplit + '" width="' + splitPlotW + '" height="' + guardedHSess + '" fill="rgba(245, 158, 11, 0.07)" />';
        const dangerHSess = Math.max(0, yDangerSplit - splitPadT);
        svgSessions += '<rect x="' + splitPadL + '" y="' + splitPadT + '" width="' + splitPlotW + '" height="' + dangerHSess + '" fill="rgba(244, 63, 94, 0.09)" />';

        // Inside-plot Zone Badges
        svgSessions += renderZoneBadge(badgeXSplit, Math.max(splitPadT + 12, splitPadT + dangerHSess / 2 + 3.5), '🔴 DANGER (≥' + dangerSessions + ')', 'var(--rose)');
        svgSessions += renderZoneBadge(badgeXSplit, yDangerSplit + guardedHSess / 2 + 3.5, '🟡 GUARDED (' + warnSessions + '-' + (dangerSessions - 1) + ')', 'var(--amber)');
        svgSessions += renderZoneBadge(badgeXSplit, yWarnSplit + safeHSess / 2 + 3.5, '🟢 SAFE (0-' + (warnSessions - 1) + ')', 'var(--emerald)');

        // Gridlines & Clean Numeric Ticks (Zero bleed)
        const rightTicks = [0, 5, warnSessions, dangerSessions, maxSessionsY];
        const uniqueRightTicks = Array.from(new Set(rightTicks)).sort(function (a, b) { return a - b; });
        for (let i = 0; i < uniqueRightTicks.length; i++) {
          const val = uniqueRightTicks[i];
          const y = getYSessionSplit(val);
          svgSessions += '<line x1="' + splitPadL + '" y1="' + y + '" x2="' + (splitPadL + splitPlotW) + '" y2="' + y + '" stroke="rgba(35, 47, 69, 0.45)" stroke-dasharray="3,3" />';
          let labelFill = "var(--text-dim)";
          if (val === dangerSessions) labelFill = "var(--rose)";
          else if (val === warnSessions) labelFill = "var(--amber)";
          else if (val === maxSessionsY) labelFill = "var(--amber)";
          svgSessions += '<text x="' + (splitPadL - 8) + '" y="' + (y + 3.5) + '" fill="' + labelFill + '" font-size="10" font-family="monospace" text-anchor="end">' + val + '</text>';
        }

        // Curves & Bars
        let pathDSessions = 'M ' + getSplitX(0) + ' ' + getYSessionSplit(points[0].rolling10mSessions || 0);
        for (let i = 1; i < points.length; i++) {
          pathDSessions += ' L ' + getSplitX(i) + ' ' + getYSessionSplit(points[i].rolling10mSessions || 0);
        }
        const areaDSessions = pathDSessions + ' L ' + getSplitX(points.length - 1) + ' ' + splitYZero + ' L ' + getSplitX(0) + ' ' + splitYZero + ' Z';
        svgSessions += '<path d="' + areaDSessions + '" fill="url(#areaGradSessions)" />';

        const barWSplit = Math.max(2.5, (splitPlotW / points.length) * 0.45);
        for (let i = 0; i < points.length; i++) {
          const sVal = points[i].rolling10mSessions || 0;
          if (sVal > 0) {
            const bx = getSplitX(i) - barWSplit / 2;
            const by = getYSessionSplit(sVal);
            const bh = splitYZero - by;
            svgSessions += '<rect class="bar-session" data-idx="' + i + '" x="' + bx + '" y="' + by + '" width="' + barWSplit + '" height="' + bh + '" fill="var(--amber)" opacity="0.85" rx="1" />';
          }
        }
        svgSessions += '<path d="' + pathDSessions + '" fill="none" stroke="var(--amber)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />';

        // Throttle markers
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          if (p.throttles > 0) {
            const tx = getSplitX(i);
            const ty = splitPadT + 2;
            svgSessions += '<line x1="' + tx + '" y1="' + (splitPadT + 12) + '" x2="' + tx + '" y2="' + splitYZero + '" stroke="var(--purple)" stroke-dasharray="2,2" stroke-width="1" opacity="0.6" />';
            svgSessions += '<g transform="translate(' + (tx - 6) + ',' + ty + ')" filter="url(#glowSplit)">' +
              '<path d="M7 1L1 8h5l-1 7 7-8H7l1-6z" fill="var(--purple)" stroke="#ffffff" stroke-width="0.75" />' +
            '</g>';
          }
        }

        // Crosshair & Hover Dot
        svgSessions += '<line id="crosshairSession" x1="0" y1="' + splitPadT + '" x2="0" y2="' + splitYZero + '" stroke="#cbd5e1" stroke-width="1.2" stroke-dasharray="3,3" opacity="0" pointer-events="none" />';
        svgSessions += '<circle id="dotSession" cx="0" cy="0" r="4.5" fill="#ffffff" stroke="var(--amber)" stroke-width="2.5" opacity="0" pointer-events="none" />';
        svgSessions += '<rect id="overlaySessions" x="' + splitPadL + '" y="' + splitPadT + '" width="' + splitPlotW + '" height="' + splitPlotH + '" fill="transparent" pointer-events="all" style="cursor:crosshair;" />';

        if (chartSvgSessions) chartSvgSessions.innerHTML = svgSessions;

        // --- Synchronized Pointer Handlers for Split View ---
        function handleSplitPointer(evt, activeSvg) {
          const rect = activeSvg.getBoundingClientRect();
          const clientX = evt.clientX || (evt.touches && evt.touches[0] && evt.touches[0].clientX);
          const clientY = evt.clientY || (evt.touches && evt.touches[0] && evt.touches[0].clientY);
          if (!clientX) return;

          const mouseSvgX = ((clientX - rect.left) / rect.width) * splitSvgW;
          const clampedX = Math.max(splitPadL, Math.min(splitPadL + splitPlotW, mouseSvgX));
          const ratio = (clampedX - splitPadL) / splitPlotW;
          const index = Math.round(ratio * (points.length - 1));
          const p = points[index];
          if (!p) return;

          const pointX = getSplitX(index);
          const turnY = getYTurnSplit(p.rolling10mTurns || 0);
          const sessionY = getYSessionSplit(p.rolling10mSessions || 0);

          const crossTurn = document.getElementById("crosshairTurn");
          const crossSess = document.getElementById("crosshairSession");
          if (crossTurn) {
            crossTurn.setAttribute("x1", pointX);
            crossTurn.setAttribute("x2", pointX);
            crossTurn.setAttribute("opacity", "0.85");
          }
          if (crossSess) {
            crossSess.setAttribute("x1", pointX);
            crossSess.setAttribute("x2", pointX);
            crossSess.setAttribute("opacity", "0.85");
          }

          const dotT = document.getElementById("dotTurn");
          const dotS = document.getElementById("dotSession");
          if (dotT) {
            dotT.setAttribute("cx", pointX);
            dotT.setAttribute("cy", turnY);
            dotT.setAttribute("opacity", "1");
          }
          if (dotS) {
            dotS.setAttribute("cx", pointX);
            dotS.setAttribute("cy", sessionY);
            dotS.setAttribute("opacity", (p.rolling10mSessions || 0) > 0 ? "1" : "0.5");
          }

          chartTooltip.innerHTML = getTooltipHtml(p);
          chartTooltip.style.opacity = "1";
          positionTooltip(clientX, clientY);
        }

        function hideSplitPointer() {
          const crossTurn = document.getElementById("crosshairTurn");
          const crossSess = document.getElementById("crosshairSession");
          if (crossTurn) crossTurn.setAttribute("opacity", "0");
          if (crossSess) crossSess.setAttribute("opacity", "0");
          const dotT = document.getElementById("dotTurn");
          const dotS = document.getElementById("dotSession");
          if (dotT) dotT.setAttribute("opacity", "0");
          if (dotS) dotS.setAttribute("opacity", "0");
          chartTooltip.style.opacity = "0";
        }

        const oTurns = document.getElementById("overlayTurns");
        if (oTurns && chartSvgTurns) {
          oTurns.addEventListener("mousemove", function (e) { handleSplitPointer(e, chartSvgTurns); });
          oTurns.addEventListener("touchmove", function (e) { handleSplitPointer(e, chartSvgTurns); }, { passive: true });
          oTurns.addEventListener("mouseleave", hideSplitPointer);
          oTurns.addEventListener("touchend", hideSplitPointer);
        }

        const oSessions = document.getElementById("overlaySessions");
        if (oSessions && chartSvgSessions) {
          oSessions.addEventListener("mousemove", function (e) { handleSplitPointer(e, chartSvgSessions); });
          oSessions.addEventListener("touchmove", function (e) { handleSplitPointer(e, chartSvgSessions); }, { passive: true });
          oSessions.addEventListener("mouseleave", hideSplitPointer);
          oSessions.addEventListener("touchend", hideSplitPointer);
        }

        /* -------------------------------------------------------------
         * PART B: COMBINED VIEW (Single Composite Dual-Axis Chart)
         * ----------------------------------------------------------- */
        const combSvgW = 1000;
        const combSvgH = 240;
        const combPadL = 56;
        const combPadR = 56;
        const combPadT = 24;
        const combPadB = 26;
        const combPlotW = combSvgW - combPadL - combPadR;
        const combPlotH = combSvgH - combPadT - combPadB;
        const combYZero = combPadT + combPlotH;

        function getCombX(index) {
          if (points.length <= 1) return combPadL;
          return combPadL + (index / (points.length - 1)) * combPlotW;
        }

        function getYTurnComb(val) {
          const clamped = Math.min(val, maxTurnsY);
          return combPadT + combPlotH - (clamped / maxTurnsY) * combPlotH;
        }

        function getYSessionComb(val) {
          const clamped = Math.min(val, maxSessionsY);
          return combPadT + combPlotH - (clamped / maxSessionsY) * combPlotH;
        }

        let svgComb = '<defs>' +
          '<linearGradient id="areaGradComb" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="#06b6d4" stop-opacity="0.35"/>' +
            '<stop offset="100%" stop-color="#06b6d4" stop-opacity="0.02"/>' +
          '</linearGradient>' +
          '<filter id="glowComb" x="-20%" y="-20%" width="140%" height="140%">' +
            '<feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="#a855f7" flood-opacity="0.8"/>' +
          '</filter>' +
        '</defs>';

        const yBurstSoftComb = getYTurnComb(burstSoft);
        const yBurstMaxComb = getYTurnComb(burstMax);

        // Aligned Background Risk Bands
        const safeHComb = Math.max(0, combYZero - yBurstSoftComb);
        svgComb += '<rect x="' + combPadL + '" y="' + yBurstSoftComb + '" width="' + combPlotW + '" height="' + safeHComb + '" fill="rgba(16, 185, 129, 0.05)" />';
        const guardedHComb = Math.max(0, yBurstSoftComb - yBurstMaxComb);
        svgComb += '<rect x="' + combPadL + '" y="' + yBurstMaxComb + '" width="' + combPlotW + '" height="' + guardedHComb + '" fill="rgba(245, 158, 11, 0.07)" />';
        const dangerHComb = Math.max(0, yBurstMaxComb - combPadT);
        svgComb += '<rect x="' + combPadL + '" y="' + combPadT + '" width="' + combPlotW + '" height="' + dangerHComb + '" fill="rgba(244, 63, 94, 0.09)" />';

        // Inside-plot Zone Badges (Right inside edge of plot area, zero bleed)
        const badgeXComb = combPadL + combPlotW - 12;
        svgComb += renderZoneBadge(badgeXComb, Math.max(combPadT + 12, combPadT + dangerHComb / 2 + 4), '🔴 DANGER (≥' + burstMax + ')', 'var(--rose)');
        svgComb += renderZoneBadge(badgeXComb, yBurstMaxComb + guardedHComb / 2 + 4, '🟡 GUARDED (' + burstSoft + '-' + (burstMax - 1) + ')', 'var(--amber)');
        svgComb += renderZoneBadge(badgeXComb, yBurstSoftComb + safeHComb / 2 + 4, '🟢 SAFE (0-' + (burstSoft - 1) + ')', 'var(--emerald)');

        // Gridlines & Left Axis Ticks (Turns - Cyan, pure numbers)
        for (let i = 0; i < uniqueLeftTicks.length; i++) {
          const val = uniqueLeftTicks[i];
          const y = getYTurnComb(val);
          svgComb += '<line x1="' + combPadL + '" y1="' + y + '" x2="' + (combPadL + combPlotW) + '" y2="' + y + '" stroke="rgba(35, 47, 69, 0.45)" stroke-dasharray="3,3" />';
          let labelFill = "var(--text-dim)";
          if (val === burstMax) labelFill = "var(--rose)";
          else if (val === burstSoft) labelFill = "var(--amber)";
          else if (val === maxTurnsY) labelFill = "var(--cyan)";
          svgComb += '<text x="' + (combPadL - 8) + '" y="' + (y + 3.5) + '" fill="' + labelFill + '" font-size="10" font-family="monospace" text-anchor="end">' + val + '</text>';
        }

        // Right Axis Ticks (Fresh Sessions - Amber, pure numbers)
        for (let i = 0; i < uniqueRightTicks.length; i++) {
          const val = uniqueRightTicks[i];
          const y = getYSessionComb(val);
          svgComb += '<line x1="' + (combPadL + combPlotW) + '" y1="' + y + '" x2="' + (combPadL + combPlotW + 4) + '" y2="' + y + '" stroke="rgba(245, 158, 11, 0.4)" stroke-width="1" />';
          let labelFill = "var(--text-dim)";
          if (val === dangerSessions) labelFill = "var(--rose)";
          else if (val === warnSessions) labelFill = "var(--amber)";
          else if (val === maxSessionsY) labelFill = "var(--amber)";
          svgComb += '<text x="' + (combPadL + combPlotW + 8) + '" y="' + (y + 3.5) + '" fill="' + labelFill + '" font-size="10" font-family="monospace" text-anchor="start">' + val + '</text>';
        }

        // Axis Column Headers
        svgComb += '<text x="' + combPadL + '" y="' + (combPadT - 8) + '" fill="var(--cyan)" font-size="9.5" font-family="monospace" font-weight="600" text-anchor="start">◀ TURNS (10m · max ' + maxTurnsY + ')</text>';
        svgComb += '<text x="' + (combPadL + combPlotW) + '" y="' + (combPadT - 8) + '" fill="var(--amber)" font-size="9.5" font-family="monospace" font-weight="600" text-anchor="end">SESSIONS (10m · max ' + maxSessionsY + ') ▶</text>';

        // Turns Filled Area & Stroke
        let pathDComb = 'M ' + getCombX(0) + ' ' + getYTurnComb(points[0].rolling10mTurns || 0);
        for (let i = 1; i < points.length; i++) {
          pathDComb += ' L ' + getCombX(i) + ' ' + getYTurnComb(points[i].rolling10mTurns || 0);
        }
        const areaDComb = pathDComb + ' L ' + getCombX(points.length - 1) + ' ' + combYZero + ' L ' + getCombX(0) + ' ' + combYZero + ' Z';
        svgComb += '<path d="' + areaDComb + '" fill="url(#areaGradComb)" />';

        // Fresh Sessions Pillar Bars
        const barWComb = Math.max(2.5, (combPlotW / points.length) * 0.45);
        for (let i = 0; i < points.length; i++) {
          const sVal = points[i].rolling10mSessions || 0;
          if (sVal > 0) {
            const bx = getCombX(i) - barWComb / 2;
            const by = getYSessionComb(sVal);
            const bh = combYZero - by;
            svgComb += '<rect class="bar-session" data-idx="' + i + '" x="' + bx + '" y="' + by + '" width="' + barWComb + '" height="' + bh + '" fill="var(--amber)" opacity="0.85" rx="1" />';
          }
        }
        svgComb += '<path d="' + pathDComb + '" fill="none" stroke="var(--cyan)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />';

        // Throttle Markers
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          if (p.throttles > 0) {
            const tx = getCombX(i);
            const ty = combPadT + 2;
            svgComb += '<line x1="' + tx + '" y1="' + (combPadT + 12) + '" x2="' + tx + '" y2="' + combYZero + '" stroke="var(--purple)" stroke-dasharray="2,2" stroke-width="1" opacity="0.6" />';
            svgComb += '<g transform="translate(' + (tx - 6) + ',' + ty + ')" filter="url(#glowComb)">' +
              '<path d="M7 1L1 8h5l-1 7 7-8H7l1-6z" fill="var(--purple)" stroke="#ffffff" stroke-width="0.75" />' +
            '</g>';
          }
        }

        // Crosshair & Hover Dots
        svgComb += '<line id="chartCrosshair" x1="0" y1="' + combPadT + '" x2="0" y2="' + combYZero + '" stroke="#cbd5e1" stroke-width="1.2" stroke-dasharray="3,3" opacity="0" pointer-events="none" />';
        svgComb += '<circle id="chartHoverDotTurn" cx="0" cy="0" r="4.5" fill="#ffffff" stroke="var(--cyan)" stroke-width="2.5" opacity="0" pointer-events="none" />';
        svgComb += '<circle id="chartHoverDotSession" cx="0" cy="0" r="4" fill="#ffffff" stroke="var(--amber)" stroke-width="2.5" opacity="0" pointer-events="none" />';
        svgComb += '<rect id="chartEventOverlay" x="' + combPadL + '" y="' + combPadT + '" width="' + combPlotW + '" height="' + combPlotH + '" fill="transparent" pointer-events="all" style="cursor:crosshair;" />';

        if (chartSvg) chartSvg.innerHTML = svgComb;

        // Combined Pointer Handlers
        const overlayComb = document.getElementById("chartEventOverlay");
        const crossComb = document.getElementById("chartCrosshair");
        const dotTurnComb = document.getElementById("chartHoverDotTurn");
        const dotSessComb = document.getElementById("chartHoverDotSession");

        function handleCombPointer(evt) {
          const rect = chartSvg.getBoundingClientRect();
          const clientX = evt.clientX || (evt.touches && evt.touches[0] && evt.touches[0].clientX);
          const clientY = evt.clientY || (evt.touches && evt.touches[0] && evt.touches[0].clientY);
          if (!clientX) return;

          const mouseSvgX = ((clientX - rect.left) / rect.width) * combSvgW;
          const clampedX = Math.max(combPadL, Math.min(combPadL + combPlotW, mouseSvgX));
          const ratio = (clampedX - combPadL) / combPlotW;
          const index = Math.round(ratio * (points.length - 1));
          const p = points[index];
          if (!p) return;

          const pointX = getCombX(index);
          const turnY = getYTurnComb(p.rolling10mTurns || 0);
          const sessionY = getYSessionComb(p.rolling10mSessions || 0);

          if (crossComb) {
            crossComb.setAttribute("x1", pointX);
            crossComb.setAttribute("x2", pointX);
            crossComb.setAttribute("opacity", "0.85");
          }
          if (dotTurnComb) {
            dotTurnComb.setAttribute("cx", pointX);
            dotTurnComb.setAttribute("cy", turnY);
            dotTurnComb.setAttribute("opacity", "1");
          }
          if (dotSessComb) {
            dotSessComb.setAttribute("cx", pointX);
            dotSessComb.setAttribute("cy", sessionY);
            dotSessComb.setAttribute("opacity", (p.rolling10mSessions || 0) > 0 ? "1" : "0");
          }

          chartTooltip.innerHTML = getTooltipHtml(p);
          chartTooltip.style.opacity = "1";
          positionTooltip(clientX, clientY);
        }

        function hideCombPointer() {
          if (crossComb) crossComb.setAttribute("opacity", "0");
          if (dotTurnComb) dotTurnComb.setAttribute("opacity", "0");
          if (dotSessComb) dotSessComb.setAttribute("opacity", "0");
          chartTooltip.style.opacity = "0";
        }

        if (overlayComb && chartSvg) {
          overlayComb.addEventListener("mousemove", handleCombPointer);
          overlayComb.addEventListener("touchmove", handleCombPointer, { passive: true });
          overlayComb.addEventListener("mouseleave", hideCombPointer);
          overlayComb.addEventListener("touchend", hideCombPointer);
        }
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
