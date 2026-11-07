# Design-risk checklist

Six questions every change answers, for contributors human or agent. Each has its reason and what a good answer looks like. They name the defects that passed every review of issue 699.

## When to use it

- Before writing code, answer all six in a short design note (the Work Item, PR description or plan). A question that does not apply gets "n/a" and why. Design faults are cheapest to fix before code exists.
- At handoff, answer them again with `file:line` evidence. The reviewer checks each answer against the code, not against the note.

## The questions

1. **Authority.** Who may trigger each new action or state change, through which grant? Is it the narrowest grant that fits?
   - Reason: a new power riding on a broad existing grant gives every holder of that grant the new power (issue 725: clock control had no permission of its own).
   - Good: "clock control needs `runtime:world-clock`, not the broad `runtime:world-command`; checked in `x.ts:42`."
2. **Growth and retention.** Does any new table, row set, key or queue grow with time or traffic? What bounds or retires it?
   - Reason: append-only storage grows for the life of a world unless something bounds it.
   - Good: "one row per partition, updated in place", or "compacted behind the snapshot horizon by `y.ts:10`". Every append-only table has an entry in `db/retention.json`; `pnpm check` enforces it.
3. **Identity and attribution.** Who is each new action attributed to? Is that identity stable and meaningful?
   - Reason: autonomous work credited to whichever principal happened to be at hand makes audit and authorization lie.
   - Good: "the world's system principal, fixed at birth", not "the first member found".
4. **Hot-path cost.** What does the change add to every request or command: queries, transactions, round trips?
   - Reason: a per-request cost multiplies by all traffic and is invisible in single-run tests.
   - Good: "one indexed read inside the existing command transaction; no new round trip."
5. **Test independence.** Could the same bug pass the test because the expected side uses the code under test?
   - Reason: a reference that shares the implementation agrees with it by construction (issue 728, item 1).
   - Good: the expected side comes from an independent source: the pure simulator, a committed golden, literal values.
6. **Sourced numbers.** Does every limit, budget, retry count or timeout cite its source, or is it stated as an explicit decision with its reason?
   - Reason: invented numbers ("four attempts after 250 ms") look authoritative and get copied as requirements.
   - Good: "30 s, from the Cloudflare request limit (link)" or "decision: 3 retries, because the lease expires after 4."
