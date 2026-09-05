// SPDX-License-Identifier: GPL-3.0-only
import type { BigQuery } from '@google-cloud/bigquery';
import type { Logger } from 'pino';
import {
  quotedJobsByProject,
  runQuery,
  runQueryWithJob,
  type BqConfig,
} from './bq.js';

/** Informational. CI must not assert these as SLAs. */
export const FUNNEL_STAGE2_OF_RAW_LOOSE = 0.15;
export const FUNNEL_STAGE2_OF_RAW_TIGHT = 0.01;

export type FunnelTightness = 'ok' | 'loose' | 'tight' | 'unknown';

export type FunnelTightnessInput = {
  pipeline_run_id: string;
  pct_stage2_of_raw: number | null;
  n_raw?: number | null;
  n_stage1?: number | null;
  n_stage2?: number | null;
};

export type JobBytesRow = {
  total_bytes_processed: number | null;
  total_slot_ms: number | null;
  cache_hit: boolean | null;
};

export type ProcessCounters = {
  gemini_cost_usd_est: number | null;
  gemini_error_rate: number;
  signal_span_mismatch_total: number;
};

export function parseBqNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return parseBqNumber((value as { value: unknown }).value);
  }
  return null;
}

export function parseBqBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true' || value === 'TRUE') {
    return true;
  }
  if (value === 'false' || value === 'FALSE') {
    return false;
  }
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return parseBqBoolean((value as { value: unknown }).value);
  }
  return null;
}

export function classifyFunnelTightness(pctStage2OfRaw: number | null): FunnelTightness {
  if (pctStage2OfRaw === null || !Number.isFinite(pctStage2OfRaw)) {
    return 'unknown';
  }
  if (pctStage2OfRaw > FUNNEL_STAGE2_OF_RAW_LOOSE) {
    return 'loose';
  }
  if (pctStage2OfRaw < FUNNEL_STAGE2_OF_RAW_TIGHT) {
    return 'tight';
  }
  return 'ok';
}

export function logFunnelTightness(logger: Logger, input: FunnelTightnessInput): FunnelTightness {
  const tightness = classifyFunnelTightness(input.pct_stage2_of_raw);
  if (tightness === 'loose' || tightness === 'tight') {
    logger.warn({
      event: tightness === 'loose' ? 'funnel_stage2_loose' : 'funnel_stage2_tight',
      pipeline_run_id: input.pipeline_run_id,
      pct_stage2_of_raw: input.pct_stage2_of_raw,
      n_raw: input.n_raw ?? null,
      n_stage1: input.n_stage1 ?? null,
      n_stage2: input.n_stage2 ?? null,
    });
  }
  return tightness;
}

export function geminiErrorRate(nErrors: number, nAttempted: number): number {
  if (nAttempted <= 0) {
    return 0;
  }
  return nErrors / nAttempted;
}

export function summarizeGeminiCostUsd(opts: {
  thinkingNotOff: boolean;
  estimates: ReadonlyArray<number | null>;
}): number | null {
  if (opts.thinkingNotOff) {
    return null;
  }
  if (opts.estimates.length === 0) {
    return null;
  }
  let sum = 0;
  for (const value of opts.estimates) {
    if (value === null || !Number.isFinite(value)) {
      return null;
    }
    sum += value;
  }
  return sum;
}

export function logPipelineCounters(
  logger: Logger,
  pipelineRunId: string,
  counters: ProcessCounters,
): void {
  logger.info({
    event: 'pipeline_counters',
    pipeline_run_id: pipelineRunId,
    gemini_cost_usd_est: counters.gemini_cost_usd_est,
    gemini_error_rate: counters.gemini_error_rate,
    signal_span_mismatch_total: counters.signal_span_mismatch_total,
  });
}

export function isJobsByProjectQuery(sql: string): boolean {
  return sql.includes('INFORMATION_SCHEMA.JOBS_BY_PROJECT');
}

export function buildJobBytesSql(config: BqConfig): string {
  return `SELECT total_bytes_processed, total_slot_ms, cache_hit
FROM ${quotedJobsByProject(config)}
WHERE job_id = @job_id
ORDER BY creation_time DESC
LIMIT 1`;
}

export async function logJobBytes(
  bq: BigQuery,
  config: BqConfig,
  jobId: string,
  logger: Logger | undefined,
): Promise<JobBytesRow | undefined> {
  try {
    const rows = await runQuery(bq, config, buildJobBytesSql(config), { job_id: jobId });
    const row = rows[0];
    if (row === undefined) {
      logger?.warn({ event: 'bq_job_bytes_unavailable', job_id: jobId, err: 'no JOBS_BY_PROJECT row' });
      return undefined;
    }
    const parsed: JobBytesRow = {
      total_bytes_processed: parseBqNumber(row['total_bytes_processed']),
      total_slot_ms: parseBqNumber(row['total_slot_ms']),
      cache_hit: parseBqBoolean(row['cache_hit']),
    };
    if (parsed.total_bytes_processed !== null) {
      logger?.info({
        event: 'bq_job_bytes',
        job_id: jobId,
        bq_job_bytes: parsed.total_bytes_processed,
        total_slot_ms: parsed.total_slot_ms,
        cache_hit: parsed.cache_hit,
      });
      return parsed;
    }
  } catch (err) {
    logger?.warn({
      event: 'bq_job_bytes_unavailable',
      job_id: jobId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return undefined;
}

export async function runQueryLogged(
  bq: BigQuery,
  config: BqConfig,
  query: string,
  params: Record<string, unknown> | undefined,
  logger: Logger | undefined,
): Promise<Record<string, unknown>[]> {
  const result = await runQueryWithJob(bq, config, query, params);
  if (
    logger !== undefined &&
    result.jobId !== undefined &&
    !isJobsByProjectQuery(query)
  ) {
    await logJobBytes(bq, config, result.jobId, logger);
  }
  return result.rows;
}
