// SPDX-License-Identifier: GPL-3.0-only
import type { BigQuery, JobLoadMetadata, Table } from '@google-cloud/bigquery';
import { Storage } from '@google-cloud/storage';
import type { Logger } from 'pino';
import { getBigQuery, quotedTable, type BqConfig } from '../../shared/bq.js';
import { logJobBytes, runQueryLogged } from '../../shared/metrics.js';
import type { RawReviewNdjson } from './ndjson.js';
import {
  parseGcsUri,
  resolveStagingGcsUri,
  uploadNdjsonToGcs,
} from './gcs.js';
import {
  aggregateMergePreview,
  buildCreateStagingSql,
  buildDedupSql,
  buildDeleteEmbeddingsSql,
  buildDropTableSql,
  buildEmbeddingsTableExistsSql,
  buildMergePreviewSql,
  buildMergeSql,
  dedupTableId,
  stagingTableId,
  type MergeStats,
} from './merge-raw.js';

export { sanitizeBqTableId, stagingTableId, dedupTableId } from './merge-raw.js';

export function isBqNotFoundError(err: unknown): boolean {
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

export const INSERT_ALL_CHUNK_SIZE = 500;

export type LoadMode = 'gcs' | 'direct';

export type LoadMergeResult = MergeStats & {
  stagingTable: string;
  dedupTable: string;
  gcsUri?: string;
  bq_job_bytes?: number;
};

export type ExecuteLoadOptions = {
  config: BqConfig;
  rows: RawReviewNdjson[];
  ndjsonBody: string;
  crawlBatchId: string;
  mode: LoadMode;
  gcsUri?: string;
  stagingBucket?: string;
  bq?: BigQuery;
  storage?: Storage;
  logger?: Logger;
};

async function dropLoadTables(
  bq: BigQuery,
  config: BqConfig,
  crawlBatchId: string,
  logger?: Logger,
): Promise<void> {
  await runQueryLogged(bq, config, buildDropTableSql(config, stagingTableId(crawlBatchId)), undefined, logger);
  await runQueryLogged(bq, config, buildDropTableSql(config, dedupTableId(crawlBatchId)), undefined, logger);
}

async function waitUntilRowCount(
  bq: BigQuery,
  config: BqConfig,
  tableId: string,
  expected: number,
): Promise<void> {
  const quoted = quotedTable(config, tableId);
  const deadline = Date.now() + 60_000;
  let last = 0;
  while (Date.now() < deadline) {
    const rows = await runQueryLogged(
      bq,
      config,
      `SELECT COUNT(*) AS n FROM ${quoted}`,
      undefined,
      undefined,
    );
    last = Number(rows[0]?.['n'] ?? 0);
    if (last >= expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `staging table ${tableId} visible count ${String(last)} < ${String(expected)} after insertAll`,
  );
}

async function waitUntilTableVisible(table: Table, tableId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await table.get();
      return;
    } catch (err) {
      if (!isBqNotFoundError(err)) {
        throw err;
      }
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'not found');
  throw new Error(`staging table ${tableId} not visible after CREATE TABLE: ${detail}`);
}

async function insertAllWithNotFoundRetry(table: Table, chunk: object[]): Promise<void> {
  const deadline = Date.now() + 60_000;
  let delayMs = 250;
  for (;;) {
    try {
      await table.insert(chunk);
      return;
    } catch (err) {
      if (!isBqNotFoundError(err) || Date.now() >= deadline) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 4_000);
    }
  }
}

async function insertAllChunked(
  bq: BigQuery,
  config: BqConfig,
  tableId: string,
  rows: RawReviewNdjson[],
): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const table = bq.dataset(config.dataset).table(tableId);
  await waitUntilTableVisible(table, tableId);
  for (let i = 0; i < rows.length; i += INSERT_ALL_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_ALL_CHUNK_SIZE).map((row) => ({
      ...row,
      review_ts: new Date(row.review_ts),
      ingested_at: new Date(row.ingested_at),
      updated_at: new Date(row.updated_at),
    }));
    await insertAllWithNotFoundRetry(table, chunk);
  }
  // Streaming buffer is not immediately SELECT-visible.
  await waitUntilRowCount(bq, config, tableId, rows.length);
}

