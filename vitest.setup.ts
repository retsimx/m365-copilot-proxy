// Unit-test defaults. Disable the proportional-taper soft pace suite-wide so multi-turn
// handler tests don't incur real ~5s+ waits; tests that exercise pacing (the velocity
// governor describe) delete this env so the real default (45s ceiling) applies.
process.env.M365_PACE_CEILING_MS = "0";
