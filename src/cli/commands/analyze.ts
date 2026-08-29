// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BigQuery } from '@google-cloud/bigquery';
import type { Logger } from 'pino';
import { SHILL_SCORE_THRESHOLD } from '../../analysis/collisions.js';
import {
  assertBqConfig,
  bqConfigFromGcp,
  getBigQuery,
  quotedInformationSchemaTables,
  quotedTable,
  runQuery,
  sqlParamOrNull,
  type BqConfig,
} from '../../shared/bq.js';
import { loadEnv, type GcpEnv } from '../../shared/env.js';
import { createLogger } from '../../shared/logger.js';
import {
  printPipelineRunId,
  readLatestRun,
  resolvePipelineRunId,
  RunIdError,
  writeLatestRun,
  type LatestRunFile,
} from '../../shared/run-id.js';

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export const ANALYZE_TABLES = [
  'pipeline_runs',
  'raw_reviews',
  'stage1_filtered',
  'stage2_suspicious_for_gemini',
  'review_embeddings',
  'gemini_review_assessments',
  'gemini_assessment_errors',
  'store_shill_stats',
  'burst_events',
  'cross_store_template_collisions',
  'shill_network_edges',
  'funnel_stats',
] as const;

const ANALYZE_SQL = [
  {
    relativePath: 'sql/analysis/store_shill_stats.sql',
    params: ['pipeline_run_id', 'shill_score_threshold'] as const,
  },
  {
    relativePath: 'sql/analysis/burst_events.sql',
    params: ['pipeline_run_id'] as const,
  },
  {
    relativePath: 'sql/analysis/cross_store_collisions.sql',
    params: ['pipeline_run_id', 'shill_score_threshold'] as const,
  },
  {
    relativePath: 'sql/analysis/semantic_collisions.sql',
    params: ['pipeline_run_id', 'embedding_model', 'threshold'] as const,
  },
  {
    relativePath: 'sql/analysis/shill_network_edges.sql',
    params: ['pipeline_run_id'] as const,
  },
  {
    relativePath: 'sql/analysis/funnel_counts.sql',
    params: ['pipeline_run_id'] as const,
  },
] as const;

export type AnalyzeCliOptions = {
  pipelineRunId?: string;
  continueLatest?: boolean;
};

export type RunAnalyzeOptions = AnalyzeCliOptions & {
  cwd?: string;
  latestPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  stdout?: { write(chunk: string): unknown };
  bigquery?: BigQuery;
  repoRoot?: string;
};

export type AnalyzeCounts = {
  n_store_stats: number;
  n_burst_events: number;
  n_burst_flagged: number;
  n_collisions: number;
  n_edges: number;
  n_funnel: number;
  n_assessed: number;
};

export type AnalyzeCommandResult = AnalyzeCounts & {
  exitCode: number;
  pipeline_run_id: string;
  fromLatest: boolean;
};

type PipelineRunStatus = 'running' | 'succeeded' | 'failed';

type UpdatePipelineRunInput = {
  bq: BigQuery;
  config: BqConfig;
  pipelineRunId: string;
  status: PipelineRunStatus;
  heartbeatAt: Date;
  finishedAt?: Date;
  rowsIn?: number;
  rowsOut?: number;
  errorMessage?: string | null;
};

function asIso(value: Date): string {
  return value.toISOString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isBqNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const rec = err as { code?: unknown; status?: unknown };
  return (
    rec.code === 404 ||
    rec.code === '404' ||
    rec.status === 404 ||
    rec.status === 'NOT_FOUND'
  );
}

function substituteDataset(sql: string, dataset: string): string {
  return sql.replaceAll('ecom_shill', dataset);
}

function readRepoSql(repoRoot: string, relativePath: string, dataset: string): string {
  const sql = readFileSync(path.join(repoRoot, relativePath), 'utf8');
  return substituteDataset(sql, dataset);
}

function asInt(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return asInt((value as { value: unknown }).value, field);
  }
  throw new Error(`analyze expected integer ${field}, got ${String(value)}`);
}

