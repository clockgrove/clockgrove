import { LONG_RUNS } from "./journal-long-runs.js";
import { journalParityLongRuns } from "./journal-parity-long-run.js";

// pnpm test:long-run (qualification, not per-PR CI): the raccoons one-year run through the Journal
// against real PostgreSQL. It is the longest run, so it has a file of its own and runs in parallel
// with journal-parity.long-run.test.ts (every scenario and the 30-day runs).

journalParityLongRuns("one-year", {
  scenarios: false,
  longRuns: LONG_RUNS.filter(([, scenario]) => scenario === "long-run-one-year"),
});
