import { LONG_RUNS } from "./journal-long-runs.js";
import { journalParityLongRuns } from "./journal-parity-long-run.js";

// pnpm test:long-run (qualification, not per-PR CI): every committed Wave 1 scenario with its
// variants and the 30-day long runs, through the Journal against real PostgreSQL. The one-year run
// is journal-parity-one-year.long-run.test.ts, in parallel with this file. The per-PR subset runs
// in journal-parity.postgres.test.ts.

journalParityLongRuns("scenarios-and-30-days", {
  scenarios: true,
  longRuns: LONG_RUNS.filter(([, scenario]) => scenario !== "long-run-one-year"),
});
