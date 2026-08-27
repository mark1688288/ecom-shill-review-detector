// SPDX-License-Identifier: GPL-3.0-only
import {
  quotedInformationSchemaTables,
  quotedTable,
  type BqConfig,
} from '../../shared/bq.js';

const TABLE_ID_CHARS = /[^A-Za-z0-9_]/g;
const TABLE_ID_OK = /^[A-Za-z0-9_]+$/;

export function sanitizeBqTableId(id: string): string {
  const sanitized = id.replace(TABLE_ID_CHARS, '_');
  if (sanitized.length === 0 || !TABLE_ID_OK.test(sanitized)) {
    throw new Error(`cannot derive a BigQuery table id from ${id}`);
  }
  return sanitized;
}

export function stagingTableId(crawlBatchId: string): string {
  return `raw_reviews_staging_${sanitizeBqTableId(crawlBatchId)}`;
}

export function dedupTableId(crawlBatchId: string): string {
  return `${stagingTableId(crawlBatchId)}_dedup`;
}

export type LoadTableNames = {
  rawReviews: string;
  staging: string;
  dedup: string;
};

export function loadTableNames(config: BqConfig, crawlBatchId: string): LoadTableNames {
  return {
    rawReviews: quotedTable(config, 'raw_reviews'),
    staging: quotedTable(config, stagingTableId(crawlBatchId)),
    dedup: quotedTable(config, dedupTableId(crawlBatchId)),
  };
}

export function buildDropTableSql(config: BqConfig, table: string): string {
  return `DROP TABLE IF EXISTS ${quotedTable(config, table)}`;
}

export function buildCreateStagingSql(config: BqConfig, crawlBatchId: string): string {
  const names = loadTableNames(config, crawlBatchId);
  return `CREATE TABLE ${names.staging} LIKE ${names.rawReviews}`;
}

export function buildDedupSql(config: BqConfig, crawlBatchId: string): string {
  const names = loadTableNames(config, crawlBatchId);
  return `CREATE OR REPLACE TABLE ${names.dedup} AS
SELECT * EXCEPT(rn)
FROM (
  SELECT
    s.*,
    ROW_NUMBER() OVER (PARTITION BY review_id ORDER BY updated_at DESC) AS rn
  FROM ${names.staging} AS s
)
WHERE rn = 1`;
}

export function buildMergeSql(config: BqConfig, crawlBatchId: string): string {
  const names = loadTableNames(config, crawlBatchId);
  return `MERGE ${names.rawReviews} T
USING ${names.dedup} S
ON T.review_id = S.review_id
WHEN MATCHED AND T.content_hash != S.content_hash THEN UPDATE SET
  comment_text = S.comment_text,
  content_hash = S.content_hash,
  char_length = S.char_length,
  star_rating = S.star_rating,
  review_ts = S.review_ts,
  language_hint = S.language_hint,
  has_media = S.has_media,
  raw_payload_hash = S.raw_payload_hash,
  crawl_batch_id = S.crawl_batch_id,
  pipeline_run_id = S.pipeline_run_id,
  ingested_at = S.ingested_at,
  updated_at = S.updated_at
WHEN NOT MATCHED THEN INSERT ROW`;
}

export function buildMergePreviewSql(config: BqConfig, crawlBatchId: string): string {
  const names = loadTableNames(config, crawlBatchId);
  return `SELECT
  S.review_id AS review_id,
  CASE
    WHEN T.review_id IS NULL THEN 'insert'
    WHEN T.content_hash != S.content_hash THEN 'update'
    ELSE 'unchanged'
  END AS op
FROM ${names.dedup} S
LEFT JOIN ${names.rawReviews} T
ON T.review_id = S.review_id`;
}

export function buildEmbeddingsTableExistsSql(config: BqConfig): string {
  return `SELECT table_name
FROM ${quotedInformationSchemaTables(config)}
WHERE table_name = 'review_embeddings'
LIMIT 1`;
}

export function buildDeleteEmbeddingsSql(config: BqConfig): string {
  return `DELETE FROM ${quotedTable(config, 'review_embeddings')}
WHERE review_id IN UNNEST(@review_ids)`;
}

export type MergeStats = {
  n_inserted: number;
  n_updated: number;
  n_unchanged: number;
  n_already_present: number;
  updatedReviewIds: string[];
};

export function aggregateMergePreview(rows: readonly Record<string, unknown>[]): MergeStats {
  let n_inserted = 0;
  let n_updated = 0;
  let n_unchanged = 0;
  const updatedReviewIds: string[] = [];
  for (const row of rows) {
    const op = String(row['op'] ?? '');
    const reviewId = String(row['review_id'] ?? '');
    if (op === 'insert') {
      n_inserted += 1;
    } else if (op === 'update') {
      n_updated += 1;
      if (reviewId.length > 0) {
        updatedReviewIds.push(reviewId);
      }
    } else {
      n_unchanged += 1;
    }
  }
  return {
    n_inserted,
    n_updated,
    n_unchanged,
    n_already_present: n_unchanged,
    updatedReviewIds,
  };
}
