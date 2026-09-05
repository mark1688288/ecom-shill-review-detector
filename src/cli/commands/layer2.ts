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
  quotedInformationSchemaModels,
  quotedInformationSchemaTables,
  quotedTable,
  runQuery,
  sqlParamOrNull,
  type BqConfig,
} from '../../shared/bq.js';
import { loadEnv, type GcpEnv } from '../../shared/env.js';
import { createLogger } from '../../shared/logger.js';
import { runQueryLogged } from '../../shared/metrics.js';
import {
  printPipelineRunId,
  readLatestRun,
  resolvePipelineRunId,
  RunIdError,
  writeLatestRun,
  type LatestRunFile,
} from '../../shared/run-id.js';

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export const DEFAULT_BQ_CONNECTION_ID = 'ecom_shill_vertex';
export const EXPECTED_EMBEDDING_DIM = 768;
const CONNECTION_ID = /^[A-Za-z0-9_]+$/;
const EMBEDDING_MODEL_ID = /^[A-Za-z0-9._-]+$/;

const LAYER2_TABLES = [
  'pipeline_runs',
  'stage1_filtered',
  'pr_seed_phrases',
  'review_embeddings',
  'seed_embeddings',
  'stage2_suspicious_for_gemini',
] as const;

export type Layer2CliOptions = {
  pipelineRunId?: string;
  continueLatest?: boolean;
  seedVersion?: string;
};

export type RunLayer2Options = Layer2CliOptions & {
  cwd?: string;
  latestPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  stdout?: { write(chunk: string): unknown };
  bigquery?: BigQuery;
  repoRoot?: string;
};

export type Layer2CommandResult = {
  exitCode: number;
  pipeline_run_id: string;
  fromLatest: boolean;
  seed_version: string;
  embedding_model: string;
  threshold: number;
  n_stage1: number;
  n_embedded_ok: number;
  n_embedded_err: number;
  n_suspicious: number;
  embedding_dim: number | null;
  model_created: boolean;
};

type PipelineRunStatus = 'running' | 'succeeded' | 'failed';

type UpdatePipelineRunInput = {
  bq: BigQuery;
  config: BqConfig;
  pipelineRunId: string;
  status: PipelineRunStatus;
  seedVersion: string;
  embeddingModel: string;
  threshold: number;
  heartbeatAt: Date;
  finishedAt?: Date;
  rowsIn?: number;
  rowsOut?: number;
  errorMessage?: string | null;
};

export type RemoteModelVars = {
  project: string;
  location: string;
  dataset: string;
  connectionId: string;
  embeddingModel: string;
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
  const rec = err as { code?: unknown; status?: unknown; message?: unknown };
  if (
    rec.code === 404 ||
    rec.code === '404' ||
    rec.status === 404 ||
    rec.status === 'NOT_FOUND'
  ) {
    return true;
  }
  const message = typeof rec.message === 'string' ? rec.message : errorMessage(err);
  return /404|not found/i.test(message);
}

export function formatCreateModelFailure(err: unknown, embeddingModel: string): string {
  const original = errorMessage(err);
  if (isBqNotFoundError(err) && embeddingModel === 'text-multilingual-embedding-002') {
    return (
      `CREATE MODEL 404 for text-multilingual-embedding-002 in this region. ` +
      `Stop. Do not silently switch to text-embedding-004. Original: ${original}`
    );
  }
  if (isBqNotFoundError(err)) {
    return `CREATE MODEL 404 for ${embeddingModel}. Stop. Original: ${original}`;
  }
  return `CREATE MODEL failed for ${embeddingModel}: ${original}`;
}

export function renderRemoteModelSql(sql: string, vars: RemoteModelVars): string {
  if (!CONNECTION_ID.test(vars.connectionId)) {
    throw new Error(`invalid BQ_CONNECTION_ID: ${vars.connectionId}`);
  }
  if (!EMBEDDING_MODEL_ID.test(vars.embeddingModel)) {
    throw new Error(`invalid EMBEDDING_MODEL: ${vars.embeddingModel}`);
  }
  const rendered = sql
    .replaceAll('__GCP_PROJECT__', vars.project)
    .replaceAll('__GCP_LOCATION__', vars.location)
    .replaceAll('__BQ_CONNECTION_ID__', vars.connectionId)
    .replaceAll('__EMBEDDING_MODEL__', vars.embeddingModel)
    .replaceAll('__DATASET__', vars.dataset);
  if (rendered.includes('__')) {
    throw new Error('remote model SQL still contains unsubstituted placeholders');
  }
  return rendered;
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
  throw new Error(`layer2 expected integer ${field}, got ${String(value)}`);
}

