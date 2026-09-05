// SPDX-License-Identifier: GPL-3.0-only
import path from 'node:path';
import type { BigQuery } from '@google-cloud/bigquery';
import type { Logger } from 'pino';
import {
  ALLOWED_TEMPLATE_IDS,
  PROMPT_VERSION as PROMPT_VERSION_CONST,
} from '../../audit/prompt.js';
import {
  assertAuditTablesExist,
  createBqCheckpoint,
  createBqPipelineRuns,
  type AuditCheckpoint,
  type PipelineRunPort,
} from '../../audit/checkpoint.js';
import { createGeminiClient, type GeminiClient } from '../../audit/gemini-client.js';
import { runAuditWorker, type AuditWorkerResult } from '../../audit/worker.js';
import {
  assertBqConfig,
  bqConfigFromGcp,
  getBigQuery,
} from '../../shared/bq.js';
import { isProd, loadEnv, type GcpEnv } from '../../shared/env.js';
import { createLogger } from '../../shared/logger.js';
import {
  printPipelineRunId,
  resolvePipelineRunId,
  RunIdError,
} from '../../shared/run-id.js';

const HEARTBEAT_MS = 30_000;
const HEARTBEAT_STALE_MINUTES = 15;

export type AuditCliOptions = {
  pipelineRunId?: string;
  continueLatest?: boolean;
  concurrency?: string | number;
  limit?: string | number;
  skipExisting?: boolean;
  forceRescore?: boolean;
  resume?: boolean;
  iAmProd?: boolean;
};

export type RunAuditOptions = AuditCliOptions & {
  cwd?: string;
  latestPath?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  stdout?: { write(chunk: string): unknown };
  bigquery?: BigQuery;
  checkpoint?: AuditCheckpoint;
  pipelineRuns?: PipelineRunPort;
  gemini?: GeminiClient;
  logger?: Logger;
  heartbeatMs?: number;
  abortSignal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type AuditCommandResult = AuditWorkerResult & {
  exitCode: number;
  fromLatest: boolean;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseConcurrency(raw: string | number | undefined, fallback: number): number {
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 5 || n > 10) {
    throw new Error('concurrency must be an integer 5-10');
  }
  return n;
}

function parseOptionalLimit(raw: string | number | undefined): number | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('limit must be a positive integer');
  }
  return n;
}

function minutesSince(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / 60_000;
}

