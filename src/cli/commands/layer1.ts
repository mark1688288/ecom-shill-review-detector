// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BigQuery } from '@google-cloud/bigquery';
import type { Logger } from 'pino';
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
import { loadEnv, type AppConfig, type GcpEnv } from '../../shared/env.js';
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

const LAYER1_TABLES = [
  'raw_reviews',
  'stage1_filtered',
  'layer1_exclusion_audit',
  'logistics_canned_phrases',
  'pipeline_runs',
] as const;

export type Layer1CliOptions = {
  pipelineRunId?: string;
  continueLatest?: boolean;
};

export type RunLayer1Options = Layer1CliOptions & {
  cwd?: string;
  latestPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  stdout?: { write(chunk: string): unknown };
  bigquery?: BigQuery;
  repoRoot?: string;
};

export type Layer1CommandResult = {
  exitCode: number;
  pipeline_run_id: string;
  createdRun: boolean;
  fromLatest: boolean;
  n_in: number;
  n_out: number;
  n_non_five_star: number;
  n_too_short: number;
  n_pure_logistics: number;
};

type PipelineRunStatus = 'running' | 'succeeded' | 'failed';

type UpsertPipelineRunInput = {
  bq: BigQuery;
  config: BqConfig;
  appConfig: AppConfig;
  pipelineRunId: string;
  status: PipelineRunStatus;
  startedAt: Date;
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
  throw new Error(`layer1 expected integer ${field}, got ${String(value)}`);
}