async function assertLayer2TablesExist(bq: BigQuery, config: BqConfig): Promise<void> {
  let rows: Record<string, unknown>[];
  try {
    const names = LAYER2_TABLES.map((name) => `'${name}'`).join(', ');
    rows = await runQuery(
      bq,
      config,
      `SELECT table_name FROM ${quotedInformationSchemaTables(config)}
WHERE table_name IN (${names})`,
    );
  } catch (err) {
    if (isBqNotFoundError(err)) {
      throw new Error('Layer 2 BigQuery tables missing; run scripts/bq-apply.sh');
    }
    throw err;
  }
  const have = new Set(rows.map((row) => String(row['table_name'] ?? '')));
  const missing = LAYER2_TABLES.filter((name) => !have.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Layer 2 BigQuery tables missing (${missing.join(', ')}); run scripts/bq-apply.sh`,
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
    phase: 'layer2',
    status: input.status,
    seed_version: input.seedVersion,
    embedding_model: input.embeddingModel,
    cosine_distance_threshold: input.threshold,
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
  seed_version = @seed_version,
  embedding_model = @embedding_model,
  cosine_distance_threshold = @cosine_distance_threshold,
  heartbeat_at = @heartbeat_at,
  finished_at = ${finishedAtSql},
  rows_in = ${rowsInSql},
  rows_out = ${rowsOutSql},
  error_message = ${errorSql}
WHERE pipeline_run_id = @pipeline_run_id`,
    params,
  );
}

async function remoteModelExists(bq: BigQuery, config: BqConfig): Promise<boolean> {
  try {
    const rows = await runQuery(
      bq,
      config,
      `SELECT model_name FROM ${quotedInformationSchemaModels(config)}
WHERE model_name = 'text_embedding' LIMIT 1`,
    );
    return rows.length > 0;
  } catch (err) {
    if (isBqNotFoundError(err)) {
      return false;
    }
    throw err;
  }
}

async function ensureRemoteModel(opts: {
  bq: BigQuery;
  config: BqConfig;
  repoRoot: string;
  gcp: GcpEnv;
  embeddingModel: string;
  logger: Logger;
}): Promise<boolean> {
  if (await remoteModelExists(opts.bq, opts.config)) {
    return false;
  }
  const connectionId = opts.gcp.BQ_CONNECTION_ID ?? DEFAULT_BQ_CONNECTION_ID;
  const raw = readFileSync(path.join(opts.repoRoot, 'sql/ddl/06_remote_models.sql'), 'utf8');
  const sql = renderRemoteModelSql(raw, {
    project: opts.config.project,
    location: opts.config.location,
    dataset: opts.config.dataset,
    connectionId,
    embeddingModel: opts.embeddingModel,
  });
  try {
    await runQueryLogged(opts.bq, opts.config, sql, undefined, opts.logger);
  } catch (err) {
    throw new Error(formatCreateModelFailure(err, opts.embeddingModel));
  }
  return true;
}

async function countActiveSeeds(
  bq: BigQuery,
  config: BqConfig,
  seedVersion: string,
): Promise<number> {
  const table = quotedTable(config, 'pr_seed_phrases');
  const rows = await runQuery(
    bq,
    config,
    `SELECT COUNT(*) AS n FROM ${table}
WHERE seed_version = @seed_version AND is_active = TRUE`,
    { seed_version: seedVersion },
  );
  const row = rows[0];
  if (row === undefined) {
    return 0;
  }
  return asInt(row['n'], 'n_seeds');
}

async function selectFunnelCounts(
  bq: BigQuery,
  config: BqConfig,
  pipelineRunId: string,
  embeddingModel: string,
): Promise<{
  n_stage1: number;
  n_embedded_ok: number;
  n_embedded_err: number;
  n_suspicious: number;
}> {
  const stage1 = quotedTable(config, 'stage1_filtered');
  const embeddings = quotedTable(config, 'review_embeddings');
  const stage2 = quotedTable(config, 'stage2_suspicious_for_gemini');
  const rows = await runQuery(
    bq,
    config,
    `SELECT
  stage.n_stage1,
  emb.n_embedded_ok,
  emb.n_embedded_err,
  stg2.n_suspicious
FROM (
  SELECT COUNT(*) AS n_stage1
  FROM ${stage1}
  WHERE pipeline_run_id = @pipeline_run_id
) AS stage
CROSS JOIN (
  SELECT
    COUNTIF(e.status = 'ok') AS n_embedded_ok,
    COUNTIF(e.status = 'error') AS n_embedded_err
  FROM ${stage1} AS s
  LEFT JOIN ${embeddings} AS e
    ON e.review_id = s.review_id
   AND e.embedding_model = @embedding_model
  WHERE s.pipeline_run_id = @pipeline_run_id
) AS emb
CROSS JOIN (
  SELECT COUNT(*) AS n_suspicious
  FROM ${stage2}
  WHERE pipeline_run_id = @pipeline_run_id
) AS stg2`,
    { pipeline_run_id: pipelineRunId, embedding_model: embeddingModel },
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error('layer2 funnel count query returned no rows');
  }
  return {
    n_stage1: asInt(row['n_stage1'], 'n_stage1'),
    n_embedded_ok: asInt(row['n_embedded_ok'], 'n_embedded_ok'),
    n_embedded_err: asInt(row['n_embedded_err'], 'n_embedded_err'),
    n_suspicious: asInt(row['n_suspicious'], 'n_suspicious'),
  };
}