async function loadFromGcs(
  bq: BigQuery,
  config: BqConfig,
  tableId: string,
  gcsUri: string,
  storage: Storage | undefined,
  project: string,
): Promise<string | undefined> {
  const parsed = parseGcsUri(gcsUri);
  if (parsed.object === undefined) {
    throw new Error(`GCS URI must include an object path: ${gcsUri}`);
  }
  const client = storage ?? new Storage({ projectId: project });
  const file = client.bucket(parsed.bucket).file(parsed.object);
  const metadata: JobLoadMetadata = {
    sourceFormat: 'NEWLINE_DELIMITED_JSON',
    ignoreUnknownValues: false,
    maxBadRecords: 0,
    autodetect: false,
    writeDisposition: 'WRITE_EMPTY',
    location: config.location,
  };
  const [job] = await bq.dataset(config.dataset).table(tableId).load(file, metadata);
  return job.jobReference?.jobId ?? undefined;
}

async function invalidateEmbeddings(
  bq: BigQuery,
  config: BqConfig,
  reviewIds: string[],
  logger?: Logger,
): Promise<void> {
  if (reviewIds.length === 0) {
    return;
  }
  const exists = await runQueryLogged(
    bq,
    config,
    buildEmbeddingsTableExistsSql(config),
    undefined,
    logger,
  );
  if (exists.length === 0) {
    return;
  }
  await runQueryLogged(bq, config, buildDeleteEmbeddingsSql(config), { review_ids: reviewIds }, logger);
}

export async function executeLoadAndMerge(opts: ExecuteLoadOptions): Promise<LoadMergeResult> {
  const bq = opts.bq ?? getBigQuery(opts.config);
  const stagingTable = stagingTableId(opts.crawlBatchId);
  const dedupTable = dedupTableId(opts.crawlBatchId);
  let uploadedUri: string | undefined;
  let bq_job_bytes: number | undefined;

  try {
    await dropLoadTables(bq, opts.config, opts.crawlBatchId, opts.logger);
    await runQueryLogged(
      bq,
      opts.config,
      buildCreateStagingSql(opts.config, opts.crawlBatchId),
      undefined,
      opts.logger,
    );

    if (opts.mode === 'direct') {
      await insertAllChunked(bq, opts.config, stagingTable, opts.rows);
    } else {
      const destination = resolveStagingGcsUri({
        crawlBatchId: opts.crawlBatchId,
        project: opts.config.project,
        ...(opts.gcsUri === undefined ? {} : { gcsUri: opts.gcsUri }),
        ...(opts.stagingBucket === undefined ? {} : { stagingBucket: opts.stagingBucket }),
      });
      uploadedUri = await uploadNdjsonToGcs({
        contents: opts.ndjsonBody,
        gcsUri: destination,
        project: opts.config.project,
        ...(opts.storage === undefined ? {} : { storage: opts.storage }),
      });
      const jobId = await loadFromGcs(
        bq,
        opts.config,
        stagingTable,
        uploadedUri,
        opts.storage,
        opts.config.project,
      );
      if (jobId !== undefined) {
        const logged = await logJobBytes(bq, opts.config, jobId, opts.logger);
        if (logged?.total_bytes_processed !== null && logged?.total_bytes_processed !== undefined) {
          bq_job_bytes = logged.total_bytes_processed;
        }
      }
    }

    await runQueryLogged(
      bq,
      opts.config,
      buildDedupSql(opts.config, opts.crawlBatchId),
      undefined,
      opts.logger,
    );
    const preview = await runQueryLogged(
      bq,
      opts.config,
      buildMergePreviewSql(opts.config, opts.crawlBatchId),
      undefined,
      opts.logger,
    );
    const stats = aggregateMergePreview(preview);
    // Before MERGE: a later failed DELETE cannot be retried once hashes already match.
    await invalidateEmbeddings(bq, opts.config, stats.updatedReviewIds, opts.logger);
    await runQueryLogged(
      bq,
      opts.config,
      buildMergeSql(opts.config, opts.crawlBatchId),
      undefined,
      opts.logger,
    );

    const result: LoadMergeResult = {
      ...stats,
      stagingTable,
      dedupTable,
    };
    if (uploadedUri !== undefined) {
      result.gcsUri = uploadedUri;
    }
    if (bq_job_bytes !== undefined) {
      result.bq_job_bytes = bq_job_bytes;
    }
    return result;
  } finally {
    try {
      await dropLoadTables(bq, opts.config, opts.crawlBatchId, opts.logger);
    } catch (err) {
      opts.logger?.warn({
        event: 'staging_drop_failed',
        stagingTable,
        dedupTable,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}