async function assertLayer1TablesExist(bq: BigQuery, config: BqConfig): Promise<void> {
  let rows: Record<string, unknown>[];
  try {
    const names = LAYER1_TABLES.map((name) => `'${name}'`).join(', ');
    rows = await runQuery(
      bq,
      config,
      `SELECT table_name FROM ${quotedInformationSchemaTables(config)}
WHERE table_name IN (${names})`,
    );
  } catch (err) {
    if (isBqNotFoundError(err)) {
      throw new Error('Layer 1 BigQuery tables missing; run scripts/bq-apply.sh');
    }
    throw err;
  }
  const have = new Set(rows.map((row) => String(row['table_name'] ?? '')));
  const missing = LAYER1_TABLES.filter((name) => !have.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Layer 1 BigQuery tables missing (${missing.join(', ')}); run scripts/bq-apply.sh`,
    );
  }
}

async function upsertPipelineRun(input: UpsertPipelineRunInput): Promise<void> {
  const table = quotedTable(input.config, 'pipeline_runs');
  const existing = await runQuery(
    input.bq,
    input.config,
    `SELECT pipeline_run_id FROM ${table} WHERE pipeline_run_id = @pipeline_run_id LIMIT 1`,
    { pipeline_run_id: input.pipelineRunId },
  );
  const heartbeatAt = input.finishedAt ?? input.startedAt;
  const finishedAtIso = input.finishedAt === undefined ? undefined : input.finishedAt.toISOString();
  if (existing.length === 0) {
    const params: Record<string, unknown> = {
      pipeline_run_id: input.pipelineRunId,
      phase: 'layer1',
      status: input.status,
      seed_version: input.appConfig.seed_version,
      embedding_model: input.appConfig.layer2.embedding_model,
      gemini_model: input.appConfig.gemini.model,
      cosine_distance_threshold: input.appConfig.layer2.cosine_distance_threshold,
      heartbeat_at: heartbeatAt.toISOString(),
      started_at: input.startedAt.toISOString(),
    };
    const finishedAtSql = sqlParamOrNull(params, 'finished_at', finishedAtIso, 'TIMESTAMP');
    const rowsInSql = sqlParamOrNull(params, 'rows_in', input.rowsIn, 'INT64');
    const rowsOutSql = sqlParamOrNull(params, 'rows_out', input.rowsOut, 'INT64');
    const errorSql = sqlParamOrNull(params, 'error_message', input.errorMessage, 'STRING');
    await runQuery(
      input.bq,
      input.config,
      `INSERT INTO ${table} (
  pipeline_run_id,
  phase,
  status,
  seed_version,
  embedding_model,
  gemini_model,
  cosine_distance_threshold,
  heartbeat_at,
  started_at,
  finished_at,
  rows_in,
  rows_out,
  error_message
) VALUES (
  @pipeline_run_id,
  @phase,
  @status,
  @seed_version,
  @embedding_model,
  @gemini_model,
  @cosine_distance_threshold,
  @heartbeat_at,
  @started_at,
  ${finishedAtSql},
  ${rowsInSql},
  ${rowsOutSql},
  ${errorSql}
)`,
      params,
    );
    return;
  }
  const params: Record<string, unknown> = {
    pipeline_run_id: input.pipelineRunId,
    phase: 'layer1',
    status: input.status,
    heartbeat_at: heartbeatAt.toISOString(),
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

async function selectFunnelCounts(
  bq: BigQuery,
  config: BqConfig,
  pipelineRunId: string,
): Promise<{
  n_in: number;
  n_out: number;
  n_non_five_star: number;
  n_too_short: number;
  n_pure_logistics: number;
}> {
  const audit = quotedTable(config, 'layer1_exclusion_audit');
  const stage1 = quotedTable(config, 'stage1_filtered');
  const rows = await runQuery(
    bq,
    config,
    `SELECT
  audit.n_in,
  stage.n_out,
  audit.n_non_five_star,
  audit.n_too_short,
  audit.n_pure_logistics
FROM (
  SELECT
    COUNT(*) AS n_in,
    COUNTIF(exclusion_reason = 'non_five_star') AS n_non_five_star,
    COUNTIF(exclusion_reason = 'too_short') AS n_too_short,
    COUNTIF(exclusion_reason = 'pure_logistics') AS n_pure_logistics
  FROM ${audit}
  WHERE pipeline_run_id = @pipeline_run_id
) AS audit
CROSS JOIN (
  SELECT COUNT(*) AS n_out
  FROM ${stage1}
  WHERE pipeline_run_id = @pipeline_run_id
) AS stage`,
    { pipeline_run_id: pipelineRunId },
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('layer1 funnel count query returned no rows');
  }
  return {
    n_in: asInt(row['n_in'], 'n_in'),
    n_out: asInt(row['n_out'], 'n_out'),
    n_non_five_star: asInt(row['n_non_five_star'], 'n_non_five_star'),
    n_too_short: asInt(row['n_too_short'], 'n_too_short'),
    n_pure_logistics: asInt(row['n_pure_logistics'], 'n_pure_logistics'),
  };
}

export async function runLayer1(opts: RunLayer1Options): Promise<Layer1CommandResult> {
  const loaded = loadEnv({
    command: 'layer1',
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  const cwd = opts.cwd ?? process.cwd();
  const latestPath = opts.latestPath ?? path.join(cwd, 'data', 'runs', 'latest');
  const resolved = resolvePipelineRunId({
    allowCreate: true,
    latestPath,
    ...(opts.pipelineRunId === undefined ? {} : { pipelineRunId: opts.pipelineRunId }),
    ...(opts.continueLatest === undefined ? {} : { continueLatest: opts.continueLatest }),
  });
  if (loaded.gcp === undefined) {
    throw new Error('GCP_PROJECT, GCP_LOCATION, and BQ_DATASET are required for layer1');
  }
  const gcp: GcpEnv = loaded.gcp;
  const config = bqConfigFromGcp(gcp);
  assertBqConfig(config);
  const logger: Logger = createLogger(loaded.hmac.LOG_LEVEL);
  const bq = opts.bigquery ?? getBigQuery(config);
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;
  const stdout = opts.stdout ?? process.stdout;
  const startedAt = opts.now ?? new Date();

  await assertLayer1TablesExist(bq, config);

  const previousLatest = readLatestRun(latestPath);

  let markedRunning = false;
  let terminal: 'succeeded' | 'failed' = 'failed';
  let layer1Error: unknown;
  try {
    await upsertPipelineRun({
      bq,
      config,
      appConfig: loaded.config,
      pipelineRunId: resolved.pipeline_run_id,
      status: 'running',
      startedAt,
    });
    markedRunning = true;

    const seedsSql = readRepoSql(repoRoot, 'sql/seeds/logistics_canned_phrases.sql', config.dataset);
    await runQuery(bq, config, seedsSql);

    const filterSql = readRepoSql(repoRoot, 'sql/layer1/filter_stage1.sql', config.dataset);
    const debugSql = readRepoSql(repoRoot, 'sql/layer1/debug_exclusions.sql', config.dataset);
    await runQuery(bq, config, `${filterSql}\n${debugSql}\n`, {
      pipeline_run_id: resolved.pipeline_run_id,
    });

    const funnel = await selectFunnelCounts(bq, config, resolved.pipeline_run_id);

    await upsertPipelineRun({
      bq,
      config,
      appConfig: loaded.config,
      pipelineRunId: resolved.pipeline_run_id,
      status: 'succeeded',
      startedAt,
      finishedAt: new Date(),
      rowsIn: funnel.n_in,
      rowsOut: funnel.n_out,
      errorMessage: null,
    });
    terminal = 'succeeded';

    try {
      const latest: LatestRunFile = {
        pipeline_run_id: resolved.pipeline_run_id,
        phase: 'layer1',
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
      event: 'funnel_layer1',
      pipeline_run_id: resolved.pipeline_run_id,
      n_in: funnel.n_in,
      n_out: funnel.n_out,
      n_non_five_star: funnel.n_non_five_star,
      n_too_short: funnel.n_too_short,
      n_pure_logistics: funnel.n_pure_logistics,
    });

    return {
      exitCode: 0,
      pipeline_run_id: resolved.pipeline_run_id,
      createdRun: resolved.created,
      fromLatest: resolved.fromLatest,
      n_in: funnel.n_in,
      n_out: funnel.n_out,
      n_non_five_star: funnel.n_non_five_star,
      n_too_short: funnel.n_too_short,
      n_pure_logistics: funnel.n_pure_logistics,
    };
  } catch (err) {
    layer1Error = err;
    throw err;
  } finally {
    if (markedRunning && terminal === 'failed') {
      try {
        await upsertPipelineRun({
          bq,
          config,
          appConfig: loaded.config,
          pipelineRunId: resolved.pipeline_run_id,
          status: 'failed',
          startedAt,
          finishedAt: new Date(),
          errorMessage: errorMessage(layer1Error ?? 'layer1 failed'),
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

export async function layer1Action(opts: Layer1CliOptions): Promise<void> {
  try {
    const result = await runLayer1(opts);
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