async function assertAnalyzeTablesExist(bq: BigQuery, config: BqConfig): Promise<void> {
  let rows: Record<string, unknown>[];
  try {
    const names = ANALYZE_TABLES.map((name) => `'${name}'`).join(', ');
    rows = await runQuery(
      bq,
      config,
      `SELECT table_name FROM ${quotedInformationSchemaTables(config)}
WHERE table_name IN (${names})`,
    );
  } catch (err) {
    if (isBqNotFoundError(err)) {
      throw new Error('Analyze BigQuery tables missing; run scripts/bq-apply.sh');
    }
    throw err;
  }
  const have = new Set(rows.map((row) => String(row['table_name'] ?? '')));
  const missing = ANALYZE_TABLES.filter((name) => !have.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Analyze BigQuery tables missing (${missing.join(', ')}); run scripts/bq-apply.sh`,
    );
  }
}

async function requireExistingPipelineRun(
  bq: BigQuery,
  config: BqConfig,
  pipelineRunId: string,
): Promise<void> {
  const rows = await runQuery(
    bq,
    config,
    `SELECT pipeline_run_id FROM ${quotedTable(config, 'pipeline_runs')}
WHERE pipeline_run_id = @pipeline_run_id LIMIT 1`,
    { pipeline_run_id: pipelineRunId },
  );
  if (rows.length === 0) {
    throw new RunIdError(
      `pipeline run not found: ${pipelineRunId}; load/layer1 must create it first`,
      2,
    );
  }
}

async function updatePipelineRun(input: UpdatePipelineRunInput): Promise<void> {
  const table = quotedTable(input.config, 'pipeline_runs');
  const finishedAtIso = input.finishedAt === undefined ? undefined : input.finishedAt.toISOString();
  const params: Record<string, unknown> = {
    pipeline_run_id: input.pipelineRunId,
    phase: 'analyze',
    status: input.status,
    heartbeat_at: input.heartbeatAt.toISOString(),
  };
  const finishedAtSql = sqlParamOrNull(params, 'finished_at', finishedAtIso, 'TIMESTAMP');
  const rowsInSql = sqlParamOrNull(params, 'rows_in', input.rowsIn, 'INT64');
  const rowsOutSql = sqlParamOrNull(params, 'rows_out', input.rowsOut, 'INT64');
  const errorSql = sqlParamOrNull(params, 'error_message', input.errorMessage, 'STRING');
  await runQuery(
    input.bq,
    input.config,
    `UPDATE ${table}
SET
  phase = @phase,
  status = @status,
  heartbeat_at = @heartbeat_at,
  finished_at = ${finishedAtSql},
  rows_in = ${rowsInSql},
  rows_out = ${rowsOutSql},
  error_message = ${errorSql}
WHERE pipeline_run_id = @pipeline_run_id`,
    params,
  );
}

async function selectAnalyzeCounts(
  bq: BigQuery,
  config: BqConfig,
  pipelineRunId: string,
): Promise<AnalyzeCounts> {
  const stats = quotedTable(config, 'store_shill_stats');
  const bursts = quotedTable(config, 'burst_events');
  const collisions = quotedTable(config, 'cross_store_template_collisions');
  const edges = quotedTable(config, 'shill_network_edges');
  const funnel = quotedTable(config, 'funnel_stats');
  const assessments = quotedTable(config, 'gemini_review_assessments');
  const rows = await runQuery(
    bq,
    config,
    `SELECT
  stats.n_store_stats,
  bursts.n_burst_events,
  bursts.n_burst_flagged,
  collisions.n_collisions,
  edges.n_edges,
  funnel.n_funnel,
  assessed.n_assessed
FROM (
  SELECT COUNT(*) AS n_store_stats
  FROM ${stats}
  WHERE pipeline_run_id = @pipeline_run_id
) AS stats
CROSS JOIN (
  SELECT
    COUNT(*) AS n_burst_events,
    COUNTIF(is_burst) AS n_burst_flagged
  FROM ${bursts}
  WHERE pipeline_run_id = @pipeline_run_id
) AS bursts
CROSS JOIN (
  SELECT COUNT(*) AS n_collisions
  FROM ${collisions}
  WHERE pipeline_run_id = @pipeline_run_id
) AS collisions
CROSS JOIN (
  SELECT COUNT(*) AS n_edges
  FROM ${edges}
  WHERE pipeline_run_id = @pipeline_run_id
) AS edges
CROSS JOIN (
  SELECT COUNT(*) AS n_funnel
  FROM ${funnel}
  WHERE pipeline_run_id = @pipeline_run_id
) AS funnel
CROSS JOIN (
  SELECT COUNT(*) AS n_assessed
  FROM ${assessments}
  WHERE pipeline_run_id = @pipeline_run_id
) AS assessed`,
    { pipeline_run_id: pipelineRunId },
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('analyze count query returned no rows');
  }
  return {
    n_store_stats: asInt(row['n_store_stats'], 'n_store_stats'),
    n_burst_events: asInt(row['n_burst_events'], 'n_burst_events'),
    n_burst_flagged: asInt(row['n_burst_flagged'], 'n_burst_flagged'),
    n_collisions: asInt(row['n_collisions'], 'n_collisions'),
    n_edges: asInt(row['n_edges'], 'n_edges'),
    n_funnel: asInt(row['n_funnel'], 'n_funnel'),
    n_assessed: asInt(row['n_assessed'], 'n_assessed'),
  };
}

export async function runAnalyze(opts: RunAnalyzeOptions): Promise<AnalyzeCommandResult> {
  const loaded = loadEnv({
    command: 'analyze',
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  const cwd = opts.cwd ?? process.cwd();
  const latestPath = opts.latestPath ?? path.join(cwd, 'data', 'runs', 'latest');
  const resolved = resolvePipelineRunId({
    allowCreate: false,
    latestPath,
    ...(opts.pipelineRunId === undefined ? {} : { pipelineRunId: opts.pipelineRunId }),
    ...(opts.continueLatest === undefined ? {} : { continueLatest: opts.continueLatest }),
  });
  if (loaded.gcp === undefined) {
    throw new Error('GCP_PROJECT, GCP_LOCATION, and BQ_DATASET are required for analyze');
  }
  const gcp: GcpEnv = loaded.gcp;
  const config = bqConfigFromGcp(gcp);
  assertBqConfig(config);
  const logger: Logger = createLogger(loaded.hmac.LOG_LEVEL);
  const bq = opts.bigquery ?? getBigQuery(config);
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;
  const stdout = opts.stdout ?? process.stdout;
  const startedAt = opts.now ?? new Date();
  const embeddingModel = loaded.config.layer2.embedding_model;
  const crossStoreThreshold = loaded.config.cross_store.cosine_distance_threshold;

  await assertAnalyzeTablesExist(bq, config);
  await requireExistingPipelineRun(bq, config, resolved.pipeline_run_id);

  const previousLatest = readLatestRun(latestPath);
  const updateBase = {
    bq,
    config,
    pipelineRunId: resolved.pipeline_run_id,
  };

  let markedRunning = false;
  let terminal: 'succeeded' | 'failed' = 'failed';
  let analyzeError: unknown;
  try {
    await updatePipelineRun({
      ...updateBase,
      status: 'running',
      heartbeatAt: startedAt,
    });
    markedRunning = true;

    const sqlParams: Record<string, unknown> = {
      pipeline_run_id: resolved.pipeline_run_id,
      shill_score_threshold: SHILL_SCORE_THRESHOLD,
      embedding_model: embeddingModel,
      threshold: crossStoreThreshold,
    };

    for (const step of ANALYZE_SQL) {
      const sql = readRepoSql(repoRoot, step.relativePath, config.dataset);
      const params: Record<string, unknown> = {};
      for (const name of step.params) {
        params[name] = sqlParams[name];
      }
      await runQuery(bq, config, sql, params);
    }

    const counts = await selectAnalyzeCounts(bq, config, resolved.pipeline_run_id);

    await updatePipelineRun({
      ...updateBase,
      status: 'succeeded',
      heartbeatAt: new Date(),
      finishedAt: new Date(),
      rowsIn: counts.n_assessed,
      rowsOut: counts.n_edges,
      errorMessage: null,
    });
    terminal = 'succeeded';

    try {
      const latest: LatestRunFile = {
        pipeline_run_id: resolved.pipeline_run_id,
        phase: 'analyze',
        started_at: asIso(startedAt),
      };
      if (
        previousLatest?.crawl_batch_id !== undefined &&
        previousLatest.pipeline_run_id === resolved.pipeline_run_id
      ) {
        latest.crawl_batch_id = previousLatest.crawl_batch_id;
      }
      writeLatestRun(latest, latestPath);
    } catch (latestErr) {
      logger.warn({
        event: 'latest_run_write_failed',
        err: errorMessage(latestErr),
      });
    }
    printPipelineRunId(resolved.pipeline_run_id, stdout);
    logger.info({
      event: 'analyze_done',
      pipeline_run_id: resolved.pipeline_run_id,
      n_store_stats: counts.n_store_stats,
      n_burst_events: counts.n_burst_events,
      n_burst_flagged: counts.n_burst_flagged,
      n_collisions: counts.n_collisions,
      n_edges: counts.n_edges,
      n_funnel: counts.n_funnel,
      n_assessed: counts.n_assessed,
      shill_score_threshold: SHILL_SCORE_THRESHOLD,
      cross_store_threshold: crossStoreThreshold,
    });

    return {
      exitCode: 0,
      pipeline_run_id: resolved.pipeline_run_id,
      fromLatest: resolved.fromLatest,
      ...counts,
    };
  } catch (err) {
    analyzeError = err;
    throw err;
  } finally {
    if (markedRunning && terminal === 'failed') {
      try {
        await updatePipelineRun({
          ...updateBase,
          status: 'failed',
          heartbeatAt: new Date(),
          finishedAt: new Date(),
          errorMessage: errorMessage(analyzeError ?? 'analyze failed'),
        });
      } catch (statusErr) {
        logger.warn({
          event: 'pipeline_run_status_update_failed',
          err: errorMessage(statusErr),
        });
      }
    }
  }
}

export async function analyzeAction(opts: AnalyzeCliOptions): Promise<void> {
  try {
    const result = await runAnalyze(opts);
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
  } catch (err) {
    const message = errorMessage(err);
    process.stderr.write(`${message}\n`);
    if (err instanceof RunIdError) {
      process.exitCode = err.exitCode;
      return;
    }
    process.exitCode = 1;
  }
}