export async function runAudit(opts: RunAuditOptions): Promise<AuditCommandResult> {
  const loaded = loadEnv({
    command: 'audit',
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

  const prod = isProd(loaded.hmac, opts.iAmProd === true);
  const concurrency = parseConcurrency(opts.concurrency, loaded.config.audit.concurrency);
  const parsedLimit = parseOptionalLimit(opts.limit);
  const limit = parsedLimit ?? (prod ? undefined : loaded.config.audit.default_limit_non_prod);
  const skipExisting = opts.skipExisting !== false;
  const forceRescore = opts.forceRescore === true;
  const logger = opts.logger ?? createLogger(loaded.hmac.LOG_LEVEL);
  const stdout = opts.stdout ?? process.stdout;
  const startedAt = opts.now ?? new Date();

  let checkpoint = opts.checkpoint;
  let pipelineRuns = opts.pipelineRuns;
  let gemini = opts.gemini;
  if (checkpoint === undefined || pipelineRuns === undefined || gemini === undefined) {
    if (loaded.gcp === undefined) {
      throw new Error('GCP_PROJECT, GCP_LOCATION, and BQ_DATASET are required for audit');
    }
    const gcp: GcpEnv = loaded.gcp;
    const config = bqConfigFromGcp(gcp);
    assertBqConfig(config);
    const bq = opts.bigquery ?? getBigQuery(config);
    await assertAuditTablesExist(bq, config);
    checkpoint ??= createBqCheckpoint(bq, config);
    pipelineRuns ??= createBqPipelineRuns(bq, config);
    const apiKey = (opts.env ?? process.env)['GEMINI_API_KEY'];
    gemini ??= createGeminiClient({
      model: loaded.config.gemini.model,
      project: gcp.GCP_PROJECT,
      location: gcp.GEMINI_LOCATION ?? gcp.GCP_LOCATION,
      thinkingBudget: loaded.config.gemini.thinking_budget,
      thinkingLevel: loaded.config.gemini.thinking_level,
      temperature: loaded.config.gemini.temperature,
      maxOutputTokens: loaded.config.gemini.max_output_tokens,
      ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
    });
  }

  const existing = await pipelineRuns.get(resolved.pipeline_run_id);
  if (existing === null) {
    throw new RunIdError(
      `pipeline run not found: ${resolved.pipeline_run_id}; load/layer1 must create it first`,
      2,
    );
  }
  if (existing.status === 'running' && opts.resume !== true) {
    const heartbeat = existing.heartbeat_at;
    if (heartbeat !== null && minutesSince(heartbeat, startedAt) <= HEARTBEAT_STALE_MINUTES) {
      throw new Error(
        'audit already running (heartbeat < 15 min); pass --resume to continue',
      );
    }
  }

  await pipelineRuns.update({
    pipelineRunId: resolved.pipeline_run_id,
    status: 'running',
    heartbeatAt: startedAt,
  });

  const abort = new AbortController();
  const external = opts.abortSignal;
  const onExternalAbort = (): void => {
    abort.abort();
  };
  external?.addEventListener('abort', onExternalAbort);
  const onSignal = (): void => {
    abort.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const heartbeatTimer =
    heartbeatMs > 0
      ? setInterval(() => {
          void pipelineRuns.update({
            pipelineRunId: resolved.pipeline_run_id,
            status: 'running',
            heartbeatAt: new Date(),
          });
        }, heartbeatMs)
      : undefined;
  heartbeatTimer?.unref();

  let terminal: 'succeeded' | 'failed' | 'aborted' = 'failed';
  let workerResult: AuditWorkerResult | undefined;
  let runError: unknown;
  try {
    const workerOpts = {
      pipelineRunId: resolved.pipeline_run_id,
      checkpoint,
      gemini,
      logger,
      concurrency,
      maxReviewsPerRun: loaded.config.audit.max_reviews_per_run,
      skipExisting,
      forceRescore,
      allowedTemplateIds: ALLOWED_TEMPLATE_IDS,
      modelId: loaded.config.gemini.model,
      promptVersion: loaded.config.prompt_version || PROMPT_VERSION_CONST,
      abortSignal: abort.signal,
      ...(limit === undefined ? {} : { limit }),
      ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
      ...(opts.random === undefined ? {} : { random: opts.random }),
    };
    workerResult = await runAuditWorker(workerOpts);
    terminal = workerResult.status;
    printPipelineRunId(resolved.pipeline_run_id, stdout);
    logger.info({
      event: 'funnel_layer3',
      pipeline_run_id: resolved.pipeline_run_id,
      n_copied: workerResult.n_copied,
      n_pending: workerResult.n_pending,
      n_attempted: workerResult.n_attempted,
      n_gemini_http_calls: workerResult.n_gemini_http_calls,
      n_scored: workerResult.n_scored,
      n_errors: workerResult.n_errors,
      thinking_not_off: workerResult.thinking_not_off,
      gemini_cost_usd_est: workerResult.gemini_cost_usd_est,
      gemini_error_rate: workerResult.gemini_error_rate,
      signal_span_mismatch_total: workerResult.signal_span_mismatch_total,
    });
    return {
      ...workerResult,
      exitCode: workerResult.status === 'succeeded' ? 0 : 1,
      fromLatest: resolved.fromLatest,
    };
  } catch (err) {
    runError = err;
    terminal = abort.signal.aborted ? 'aborted' : 'failed';
    throw err;
  } finally {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
    }
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    external?.removeEventListener('abort', onExternalAbort);
    try {
      await pipelineRuns.update({
        pipelineRunId: resolved.pipeline_run_id,
        status: terminal,
        heartbeatAt: new Date(),
        finishedAt: new Date(),
        rowsIn: workerResult?.n_pending ?? null,
        rowsOut: workerResult?.n_scored ?? null,
        errorMessage: runError === undefined ? null : errorMessage(runError),
      });
    } catch (statusErr) {
      logger.warn({
        event: 'pipeline_run_status_update_failed',
        err: errorMessage(statusErr),
      });
    }
  }
}

export async function auditAction(opts: AuditCliOptions): Promise<void> {
  try {
    const result = await runAudit(opts);
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
