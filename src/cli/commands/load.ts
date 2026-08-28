// SPDX-License-Identifier: GPL-3.0-only
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BigQuery } from '@google-cloud/bigquery';
import type { Storage } from '@google-cloud/storage';
import type { Logger } from 'pino';
import {
  executeLoadAndMerge,
  type LoadMergeResult,
  type LoadMode,
} from '../../crawler/persist/bq-load.js';
import {
  lastWriteWins,
  readReviewsNdjson,
  serializeReviewsNdjson,
  type RawReviewNdjson,
} from '../../crawler/persist/ndjson.js';
import {
  assertBqConfig,
  bqConfigFromGcp,
  getBigQuery,
  quotedTable,
  runQuery,
  sqlParamOrNull,
  type BqConfig,
} from '../../shared/bq.js';
import { loadEnv, type AppConfig, type GcpEnv } from '../../shared/env.js';
import { createLogger } from '../../shared/logger.js';
import {
  printPipelineRunId,
  resolvePipelineRunId,
  RunIdError,
  writeLatestRun,
} from '../../shared/run-id.js';

export type LoadCliOptions = {
  ndjson?: string;
  gcsUri?: string;
  loadMode?: string;
  dataset?: string;
  dryRun?: boolean;
  pipelineRunId?: string;
  continueLatest?: boolean;
};

export type RunLoadOptions = LoadCliOptions & {
  cwd?: string;
  latestPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  stdout?: { write(chunk: string): unknown };
  bigquery?: BigQuery;
  storage?: Storage;
};

export type LoadCommandResult = {
  exitCode: number;
  pipeline_run_id: string;
  crawl_batch_id?: string;
  n_read: number;
  n_deduped: number;
  n_inserted: number;
  n_updated: number;
  n_unchanged: number;
  n_already_present: number;
  stagingTable?: string;
  createdRun: boolean;
  fromLatest: boolean;
  gcsUri?: string;
};

function parseLoadMode(value: string | undefined): LoadMode {
  const mode = value ?? 'gcs';
  if (mode !== 'gcs' && mode !== 'direct') {
    throw new Error(`unknown --load-mode ${mode} (expected gcs|direct)`);
  }
  return mode;
}

function resolveNdjsonPath(ndjson: string, cwd: string): string {
  return path.isAbsolute(ndjson) ? ndjson : path.join(cwd, ndjson);
}

function uniqueCrawlBatchId(rows: RawReviewNdjson[]): string {
  const ids = new Set(rows.map((row) => row.crawl_batch_id));
  if (ids.size === 0) {
    throw new Error('--ndjson has no rows');
  }
  if (ids.size !== 1) {
    throw new Error(
      `NDJSON has mixed crawl_batch_id values after last-write-wins (${String(ids.size)} distinct); load one batch at a time`,
    );
  }
  const only = [...ids][0];
  if (only === undefined) {
    throw new Error('--ndjson has no crawl_batch_id');
  }
  return only;
}

function asIso(value: Date): string {
  return value.toISOString();
}

type PipelineRunStatus = 'running' | 'succeeded' | 'failed';

