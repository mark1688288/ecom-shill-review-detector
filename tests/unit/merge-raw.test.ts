// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastWriteWins, type RawReviewNdjson } from '../../src/crawler/persist/ndjson.js';
import {
  buildCreateStagingSql,
  buildDedupSql,
  buildMergeSql,
  dedupTableId,
  loadTableNames,
  sanitizeBqTableId,
  stagingTableId,
} from '../../src/crawler/persist/merge-raw.js';
import type { BqConfig } from '../../src/shared/bq.js';
import { fullyQualifiedTable, quotedTable } from '../../src/shared/bq.js';

const CONFIG: BqConfig = {
  project: 'demo-project',
  location: 'asia-east1',
  dataset: 'ecom_shill',
};

const BATCH = '550e8400-e29b-41d4-a716-446655440000';

function sampleRow(overrides: Partial<RawReviewNdjson> = {}): RawReviewNdjson {
  return {
    review_id: 'aa'.repeat(32),
    marketplace: 'fixture',
    native_review_id: 'n001',
    store_id: 'store_a',
    product_id: 'prod_shampoo',
    reviewer_id_hash: 'bb'.repeat(32),
    star_rating: 5,
    comment_text: '用咗兩個禮拜，暗瘡真係少咗',
    content_hash: 'cc'.repeat(32),
    review_ts: '2026-01-15T00:30:00.000Z',
    ingested_at: '2026-03-01T00:00:00.000Z',
    crawl_batch_id: BATCH,
    pipeline_run_id: '22222222-2222-4222-8222-222222222222',
    source_url_hash: null,
    language_hint: 'yue',
    has_media: false,
    raw_payload_hash: 'dd'.repeat(32),
    char_length: 14,
    updated_at: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('sanitizeBqTableId', () => {
  it('turns UUID hyphens into underscores', () => {
    const sanitized = sanitizeBqTableId(BATCH);
    expect(sanitized).toBe('550e8400_e29b_41d4_a716_446655440000');
    expect(sanitized).toMatch(/^[A-Za-z0-9_]+$/);
    expect(sanitized).not.toContain('-');
  });

  it('rejects values that sanitize to empty', () => {
    expect(() => sanitizeBqTableId('')).toThrow(/table id/);
  });
});

describe('MERGE SQL builders', () => {
  it('does not contain DO NOTHING', () => {
    const sql = buildMergeSql(CONFIG, BATCH);
    expect(sql.toUpperCase()).not.toContain('DO NOTHING');
  });

  it('USING is the _dedup table, never the undeduped staging', () => {
    const names = loadTableNames(CONFIG, BATCH);
    const merge = buildMergeSql(CONFIG, BATCH);
    expect(merge).toContain('_dedup');
    expect(merge).toContain(`USING ${names.dedup} S`);
    expect(merge.includes(`USING ${names.staging} S`)).toBe(false);
    expect(stagingTableId(BATCH)).toBe(
      `raw_reviews_staging_${sanitizeBqTableId(BATCH)}`,
    );
    expect(dedupTableId(BATCH)).toBe(`${stagingTableId(BATCH)}_dedup`);
    expect(names.staging).toContain(sanitizeBqTableId(BATCH));
    expect(names.dedup).toContain(sanitizeBqTableId(BATCH));
    expect(stagingTableId(BATCH)).not.toBe('raw_reviews_staging');
  });

  it('matches on review_id and updates when content_hash differs', () => {
    const sql = buildMergeSql(CONFIG, BATCH);
    expect(sql).toContain('WHEN MATCHED AND');
    expect(sql).toContain('content_hash');
    expect(sql).toContain('WHEN NOT MATCHED THEN INSERT ROW');
    expect(sql).toContain('ON T.review_id = S.review_id');
  });

  it('SQL-dedup partitions by review_id before MERGE', () => {
    const sql = buildDedupSql(CONFIG, BATCH);
    expect(sql).toContain('PARTITION BY review_id');
    expect(sql).toContain('ORDER BY updated_at DESC');
    expect(sql).toContain(loadTableNames(CONFIG, BATCH).staging);
    expect(sql).toContain(loadTableNames(CONFIG, BATCH).dedup);
  });

  it('creates a per-batch staging table LIKE raw_reviews without TRUNCATE', () => {
    const sql = buildCreateStagingSql(CONFIG, BATCH);
    expect(sql).toContain(`CREATE TABLE ${loadTableNames(CONFIG, BATCH).staging} LIKE`);
    expect(sql).not.toMatch(/TRUNCATE/i);
    expect(sql).not.toContain('raw_reviews_staging`');
  });

  it('duplicate review_id is last-write-wins locally and still SQL-deduped by review_id', () => {
    const first = sampleRow({
      comment_text: '第一則',
      updated_at: '2026-03-01T00:00:00.000Z',
    });
    const second = sampleRow({
      comment_text: '第二則 last write',
      updated_at: '2026-03-01T00:01:00.000Z',
    });
    const { rows, n_deduped } = lastWriteWins([first, second]);
    expect(n_deduped).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.comment_text).toContain('last write');
    expect(buildDedupSql(CONFIG, BATCH)).toMatch(/PARTITION BY review_id/);
  });
});

describe('fullyQualifiedTable', () => {
  it('joins project.dataset.table', () => {
    expect(fullyQualifiedTable(CONFIG, 'raw_reviews')).toBe(
      'demo-project.ecom_shill.raw_reviews',
    );
    expect(quotedTable(CONFIG, 'raw_reviews')).toBe(
      '`demo-project.ecom_shill.raw_reviews`',
    );
  });
});

describe('DDL and bq-apply.sh', () => {
  const root = process.cwd();

  it('ships dataset, pipeline_runs, and raw_reviews DDL', () => {
    const dataset = readFileSync(path.join(root, 'sql/ddl/00_dataset.sql'), 'utf8');
    const runs = readFileSync(path.join(root, 'sql/ddl/01_pipeline_runs.sql'), 'utf8');
    const raw = readFileSync(path.join(root, 'sql/ddl/02_raw_reviews.sql'), 'utf8');
    expect(dataset).toContain('CREATE SCHEMA IF NOT EXISTS');
    expect(dataset).toContain('asia-east1');
    expect(runs).toContain('pipeline_run_id STRING NOT NULL');
    expect(runs).toContain('PARTITION BY DATE(started_at)');
    expect(raw).toContain('review_id STRING NOT NULL');
    expect(raw).toContain('PARTITION BY DATE(review_ts)');
    expect(raw).toContain('CLUSTER BY marketplace, store_id, product_id');
  });

  it('bq-apply.sh applies 00 then 01 then 02 with location and dataset substitution', () => {
    const script = readFileSync(path.join(root, 'scripts/bq-apply.sh'), 'utf8');
    expect(script).toContain('set -euo pipefail');
    expect(script).toContain('00_dataset.sql');
    expect(script).toContain('01_pipeline_runs.sql');
    expect(script).toContain('02_raw_reviews.sql');
    expect(script.indexOf('00_dataset.sql')).toBeLessThan(script.indexOf('01_pipeline_runs.sql'));
    expect(script.indexOf('01_pipeline_runs.sql')).toBeLessThan(script.indexOf('02_raw_reviews.sql'));
    expect(script).toContain('--location="${GCP_LOCATION}"');
    expect(script).toContain('BQ_DATASET');
  });
});
