# Session pool / long-turn checklists

## Idle TTL vs in-flight turns

- A cached remote conversation must distinguish **idle** from **in flight**. Guard the reaper
  with an in-flight marker (`activeTurns > 0`) — never with the timestamp alone.
- Timestamp the **end** of work, not just its start. A turn can outlive the TTL, and a
  turn-completion touch is what makes "idle for N minutes" mean what it says.
- Reapers are reachable from **telemetry polls** (`/api/metrics` → `getSessionsSnapshot()` →
  `evictStale()`, every 2 s while the dashboard is open). Do not assume eviction only happens
  on the request path — it can fire mid-stream.
- Eviction is silent by design: the next request gets a fresh `ConversationId`, a
  full-history replay, the 15 s new-session stagger, and a charge against the
  `PerScenarioThrottled` thread budget. Any bug here looks like "the model forgot the
  session", not like an error.
- Regression coverage: `packages/proxy-lib/src/session-ttl.test.ts`.