async function selectEmbeddingDim(
  bq: BigQuery,
  config: BqConfig,
  pipelineRunId: string,
  embeddingModel: string,
): Promise<number | null> {
  const stage1 = quotedTable(config, 'stage1_filtered');
  const embeddings = quotedTable(config, 'review_embeddings');
  const rows = await runQuery(
    bq,
    config,
    `SELECT ARRAY_LENGTH(e.embedding) AS dim
FROM ${stage1} AS s
JOIN ${embeddings} AS e
  ON e.review_id = s.review_id
 AND e.embedding_model = @embedding_model
WHERE s.pipeline_run_id = @pipeline_run_id
  AND e.status = 'ok'
GROUP BY dim
ORDER BY dim`,
    { pipeline_run_id: pipelineRunId, embedding_model: embeddingModel },
  );
  if (rows.length === 0) {
    return null;
  }
  const dims = rows.map((row) => asInt(row['dim'], 'dim'));
  const unique = [...new Set(dims)];
  if (unique.length !== 1 || unique[0] === undefined) {
    throw new Error(
      `layer2 expected a single embedding dim of ${String(EXPECTED_EMBEDDING_DIM)}, got ${unique.join(',')}`,
    );
  }
  const dim = unique[0];
  if (dim !== EXPECTED_EMBEDDING_DIM) {
    throw new Error(
      `layer2 expected ARRAY_LENGTH=768 on status='ok' embeddings, got ${String(dim)}`,
    );
  }
  return dim;
}

async function selectDistanceSample(
  bq: BigQuery,
  config: BqConfig,
  pipelineRunId: string,
): Promise<Record<string, unknown>[]> {
  const stage2 = quotedTable(config, 'stage2_suspicious_for_gemini');
  return runQuery(
    bq,
    config,
    `SELECT
  review_id,
  matched_seed_id,
  matched_seed_category,
  min_cosine_distance,
  min_cosine_similarity
FROM ${stage2}
WHERE pipeline_run_id = @pipeline_run_id
ORDER BY min_cosine_distance ASC, review_id ASC
LIMIT 10`,
    { pipeline_run_id: pipelineRunId },
  );
}