type UpsertPipelineRunInput = {
  bq: BigQuery;
  config: BqConfig;
  appConfig: AppConfig;
  pipelineRunId: string;
  crawlBatchId: string;
  status: PipelineRunStatus;
  startedAt: Date;
  finishedAt?: Date;
  rowsIn?: number;
  rowsOut?: number;
  errorMessage?: string | null;
};

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
  const params: Record<string, unknown> = {
    pipeline_run_id: input.pipelineRunId,
    phase: 'load',
    status: input.status,
    crawl_batch_id: input.crawlBatchId,
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
  if (existing.length === 0) {
    await runQuery(
      input.bq,
      input.config,
      `INSERT INTO ${table} (
  pipeline_run_id,
  phase,
  status,
  crawl_batch_id,
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
  @crawl_batch_id,
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
  await runQuery(
    input.bq,
    input.config,
    `UPDATE ${table}
SET
  phase = @phase,
  status = @status,
  crawl_batch_id = @crawl_batch_id,
  seed_version = @seed_version,
  embedding_model = @embedding_model,
  gemini_model = @gemini_model,
  cosine_distance_threshold = @cosine_distance_threshold,
  heartbeat_at = @heartbeat_at,
  started_at = @started_at,
  finished_at = ${finishedAtSql},
  rows_in = ${rowsInSql},
  rows_out = ${rowsOutSql},
  error_message = ${errorSql}
WHERE pipeline_run_id = @pipeline_run_id`,
    params,
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runLoad(opts: RunLoadOptions): Promise<LoadCommandResult> {
  const dryRun = opts.dryRun === true;
  if (opts.ndjson === undefined || opts.ndjson.length === 0) {
    throw new Error('--ndjson is required');
  }

  const loaded = loadEnv({
    command: 'load',
    dryRun,
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
  const ndjsonPath = resolveNdjsonPath(opts.ndjson, cwd);
  if (!existsSync(ndjsonPath)) {
    throw new Error(`--ndjson not found: ${ndjsonPath}`);
  }

  const parsed = readReviewsNdjson(ndjsonPath);
  const { rows: unique, n_deduped } = lastWriteWins(parsed);
  const crawl_batch_id = uniqueCrawlBatchId(unique);
  const rows: RawReviewNdjson[] = unique.map((row) => ({
    ...row,
    pipeline_run_id: resolved.pipeline_run_id,
  }));
  const stdout = opts.stdout ?? process.stdout;
  const startedAt = opts.now ?? new Date();

  if (dryRun) {
    return {
      exitCode: 0,
      pipeline_run_id: resolved.pipeline_run_id,
      crawl_batch_id,
      n_read: parsed.length,
      n_deduped,
      n_inserted: 0,
      n_updated: 0,
      n_unchanged: 0,
      n_already_present: 0,
      createdRun: resolved.created,
      fromLatest: resolved.fromLatest,
    };
  }

  if (loaded.gcp === undefined) {
    throw new Error('GCP_PROJECT, GCP_LOCATION, and BQ_DATASET are required for load');
  }
  const gcp: GcpEnv = loaded.gcp;
  const config = bqConfigFromGcp(
    gcp,
    opts.dataset === undefined || opts.dataset.length === 0 ? undefined : opts.dataset,
  );
  assertBqConfig(config);
  const logger: Logger = createLogger(loaded.hmac.LOG_LEVEL);
  const bq = opts.bigquery ?? getBigQuery(config);
  const mode = parseLoadMode(opts.loadMode);

  logger.info({
    event: 'load_started',
    pipeline_run_id: resolved.pipeline_run_id,
    crawl_batch_id,
    n_rows: rows.length,
    load_mode: mode,
  });

  let markedRunning = false;
  let merge: LoadMergeResult | undefined;
  let terminal: 'succeeded' | 'failed' = 'failed';
  let loadError: unknown;
  try {
    await upsertPipelineRun({
      bq,
      config,
      appConfig: loaded.config,
      pipelineRunId: resolved.pipeline_run_id,
      crawlBatchId: crawl_batch_id,
      status: 'running',
      startedAt,
      rowsIn: rows.length,
    });
    markedRunning = true;

    merge = await executeLoadAndMerge({
      config,
      rows,
      ndjsonBody: serializeReviewsNdjson(rows),
      crawlBatchId: crawl_batch_id,
      mode,
      ...(opts.gcsUri === undefined ? {} : { gcsUri: opts.gcsUri }),
      ...(gcp.GCS_STAGING_BUCKET === undefined ? {} : { stagingBucket: gcp.GCS_STAGING_BUCKET }),
      bq,
      ...(opts.storage === undefined ? {} : { storage: opts.storage }),
      logger,
    });

    await upsertPipelineRun({
      bq,
      config,
      appConfig: loaded.config,
      pipelineRunId: resolved.pipeline_run_id,
      crawlBatchId: crawl_batch_id,
      status: 'succeeded',
      startedAt,
      finishedAt: new Date(),
      rowsIn: rows.length,
      rowsOut: merge.n_inserted + merge.n_updated,
      errorMessage: null,
    });
    terminal = 'succeeded';

    try {
      writeLatestRun(
        {
          pipeline_run_id: resolved.pipeline_run_id,
          crawl_batch_id,
          phase: 'load',
          started_at: asIso(startedAt),
        },
        latestPath,
      );
    } catch (latestErr) {
      logger.warn({
        event: 'latest_run_write_failed',
        err: errorMessage(latestErr),
      });
    }
    printPipelineRunId(resolved.pipeline_run_id, stdout);
    logger.info({
      event: 'load_merged',
      pipeline_run_id: resolved.pipeline_run_id,
      crawl_batch_id,
      n_inserted: merge.n_inserted,
      n_updated: merge.n_updated,
      n_unchanged: merge.n_unchanged,
      n_already_present: merge.n_already_present,
    });

    const result: LoadCommandResult = {
      exitCode: 0,
      pipeline_run_id: resolved.pipeline_run_id,
      crawl_batch_id,
      n_read: parsed.length,
      n_deduped,
      n_inserted: merge.n_inserted,
      n_updated: merge.n_updated,
      n_unchanged: merge.n_unchanged,
      n_already_present: merge.n_already_present,
      stagingTable: merge.stagingTable,
      createdRun: resolved.created,
      fromLatest: resolved.fromLatest,
    };
    if (merge.gcsUri !== undefined) {
      result.gcsUri = merge.gcsUri;
    }
    return result;
  } catch (err) {
    loadError = err;
    throw err;
  } finally {
    if (markedRunning && terminal === 'failed') {
      try {
        await upsertPipelineRun({
          bq,
          config,
          appConfig: loaded.config,
          pipelineRunId: resolved.pipeline_run_id,
          crawlBatchId: crawl_batch_id,
          status: 'failed',
          startedAt,
          finishedAt: new Date(),
          rowsIn: rows.length,
          errorMessage: errorMessage(loadError ?? 'load failed'),
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

export async function loadAction(opts: LoadCliOptions): Promise<void> {
  try {
    const result = await runLoad(opts);
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
