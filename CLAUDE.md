# CLAUDE.md

Working guidance for this repo lives in **[AGENTS.md](AGENTS.md)** — read it first.

Start with the **Operating principles (read first)** and **How we work —
hypothesis-driven** sections. In short:

1. Always run sequentially — one thread at a time. Two upstream horizons: thread
   creation (`PerScenarioThrottled`; 30m cooldown, 15s new-session pacing) and an
   account-wide **turn-volume** ceiling (`PerUserThrottled`; shared across models, exact
   value unpinned — see hypotheses F35/F36). Shielded locally by the circuit breaker +
   velocity governor.
2. Chase all hunches — tangents to test any idea are encouraged; test, don't guess.
3. The end goal is always a usable agent in **pi or openclaw**.
4. Be scientific: hypothesize → predict → test → conclude (log it in
   `docs/hypotheses.md`).
5. Prompt tinkering: try **N wildly different** strategies at once, A/B them in one
   bench sweep, and let the data pick the direction — never iterate on the first idea.

Protocol source of truth: [`docs/m365-copilot-api.md`](docs/m365-copilot-api.md).
Open-questions notebook: [`docs/hypotheses.md`](docs/hypotheses.md).