export async function runLayer2(opts: RunLayer2Options): Promise<Layer2CommandResult> {
  const loaded = loadEnv({
    command: 'layer2',
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
    throw new Error('GCP_PROJECT, GCP_LOCATION, and BQ_DATASET are required for layer2');
  }
  const gcp: GcpEnv = loaded.gcp;
  const config = bqConfigFromGcp(gcp);
  assertBqConfig(config);
  const logger: Logger = createLogger(loaded.hmac.LOG_LEVEL);
  const bq = opts.bigquery ?? getBigQuery(config);
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;
  const stdout = opts.stdout ?? process.stdout;
  const startedAt = opts.now ?? new Date();
  const seedVersion =
    opts.seedVersion !== undefined && opts.seedVersion.length > 0
      ? opts.seedVersion
      : loaded.config.seed_version;
  const embeddingModel = loaded.config.layer2.embedding_model;
  const threshold = loaded.config.layer2.cosine_distance_threshold;

  await assertLayer2TablesExist(bq, config);
  await requireExistingPipelineRun(bq, config, resolved.pipeline_run_id);

  const previousLatest = readLatestRun(latestPath);
  const updateBase = {
    bq,
    config,
    pipelineRunId: resolved.pipeline_run_id,
    seedVersion,
    embeddingModel,
    threshold,
  };

  let markedRunning = false;
  let terminal: 'succeeded' | 'failed' = 'failed';
  let layer2Error: unknown;
  let modelCreated = false;
  try {
    await updatePipelineRun({
      ...updateBase,
      status: 'running',
      heartbeatAt: startedAt,
    });
    markedRunning = true;

    modelCreated = await ensureRemoteModel({
      bq,
      config,
      repoRoot,
      gcp,
      embeddingModel,
      logger,
    });

    if (seedVersion === 'v0_hypothesis') {
      const seedsSql = readRepoSql(repoRoot, 'sql/seeds/pr_seed_phrases_v0.sql', config.dataset);
      await runQueryLogged(bq, config, seedsSql, undefined, logger);
    }

    const nSeeds = await countActiveSeeds(bq, config, seedVersion);
    if (nSeeds === 0) {
      throw new Error(`no active seed phrases for seed_version=${seedVersion}`);
    }

    const embedSeedsSql = readRepoSql(repoRoot, 'sql/layer2/embed_seeds.sql', config.dataset);
    await runQueryLogged(
      bq,
      config,
      embedSeedsSql,
      {
        seed_version: seedVersion,
        embedding_model: embeddingModel,
      },
      logger,
    );

    const embedReviewsSql = readRepoSql(repoRoot, 'sql/layer2/embed_reviews.sql', config.dataset);
    await runQueryLogged(
      bq,
      config,
      embedReviewsSql,
      {
        pipeline_run_id: resolved.pipeline_run_id,
        embedding_model: embeddingModel,
      },
      logger,
    );

    const distanceSql = readRepoSql(repoRoot, 'sql/layer2/distance_filter.sql', config.dataset);
    await runQueryLogged(
      bq,
      config,
      distanceSql,
      {
        pipeline_run_id: resolved.pipeline_run_id,
        seed_version: seedVersion,
        embedding_model: embeddingModel,
        threshold,
      },
      logger,
    );

    const funnel = await selectFunnelCounts(
      bq,
      config,
      resolved.pipeline_run_id,
      embeddingModel,
    );
    if (funnel.n_stage1 > 0 && funnel.n_embedded_ok === 0) {
      throw new Error(
        `layer2 embedded 0 ok rows for ${String(funnel.n_stage1)} stage1 reviews (n_embedded_err=${String(funnel.n_embedded_err)})`,
      );
    }
    const embeddingDim = await selectEmbeddingDim(
      bq,
      config,
      resolved.pipeline_run_id,
      embeddingModel,
    );
    const sample = await selectDistanceSample(bq, config, resolved.pipeline_run_id);

    await updatePipelineRun({
      ...updateBase,
      status: 'succeeded',
      heartbeatAt: new Date(),
      finishedAt: new Date(),
      rowsIn: funnel.n_stage1,
      rowsOut: funnel.n_suspicious,
      errorMessage: null,
    });
    terminal = 'succeeded';

    try {
      const latest: LatestRunFile = {
        pipeline_run_id: resolved.pipeline_run_id,
        phase: 'layer2',
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
      event: 'funnel_layer2',
      pipeline_run_id: resolved.pipeline_run_id,
      n_embedded_ok: funnel.n_embedded_ok,
      n_embedded_err: funnel.n_embedded_err,
      n_suspicious: funnel.n_suspicious,
      threshold,
      n_stage1: funnel.n_stage1,
      embedding_dim: embeddingDim,
      seed_version: seedVersion,
      embedding_model: embeddingModel,
      model_created: modelCreated,
    });
    if (sample.length > 0) {
      logger.info({
        event: 'layer2_distance_sample',
        pipeline_run_id: resolved.pipeline_run_id,
        rows: sample,
      });
    }

    return {
      exitCode: 0,
      pipeline_run_id: resolved.pipeline_run_id,
      fromLatest: resolved.fromLatest,
      seed_version: seedVersion,
      embedding_model: embeddingModel,
      threshold,
      n_stage1: funnel.n_stage1,
      n_embedded_ok: funnel.n_embedded_ok,
      n_embedded_err: funnel.n_embedded_err,
      n_suspicious: funnel.n_suspicious,
      embedding_dim: embeddingDim,
      model_created: modelCreated,
    };
  } catch (err) {
    layer2Error = err;
    throw err;
  } finally {
    if (markedRunning && terminal === 'failed') {
      try {
        await updatePipelineRun({
          ...updateBase,
          status: 'failed',
          heartbeatAt: new Date(),
          finishedAt: new Date(),
          errorMessage: errorMessage(layer2Error ?? 'layer2 failed'),
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

export async function layer2Action(opts: Layer2CliOptions): Promise<void> {
  try {
    const result = await runLayer2(opts);
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
