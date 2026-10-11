/**
 * Embedded zero-dependency observability dashboard.
 *
 * The dashboard deliberately separates turn governing, session governing, and
 * upstream recovery. All limits and thresholds are supplied by /api/metrics.
 */
export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>M365 Copilot Proxy · Observability Console</title>
  <style>
    :root {
      --bg:#0b0f17;--card:#151c28;--card2:#101722;--border:#253149;
      --text:#f8fafc;--muted:#94a3b8;--dim:#64748b;
      --cyan:#06b6d4;--green:#10b981;--amber:#f59e0b;--rose:#f43f5e;--purple:#a855f7;
      --mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
      --sans:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:var(--bg);color:var(--text);font-family:var(--sans);padding:1.25rem;min-height:100vh}
    .container{max-width:1440px;margin:auto;display:flex;flex-direction:column;gap:1rem}
    header{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding-bottom:.85rem;border-bottom:1px solid var(--border)}
    .brand{display:flex;align-items:center;gap:.7rem}.logo{width:34px;height:34px;border-radius:8px;background:linear-gradient(135deg,var(--cyan),#3b82f6);display:grid;place-items:center;font-weight:800}
    h1{font-size:1.25rem;letter-spacing:-.02em}.subtitle{font-size:.73rem;color:var(--dim);margin-top:.08rem}
    .header-status{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap;justify-content:flex-end}
    .pill,.badge{display:inline-flex;align-items:center;border:1px solid;border-radius:999px;padding:.25rem .58rem;font-size:.68rem;font-weight:700;letter-spacing:.03em;text-transform:uppercase}
    .ok{color:#34d399;background:#10b98118;border-color:#10b98155}.warn{color:#fbbf24;background:#f59e0b18;border-color:#f59e0b55}.bad{color:#fb7185;background:#f43f5e18;border-color:#f43f5e55}.info{color:#67e8f9;background:#06b6d418;border-color:#06b6d455}.neutral{color:#cbd5e1;background:#64748b18;border-color:#64748b55}
    .clock{font: .72rem var(--mono);color:var(--muted)}
    .cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:.85rem}
    .card{min-height:148px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:.85rem;display:flex;flex-direction:column;gap:.58rem}
    .card-head{display:flex;justify-content:space-between;align-items:center;gap:.5rem}.card-title{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
    .value-row{display:flex;align-items:baseline;gap:.42rem}.value{font:700 1.72rem/1 var(--mono)}.unit{font:.72rem var(--mono);color:var(--dim)}
    .bar{height:6px;background:#0c1320;border-radius:4px;position:relative;overflow:hidden}.fill{height:100%;width:0;background:var(--cyan);transition:width .25s}.marker{position:absolute;width:2px;top:0;bottom:0;background:#ffffff77}
    .details{margin-top:auto;display:grid;grid-template-columns:1fr 1fr;gap:.22rem .5rem;font-size:.67rem;color:var(--dim)}.details span:nth-child(even){text-align:right;font-family:var(--mono);color:var(--muted)}
    .section{background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden}
    .section-head{padding:.75rem .9rem;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:1rem;flex-wrap:wrap}
    .section-title{font-size:.84rem;font-weight:700}.section-note{font-size:.69rem;color:var(--dim);margin-top:.12rem}
    .controls{display:flex;gap:.35rem}.btn{border:1px solid var(--border);background:#0f1724;color:var(--muted);border-radius:5px;padding:.28rem .55rem;font-size:.68rem;cursor:pointer}.btn.active{color:var(--cyan);border-color:#06b6d477;background:#06b6d412}
    .charts{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border)}
    .chart{background:var(--card2);padding:.65rem}.chart-head{display:flex;justify-content:space-between;gap:.5rem;margin-bottom:.35rem}.chart-name{font-size:.71rem;font-weight:700}.chart-meta{font:.63rem var(--mono);color:var(--dim)}
    svg{width:100%;height:170px;display:block}.axis{stroke:#2a3852;stroke-width:1}.threshold{stroke-dasharray:5 4;stroke-width:1}.series{fill:none;stroke-width:2.2;stroke-linejoin:round;stroke-linecap:round}.area{opacity:.11}.tick{fill:var(--dim);font:9px var(--mono)}
    .tooltip{position:fixed;z-index:20;pointer-events:none;opacity:0;background:#111a28;border:1px solid var(--border);border-radius:7px;padding:.55rem .65rem;box-shadow:0 8px 25px #0008;font-size:.68rem;color:var(--muted);min-width:210px}
    .tooltip strong{color:var(--text);font-family:var(--mono)}
    table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:.62rem .8rem;border-bottom:1px solid #202b40;font-size:.7rem}th{color:var(--dim);font-size:.64rem;text-transform:uppercase;letter-spacing:.04em;background:#101722}td{color:var(--muted)}tr:last-child td{border-bottom:0}.mono{font-family:var(--mono)}.id{color:var(--cyan)}
    .empty{padding:2rem;text-align:center;color:var(--dim);font-size:.75rem}.turns{white-space:nowrap}.activity{white-space:nowrap}
    details{border-bottom:1px solid var(--border)}details:last-child{border-bottom:0}summary{cursor:pointer;padding:.72rem .9rem;font-size:.74rem;font-weight:650;color:var(--muted)}details p{padding:0 .9rem .75rem;font-size:.71rem;line-height:1.55;color:var(--dim)}code{font-family:var(--mono);color:var(--cyan)}
    @media(max-width:1100px){.cards{grid-template-columns:repeat(2,1fr)}.charts{grid-template-columns:1fr}}
    @media(max-width:650px){body{padding:.7rem}.cards{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column}.header-status{justify-content:flex-start}.card{min-height:135px}.table-wrap{overflow:auto}}
  </style>
</head>
<body>
<div class="container">
  <header>
    <div class="brand"><div class="logo">M</div><div><h1>M365 Copilot Proxy</h1><div class="subtitle">Turn governing · session governing · upstream recovery</div></div></div>
    <div class="header-status">
      <span id="serviceStatus" class="pill ok">Service online</span>
      <span id="turnStatus" class="pill neutral">Turns —</span>
      <span id="sessionStatus" class="pill neutral">Sessions —</span>
      <span id="upstreamStatus" class="pill neutral">Upstream —</span>
      <span id="clock" class="clock">—</span>
    </div>
  </header>

  <div class="cards">
    <article class="card">
      <div class="card-head"><span class="card-title">Sustained Turns · 60m</span><span id="sustainedBadge" class="badge neutral">—</span></div>
      <div class="value-row"><span id="sustainedValue" class="value">—</span><span id="sustainedUnit" class="unit">/ — attempts</span></div>
      <div class="bar"><div id="sustainedFill" class="fill"></div><div id="sustainedMarker" class="marker"></div></div>
      <div class="details"><span>Remaining</span><span id="sustainedRemaining">—</span><span>Current delay</span><span id="sustainedDelay">—</span><span>Oldest expires</span><span id="sustainedRecovery">—</span><span>Policy warning</span><span id="sustainedWarn">—</span></div>
    </article>

    <article class="card">
      <div class="card-head"><span class="card-title">Burst Turns · 10m</span><span id="burstBadge" class="badge neutral">—</span></div>
      <div class="value-row"><span id="burstValue" class="value">—</span><span id="burstUnit" class="unit">/ — attempts</span></div>
      <div class="bar"><div id="burstFill" class="fill"></div><div id="burstMarker" class="marker"></div></div>
      <div class="details"><span>Remaining</span><span id="burstRemaining">—</span><span>Current delay</span><span id="burstDelay">—</span><span>Oldest expires</span><span id="burstRecovery">—</span><span>Soft pacing</span><span id="burstSoft">—</span></div>
    </article>

    <article class="card">
      <div class="card-head"><span class="card-title">Fresh-Session Capacity</span><span id="sessionBadge" class="badge neutral">—</span></div>
      <div class="value-row"><span id="sessionValue" class="value">—</span><span id="sessionUnit" class="unit">/ — tokens</span></div>
      <div class="bar"><div id="sessionFill" class="fill" style="background:var(--amber)"></div></div>
      <div class="details"><span>Fresh sessions</span><span id="sessionWindows">—</span><span>Next refill</span><span id="sessionRefill">—</span><span>Next eligible</span><span id="sessionEligible">—</span><span>Session delay</span><span id="sessionDelay">—</span></div>
    </article>

    <article class="card">
      <div class="card-head"><span class="card-title">Upstream Circuit Breaker</span><span id="circuitBadge" class="badge neutral">—</span></div>
      <div class="value-row"><span id="circuitValue" class="value">—</span><span id="circuitUnit" class="unit">upstream</span></div>
      <div class="bar"><div id="circuitFill" class="fill" style="background:var(--purple)"></div></div>
      <div class="details"><span>Reason</span><span id="circuitReason">—</span><span>Recovery</span><span id="circuitRecovery">—</span><span>Last throttle</span><span id="lastThrottle">—</span><span>Lifetime events</span><span id="throttleCount">—</span></div>
    </article>

    <article class="card">
      <div class="card-head"><span class="card-title">Next Turn / Queue</span><span id="queueBadge" class="badge neutral">—</span></div>
      <div class="value-row"><span id="queueValue" class="value">—</span><span class="unit">next dispatch</span></div>
      <div class="details"><span>Delay source</span><span id="queueCause">—</span><span>Queued turns</span><span id="queueDepth">—</span><span>Priority retries</span><span id="queueRetries">—</span><span>Oldest waiting</span><span id="queueOldest">—</span></div>
    </article>

    <article class="card">
      <div class="card-head"><span class="card-title">Request Consumption · 60m</span><span class="badge info">Factual</span></div>
      <div class="value-row"><span id="consumptionValue" class="value">—</span><span id="consumptionUnit" class="unit">upstream attempts</span></div>
      <div class="details"><span>Client requests</span><span id="clientRequests">—</span><span>Internal retries</span><span id="retryAttempts">—</span><span>Reconnects</span><span id="reconnectAttempts">—</span><span>Disengaged recovery</span><span id="disengagedAttempts">—</span></div>
    </article>

    <article class="card">
      <div class="card-head"><span class="card-title">Current Throughput</span><span id="throughputBadge" class="badge neutral">—</span></div>
      <div class="value-row"><span id="throughputValue" class="value">—</span><span class="unit">attempts / hour</span></div>
      <div class="details"><span>Last 10 minutes</span><span id="throughput10">—</span><span>Last 60 minutes</span><span id="throughput60">—</span><span>Capacity used</span><span id="throughputUsed">—</span><span>Flow state</span><span id="flowState">—</span></div>
    </article>

    <article class="card">
      <div class="card-head"><span class="card-title">Dispatch Delay · 60m</span><span id="delayBadge" class="badge neutral">—</span></div>
      <div class="value-row"><span id="delayValue" class="value">—</span><span class="unit">p95 turn wait</span></div>
      <div class="details"><span>Median</span><span id="delayP50">—</span><span>Maximum</span><span id="delayMax">—</span><span>Delayed turns</span><span id="delayedTurns">—</span><span>Session waits</span><span id="delayedSessions">—</span></div>
    </article>
  </div>

  <section class="section">
    <div class="section-head">
      <div><div class="section-title">Governor History</div><div class="section-note">Turn and session governing are shown separately. Rolling windows are calculated server-side.</div></div>
      <div class="controls"><button class="btn active" data-range="1h">1h</button><button class="btn" data-range="6h">6h</button><button class="btn" data-range="24h">24h</button></div>
    </div>
    <div class="charts">
      <div class="chart"><div class="chart-head"><span class="chart-name" style="color:var(--cyan)">Turn governing · 60m</span><span id="turn60Meta" class="chart-meta">—</span></div><svg id="turn60Chart" viewBox="0 0 700 170" preserveAspectRatio="none"></svg></div>
      <div class="chart"><div class="chart-head"><span class="chart-name" style="color:#67e8f9">Turn governing · 10m</span><span id="turn10Meta" class="chart-meta">—</span></div><svg id="turn10Chart" viewBox="0 0 700 170" preserveAspectRatio="none"></svg></div>
      <div class="chart"><div class="chart-head"><span class="chart-name" style="color:var(--purple)">Turn dispatch delay</span><span id="delayMeta" class="chart-meta">average per minute</span></div><svg id="delayChart" viewBox="0 0 700 170" preserveAspectRatio="none"></svg></div>
      <div class="chart"><div class="chart-head"><span class="chart-name" style="color:var(--amber)">Session governing</span><span id="sessionMeta" class="chart-meta">rolling 10m fresh sessions</span></div><svg id="sessionChart" viewBox="0 0 700 170" preserveAspectRatio="none"></svg></div>
    </div>
  </section>

  <section class="section">
    <div class="section-head"><div><div class="section-title">Recently Active Conversations</div><div class="section-note">Newest activity first. Conversation turns are lifetime use, independent of account-wide rolling limits.</div></div><span id="conversationSummary" class="badge neutral">0 recently active</span></div>
    <div class="table-wrap"><table><thead><tr><th>Conversation</th><th>Model / route</th><th>Turns</th><th>Upstream</th><th>Activity</th><th>Last active</th></tr></thead><tbody id="conversationRows"></tbody></table></div>
  </section>

  <section class="section">
    <div class="section-head"><div><div class="section-title">Operating Notes</div><div class="section-note">Empirical policy and governor behaviour</div></div></div>
    <details><summary>Turn governing versus session governing</summary><p>Turn governing protects account-wide Microsoft-facing attempts over rolling 10-minute and 60-minute windows. Session governing separately protects fresh conversation creation using a stagger and token bucket. A fresh conversation consumes both a session permit and a turn permit; follow-up turns consume only turn capacity.</p></details>
    <details><summary>What do the local limits mean?</summary><p>The configured sustained cap is conservative local operating policy, not a confirmed Microsoft quota. Tool-enabled testing sustained 130 and 135 recorded attempts per rolling hour without an explicit throttle. Production selected 130 for margin. A differently shaped high-velocity run triggered <code>PerUserThrottled</code> near 140 recorded attempts/hour, so the exact upstream accounting function remains unknown.</p></details>
    <details><summary>How are retries counted?</summary><p>Every proxy-managed upstream attempt passes through turn governing, including empty-response retries, forced continuations, transport reconnects, and Disengaged recovery. Disengaged recovery rotates to a fresh conversation, so it also consumes session capacity.</p></details>
    <details><summary>Which upstream throttle belongs to which governor?</summary><p><code>PerUserThrottled</code> is associated with account-wide turn volume. <code>PerScenarioThrottled</code> is associated with fresh-conversation creation. The circuit breaker locally shields traffic during recovery so no additional Copilot turns are dispatched.</p></details>
  </section>
</div>
<div id="tooltip" class="tooltip"></div>
<script>
(function(){
  let range="1h", fetching=false, latest=null;
  const $=id=>document.getElementById(id);
  const fmtMs=ms=>{
    if(!ms||ms<=0)return "ready";
    const s=Math.ceil(ms/1000); if(s<60)return s+"s";
    const m=Math.floor(s/60),r=s%60;return m+"m "+(r?r+"s":"");
  };
  const ago=ts=>{
    if(!ts)return "none";
    const s=Math.max(0,Math.round((Date.now()-ts)/1000));if(s<60)return s+"s ago";
    const m=Math.floor(s/60);if(m<60)return m+"m ago";return Math.floor(m/60)+"h ago";
  };
  const badge=(el,state,text)=>{
    el.className="badge "+(state==="safe"||state==="ready"?"ok":state==="guarded"||state==="pacing"?"warn":state==="danger"||state==="armed"?"bad":"neutral");
    el.textContent=text;
  };
  const statusClass=s=>s==="safe"?"ok":s==="guarded"?"warn":"bad";
  function setCapacity(prefix,g,current,max,threshold){
    $(prefix+"Value").textContent=current;
    $(prefix+"Unit").textContent="/ "+max+" attempts";
    $(prefix+"Remaining").textContent=Math.max(0,max-current);
    $(prefix+"Delay").textContent=fmtMs(g.currentDelayMs);
    $(prefix+"Recovery").textContent=fmtMs(g.recoveryMs);
    $(prefix+(prefix==="burst"?"Soft":"Warn")).textContent=threshold;
    $(prefix+"Fill").style.width=Math.min(100,current/Math.max(1,max)*100)+"%";
    $(prefix+"Fill").style.background=g.status==="danger"?"var(--rose)":g.status==="guarded"?"var(--amber)":"var(--cyan)";
    $(prefix+"Marker").style.left=Math.min(100,threshold/Math.max(1,max)*100)+"%";
    badge($(prefix+"Badge"),g.status,g.status);
  }
  function renderCards(d){
    const g=d.governor,cfg=d.config,q=d.turnQueue,sq=d.staggerQueue,cb=d.circuitBreaker;
    setCapacity("sustained",g.sixtyMinute,g.sixtyMinute.turns,cfg.sustainedMaxTurns,cfg.sustainedWarnTurns);
    setCapacity("burst",g.tenMinute,g.tenMinute.turns,cfg.burstMaxTurns,cfg.burstSoftTurns);
    $("turnStatus").className="pill "+statusClass(g.sixtyMinute.status);$("turnStatus").textContent="Turns "+g.sixtyMinute.status;

    $("sessionValue").textContent=sq.sessionTokens;$("sessionUnit").textContent="/ "+sq.tokenCapacity+" tokens";
    $("sessionFill").style.width=Math.min(100,sq.sessionTokens/Math.max(1,sq.tokenCapacity)*100)+"%";
    $("sessionWindows").textContent=g.tenMinute.freshSessions+" / "+g.sixtyMinute.freshSessions+" (10m/60m)";
    $("sessionRefill").textContent=fmtMs(sq.nextRefillMs);$("sessionEligible").textContent=fmtMs(sq.nextEligibleMs);$("sessionDelay").textContent=fmtMs(sq.delayMs);
    const sessState=sq.delayMs>0?"pacing":"ready";badge($("sessionBadge"),sessState,sessState);$("sessionStatus").className="pill "+(sessState==="ready"?"ok":"warn");$("sessionStatus").textContent="Sessions "+sessState;

    if(cb.isArmed){
      badge($("circuitBadge"),"armed","armed");$("circuitValue").textContent=fmtMs(cb.remainingCooldownSec*1000);$("circuitUnit").textContent="cooldown";
      $("circuitReason").textContent=cb.reason||"throttled";$("circuitRecovery").textContent=new Date(Date.now()+cb.remainingCooldownSec*1000).toLocaleTimeString();
      $("circuitFill").style.width="100%";$("upstreamStatus").className="pill bad";$("upstreamStatus").textContent="Upstream recovering";
    }else{
      badge($("circuitBadge"),"safe","available");$("circuitValue").textContent="Available";$("circuitUnit").textContent="upstream";
      $("circuitReason").textContent="none";$("circuitRecovery").textContent="not armed";$("circuitFill").style.width="0";
      $("upstreamStatus").className="pill ok";$("upstreamStatus").textContent="Upstream available";
    }
    $("lastThrottle").textContent=ago(cb.lastThrottleAt);$("throttleCount").textContent=cb.throttleCount;

    const next=cb.isArmed?cb.remainingCooldownSec*1000:q.nextDispatchMs;
    $("queueValue").textContent=fmtMs(next);$("queueCause").textContent=cb.isArmed?"circuit cooldown":String(q.delayCause||"ready").replace(/-/g," ");
    $("queueDepth").textContent=q.depth;$("queueRetries").textContent=q.priorityCount;$("queueOldest").textContent=fmtMs(q.oldestWaitMs);
    badge($("queueBadge"),next>0?"pacing":"ready",next>0?"waiting":"ready");

    const c=d.consumption||{};$("consumptionValue").textContent=c.upstreamAttempts||0;$("clientRequests").textContent=c.clientRequests||0;
    $("retryAttempts").textContent=c.retryAttempts||0;$("reconnectAttempts").textContent=c.transportReconnects||0;$("disengagedAttempts").textContent=c.disengagedRecoveries||0;
    $("consumptionUnit").textContent="upstream attempts";

    const hourly=g.tenMinute.turns*6,active=g.tenMinute.turns>0;
    $("throughputValue").textContent=active?hourly:"—";$("throughput10").textContent=g.tenMinute.turns+" attempts";$("throughput60").textContent=g.sixtyMinute.turns+" attempts";
    $("throughputUsed").textContent=Math.round(g.sixtyMinute.turns/cfg.sustainedMaxTurns*100)+"%";$("flowState").textContent=active?"active":"no active flow";
    badge($("throughputBadge"),active?"safe":"neutral",active?"active":"idle");

    const dd=d.dispatchDelay||{};$("delayValue").textContent=fmtMs(dd.p95DelayMs);$("delayP50").textContent=fmtMs(dd.p50DelayMs);$("delayMax").textContent=fmtMs(dd.maxDelayMs);
    $("delayedTurns").textContent=dd.delayedTurns||0;$("delayedSessions").textContent=(dd.delayedSessions||0)+" ("+fmtMs(dd.sessionDelayMs||0)+" total)";
    badge($("delayBadge"),dd.p95DelayMs>15000?"danger":dd.p95DelayMs>3000?"guarded":"safe",dd.p95DelayMs>0?"measured":"clear");
  }
  function path(vals,max,w,h,pad){
    if(!vals.length)return "";return vals.map((v,i)=>(i?"L":"M")+" "+(pad+i*(w-2*pad)/Math.max(1,vals.length-1)).toFixed(1)+" "+(h-pad-Math.min(max,v)/Math.max(1,max)*(h-2*pad)).toFixed(1)).join(" ");
  }
  function chart(id,points,key,max,threshold,color,tooltipLabel){
    const svg=$(id),w=700,h=170,pad=25,vals=points.map(p=>p[key]||0),d=path(vals,max,w,h,pad);
    const ty=h-pad-threshold/Math.max(1,max)*(h-2*pad);
    let html='<line class="axis" x1="'+pad+'" y1="'+(h-pad)+'" x2="'+(w-pad)+'" y2="'+(h-pad)+'"/>'+
      '<line class="threshold" x1="'+pad+'" y1="'+ty+'" x2="'+(w-pad)+'" y2="'+ty+'" stroke="var(--amber)"/>'+
      '<text class="tick" x="3" y="'+(ty+3)+'">'+threshold+'</text>'+
      '<path class="series" d="'+d+'" stroke="'+color+'"/>';
    points.forEach((p,i)=>{if((p.throttles||0)>0){const x=pad+i*(w-2*pad)/Math.max(1,points.length-1);html+='<line x1="'+x+'" y1="'+pad+'" x2="'+x+'" y2="'+(h-pad)+'" stroke="var(--purple)" stroke-dasharray="3 3"/>'}});
    html+='<rect data-overlay="'+key+'" x="'+pad+'" y="'+pad+'" width="'+(w-2*pad)+'" height="'+(h-2*pad)+'" fill="transparent"/>';
    svg.innerHTML=html;
    const overlay=svg.querySelector("rect[data-overlay]");
    overlay.onmousemove=e=>{
      const r=svg.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),i=Math.round(ratio*(points.length-1)),p=points[i],tip=$("tooltip");
      tip.innerHTML='<strong>'+new Date(p.timestamp).toLocaleString()+'</strong><br>'+tooltipLabel+': <strong>'+(p[key]||0)+'</strong><br>1m attempts: <strong>'+(p.turns||0)+'</strong><br>Turn delay: <strong>'+fmtMs(p.averageTurnDelayMs||0)+'</strong><br>Session delay: <strong>'+fmtMs(p.averageSessionDelayMs||0)+'</strong>';
      tip.style.left=(e.clientX+12)+"px";tip.style.top=(e.clientY+12)+"px";tip.style.opacity="1";
    };overlay.onmouseleave=()=>{$("tooltip").style.opacity="0"};
  }
  function renderCharts(d){
    const p=d.history.points,c=d.config;
    chart("turn60Chart",p,"rolling60mTurns",Math.max(c.sustainedMaxTurns+10,...p.map(x=>x.rolling60mTurns||0)),c.sustainedWarnTurns,"var(--cyan)","Rolling 60m attempts");
    chart("turn10Chart",p,"rolling10mTurns",Math.max(c.burstMaxTurns+5,...p.map(x=>x.rolling10mTurns||0)),c.burstSoftTurns,"#67e8f9","Rolling 10m attempts");
    const maxDelay=Math.max(1000,...p.map(x=>x.averageTurnDelayMs||0));chart("delayChart",p,"averageTurnDelayMs",maxDelay,Math.min(3000,maxDelay),"var(--purple)","Average turn delay ms");
    chart("sessionChart",p,"rolling10mSessions",Math.max(c.sessionDangerThreshold10m+5,...p.map(x=>x.rolling10mSessions||0)),c.sessionWarnThreshold10m,"var(--amber)","Rolling 10m sessions");
    $("turn60Meta").textContent="warn "+c.sustainedWarnTurns+" · max "+c.sustainedMaxTurns;$("turn10Meta").textContent="soft "+c.burstSoftTurns+" · max "+c.burstMaxTurns;
    $("sessionMeta").textContent="warn "+c.sessionWarnThreshold10m+" · danger "+c.sessionDangerThreshold10m;
  }
  function renderConversations(d){
    const rows=$("conversationRows"),ss=(d.activeSessions||[]).slice().sort((a,b)=>b.lastAccessedAt-a.lastAccessedAt);
    let running=0,waiting=0;ss.forEach(s=>{if(s.status==="streaming")running++;if(s.status==="governor"||s.status==="stagger")waiting++});
    $("conversationSummary").textContent=running+" running · "+waiting+" waiting · "+ss.length+" recent";
    if(!ss.length){rows.innerHTML='<tr><td colspan="6" class="empty">No conversations are currently resident in memory.</td></tr>';return}
    rows.innerHTML=ss.map(s=>{
      const id=s.conversationId||s.sessionId||"—",short=id.length>20?id.slice(0,10)+"…"+id.slice(-7):id;
      const route=(s.requestedModel||"unknown")+(s.resolvedTone?" · "+s.resolvedTone:"")+(s.agentAttached?" · attached":" · agent-less");
      const activity=s.status==="streaming"?"Running":s.status==="governor"?"Waiting for turn capacity":s.status==="stagger"?"Waiting for session capacity":"Recently active";
      const cls=s.status==="streaming"?"ok":s.status==="governor"||s.status==="stagger"?"warn":"neutral";
      return '<tr><td class="mono id" title="'+esc(id)+'">'+esc(short)+'</td><td>'+esc(route)+'</td><td class="mono turns">Turns: '+s.turnCount+' / '+s.maxTurns+'</td><td class="mono">'+(s.upstreamAttempts||0)+' attempts · '+(s.retryAttempts||0)+' retries</td><td class="activity"><span class="badge '+cls+'">'+activity+'</span></td><td class="mono">'+ago(s.lastAccessedAt)+'</td></tr>';
    }).join("");
  }
  function esc(v){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
  function render(d){latest=d;renderCards(d);renderCharts(d);renderConversations(d)}
  async function fetchMetrics(){if(fetching)return;fetching=true;try{const r=await fetch("/api/metrics?range="+range);if(!r.ok)throw Error(r.status);render(await r.json());$("serviceStatus").className="pill ok";$("serviceStatus").textContent="Service online"}catch(e){$("serviceStatus").className="pill bad";$("serviceStatus").textContent="Dashboard offline"}finally{fetching=false}}
  document.querySelectorAll("[data-range]").forEach(b=>b.onclick=()=>{document.querySelectorAll("[data-range]").forEach(x=>x.classList.remove("active"));b.classList.add("active");range=b.dataset.range;fetchMetrics()});
  setInterval(()=>{$("clock").textContent=new Date().toLocaleTimeString()+" · "+new Date().toISOString().slice(11,19)+" UTC"},1000);
  setInterval(fetchMetrics,2000);fetchMetrics();
})();
</script>
</body></html>`;
}
