import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { REPO_ROOT } from "../../../../packages/simulator/cli/repo.js";

/**
 * Wave 5 §18 measurement (issue 169). When CLOCKGROVE_WAVE5_EVIDENCE names a directory, which only
 * `pnpm run qualify:wave5` sets, a native world-owner journey writes its database's cognition rows
 * as one sample before the database is reset or the owner stops. Rows carry safe metadata only:
 * statuses, phases, counts, tokens, cost and durations, never message or model text. A NULL cost or
 * token count stays null: unknown, not zero. scripts/ci/qualify-wave5.mjs aggregates the samples.
 */
const SAMPLE_SQL = `SELECT jsonb_build_object(
  'runs', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'status', status, 'outcome', outcome_code, 'activation', activation,
    'tenant', tenant_id, 'world', world_id, 'timeline', timeline_id, 'actor', actor_id,
    'session', session_id,
    'durationMs', (extract(epoch FROM ended_at - started_at) * 1000)::bigint)), '[]')
    FROM clockgrove.agent_runs),
  'steps', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'kind', s.kind, 'status', s.status, 'outcome', s.outcome_code, 'model', s.model,
    'tool', s.tool, 'inputTokens', s.input_tokens, 'outputTokens', s.output_tokens,
    'costMicrousd', s.cost_microusd, 'tenant', r.tenant_id, 'world', r.world_id,
    'timeline', r.timeline_id, 'actor', r.actor_id, 'session', r.session_id,
    'durationMs', (extract(epoch FROM s.ended_at - s.started_at) * 1000)::bigint)), '[]')
    FROM clockgrove.run_steps s JOIN clockgrove.agent_runs r USING (tenant_id, run_id)),
  'fibers', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'phase', phase, 'attempt', attempt, 'leaseEpoch', lease_epoch, 'outcome', outcome_code,
    'durationMs', (extract(epoch FROM updated_at - created_at) * 1000)::bigint)), '[]')
    FROM clockgrove.conversation_turn_fibers),
  'activations', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'reason', coalesce(reason->>'kind', reason->>'type'), 'status', status, 'leader', leader,
    'reserved', has_reservation)), '[]')
    FROM clockgrove.actor_activations),
  'processes', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'state', state, 'segments', segments, 'leaseEpoch', lease_epoch,
    'checkpoint', checkpoint, 'target', target)), '[]')
    FROM clockgrove.actor_processes),
  'effects', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'disposition', disposition, 'outcome', outcome_code, 'reservedMicrousd', reserved_microusd,
    'ageMs', (extract(epoch FROM coalesce(ended_at, statement_timestamp()) - created_at) * 1000)::bigint)), '[]')
    FROM clockgrove.effect_intents),
  'effectAttempts', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'disposition', disposition, 'outcome', outcome_code, 'costMicrousd', cost_microusd)), '[]')
    FROM clockgrove.effect_attempts),
  'approvals', (SELECT coalesce(jsonb_agg(jsonb_build_object('state', state, 'decision', decision)), '[]')
    FROM clockgrove.effect_approvals),
  'deliveries', (SELECT coalesce(jsonb_agg(jsonb_build_object('status', status)), '[]')
    FROM clockgrove.deliveries),
  'deliverySinks', (SELECT coalesce(jsonb_agg(jsonb_build_object('sink', sink)), '[]')
    FROM clockgrove.delivery_sink_receipts)
)::text`;

let samples = 0;

/** Writes this database's §18 sample when qualify:wave5 asked for one; otherwise does nothing. */
export async function recordWave5Observability(
  sql: (statement: string) => Promise<string>,
): Promise<void> {
  const directory = process.env.CLOCKGROVE_WAVE5_EVIDENCE;
  if (directory === undefined || directory === "") return;
  const testPath = expect.getState().testPath ?? "unknown";
  const file = path.relative(REPO_ROOT, testPath).split(path.sep).join("/");
  const target = path.join(directory, "observability");
  await mkdir(target, { recursive: true });
  samples += 1;
  const name = `${file.replaceAll(/[^\w.-]+/gu, "_")}-${process.pid}-${samples}.json`;
  const sample = await sql(SAMPLE_SQL)
    .then((text) => ({ rows: JSON.parse(text) as unknown }))
    .catch((error: Error) => ({ error: error.message.slice(0, 512) }));
  await writeFile(
    path.join(target, name),
    `${JSON.stringify({ file, test: expect.getState().currentTestName ?? null, ...sample })}\n`,
  );
}
