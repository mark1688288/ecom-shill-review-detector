// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCrawl } from '../../src/cli/commands/crawl.js';
import { runLoad } from '../../src/cli/commands/load.js';
import { sanitizeBqTableId, stagingTableId } from '../../src/crawler/persist/bq-load.js';
import type { RawReviewNdjson } from '../../src/crawler/persist/ndjson.js';
import {
  bqConfigFromGcp,
  getBigQuery,
  quotedInformationSchemaTables,
  quotedTable,
  runQuery,
  type BqConfig,
} from '../../src/shared/bq.js';
import { loadEnv } from '../../src/shared/env.js';

const MIX = path.join(process.cwd(), 'fixtures/reviews/cantonese-mix.jsonl');
const EDIT = path.join(process.cwd(), 'fixtures/reviews/same-native-id-edit.jsonl');
const SALT = process.env['REVIEWER_ID_SALT'] ?? '0123456789abcdef0123456789abcdef';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-load-direct-'));
  tmpDirs.push(dir);
  return dir;
}

function testEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    REVIEWER_ID_SALT: SALT,
    APP_ENV: 'test',
    LOG_LEVEL: 'silent',
  };
  const project = process.env['GCP_PROJECT'];
  const location = process.env['GCP_LOCATION'] ?? 'asia-east1';
  const dataset = process.env['BQ_DATASET'] ?? 'ecom_shill';
  if (project !== undefined) {
    env['GCP_PROJECT'] = project;
  }
  env['GCP_LOCATION'] = location;
  env['BQ_DATASET'] = dataset;
  const bucket = process.env['GCS_STAGING_BUCKET'];
  if (bucket !== undefined) {
    env['GCS_STAGING_BUCKET'] = bucket;
  }
  return env;
}

async function applyDdl(config: BqConfig): Promise<void> {
  const bq = getBigQuery(config);
  const ddlDir = path.join(process.cwd(), 'sql/ddl');
  for (const name of ['00_dataset.sql', '01_pipeline_runs.sql', '02_raw_reviews.sql']) {
    let sql = readFileSync(path.join(ddlDir, name), 'utf8');
    sql = sql.replaceAll('ecom_shill', config.dataset);
    sql = sql.replaceAll('asia-east1', config.location);
    await runQuery(bq, config, sql);
  }
}

async function countRaw(config: BqConfig): Promise<number> {
  const bq = getBigQuery(config);
  const rows = await runQuery(
    bq,
    config,
    `SELECT COUNT(*) AS n FROM ${quotedTable(config, 'raw_reviews')}`,
  );
  return Number(rows[0]?.['n'] ?? 0);
}

async function fetchNative(
  config: BqConfig,
  nativeReviewId: string,
): Promise<Record<string, unknown>[]> {
  const bq = getBigQuery(config);
  return runQuery(
    bq,
    config,
    `SELECT review_id, comment_text, content_hash, native_review_id
FROM ${quotedTable(config, 'raw_reviews')}
WHERE native_review_id = @native_review_id AND marketplace = 'fixture'`,
    { native_review_id: nativeReviewId },
  );
}

async function fetchByReviewId(
  config: BqConfig,
  reviewId: string,
): Promise<Record<string, unknown>[]> {
  const bq = getBigQuery(config);
  return runQuery(
    bq,
    config,
    `SELECT review_id, comment_text FROM ${quotedTable(config, 'raw_reviews')} WHERE review_id = @review_id`,
    { review_id: reviewId },
  );
}

async function leftoverStaging(config: BqConfig, crawlBatchId: string): Promise<string[]> {
  const bq = getBigQuery(config);
  const staging = stagingTableId(crawlBatchId);
  const rows = await runQuery(
    bq,
    config,
    `SELECT table_name
FROM ${quotedInformationSchemaTables(config)}
WHERE table_name IN UNNEST(@names)`,
    { names: [staging, `${staging}_dedup`, 'raw_reviews_staging'] },
  );
  return rows.map((row) => String(row['table_name'] ?? ''));
}

function requireRunId(id: string | undefined): string {
  if (id === undefined) {
    throw new Error('expected pipeline_run_id from crawl');
  }
  return id;
}

async function crawlTo(dir: string, input: string) {
  const outDir = path.join(dir, 'batch');
  const latestPath = path.join(dir, 'data', 'runs', 'latest');
  const result = await runCrawl({
    adapter: 'fixture',
    input,
    outDir,
    cwd: dir,
    latestPath,
    env: testEnv(),
    now: new Date('2026-03-01T00:00:00.000Z'),
    stdout: { write: () => undefined },
  });
  return {
    ndjson: path.join(outDir, 'reviews.ndjson'),
    latestPath,
    result,
  };
}

describe.skipIf(!process.env['GCP_PROJECT'])('load --load-mode=direct', () => {
  let config: BqConfig;

  beforeAll(async () => {
    const loaded = loadEnv({ command: 'load', env: testEnv() });
    if (loaded.gcp === undefined) {
      throw new Error('GCP env required for live load tests');
    }
    config = bqConfigFromGcp(loaded.gcp);
    await applyDdl(config);
  }, 120_000);

  it(
    'uses per-batch staging names and drops them after MERGE',
    async () => {
      const dir = await tmp();
      const crawled = await crawlTo(dir, MIX);
      const result = await runLoad({
        ndjson: crawled.ndjson,
        loadMode: 'direct',
        cwd: dir,
        latestPath: crawled.latestPath,
        env: testEnv(),
        stdout: { write: () => undefined },
      });
      expect(result.exitCode).toBe(0);
      expect(result.crawl_batch_id).toBeDefined();
      const batchId = result.crawl_batch_id ?? '';
      expect(result.stagingTable).toBe(stagingTableId(batchId));
      expect(result.stagingTable).toContain(sanitizeBqTableId(batchId));
      expect(result.stagingTable).not.toBe('raw_reviews_staging');
      expect(await leftoverStaging(config, batchId)).toEqual([]);
    },
    180_000,
  );

  it(
    'is idempotent: loading the same NDJSON twice leaves COUNT(*) unchanged',
    async () => {
      const dir = await tmp();
      const crawled = await crawlTo(dir, MIX);
      await runLoad({
        ndjson: crawled.ndjson,
        loadMode: 'direct',
        pipelineRunId: requireRunId(crawled.result.pipeline_run_id),
        cwd: dir,
        latestPath: crawled.latestPath,
        env: testEnv(),
        stdout: { write: () => undefined },
      });
      const afterFirst = await countRaw(config);
      const second = await runLoad({
        ndjson: crawled.ndjson,
        loadMode: 'direct',
        pipelineRunId: requireRunId(crawled.result.pipeline_run_id),
        cwd: dir,
        latestPath: crawled.latestPath,
        env: testEnv(),
        stdout: { write: () => undefined },
      });
      expect(second.n_inserted).toBe(0);
      expect(await countRaw(config)).toBe(afterFirst);
    },
    180_000,
  );

  it(
    'second load of same-native-id-edit keeps review_id and updates comment_text/content_hash',
    async () => {
      const origDir = await tmp();
      const editDir = await tmp();
      const orig = await crawlTo(origDir, MIX);
      const edited = await crawlTo(editDir, EDIT);
      await runLoad({
        ndjson: orig.ndjson,
        loadMode: 'direct',
        pipelineRunId: requireRunId(orig.result.pipeline_run_id),
        cwd: origDir,
        latestPath: orig.latestPath,
        env: testEnv(),
        stdout: { write: () => undefined },
      });
      const before = (await fetchNative(config, 'n001'))[0];
      expect(before).toBeDefined();
      await runLoad({
        ndjson: edited.ndjson,
        loadMode: 'direct',
        pipelineRunId: requireRunId(edited.result.pipeline_run_id),
        cwd: editDir,
        latestPath: edited.latestPath,
        env: testEnv(),
        stdout: { write: () => undefined },
      });
      const afterRows = await fetchNative(config, 'n001');
      expect(afterRows).toHaveLength(1);
      const after = afterRows[0];
      expect(after?.['review_id']).toBe(before?.['review_id']);
      expect(after?.['comment_text']).not.toBe(before?.['comment_text']);
      expect(String(after?.['comment_text'])).toContain('防曬');
      expect(after?.['content_hash']).not.toBe(before?.['content_hash']);
    },
    180_000,
  );

  it(
    'NDJSON with two rows of the same review_id MERGEs to one last-write row',
    async () => {
      const dir = await tmp();
      const crawled = await crawlTo(dir, MIX);
      const rows = (await readFile(crawled.ndjson, 'utf8'))
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as RawReviewNdjson);
      const base = rows[0];
      expect(base).toBeDefined();
      if (base === undefined) {
        throw new Error('expected crawled NDJSON');
      }
      const dupFile = path.join(dir, 'dup.ndjson');
      const first: RawReviewNdjson = {
        ...base,
        comment_text: '第一則重複鍵，應該被覆蓋。',
        updated_at: '2026-03-01T00:00:00.000Z',
      };
      const second: RawReviewNdjson = {
        ...base,
        comment_text: '第二則 last write wins 應該留呢句。',
        updated_at: '2026-03-01T00:02:00.000Z',
      };
      await writeFile(dupFile, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, 'utf8');
      await runLoad({
        ndjson: dupFile,
        loadMode: 'direct',
        pipelineRunId: requireRunId(crawled.result.pipeline_run_id),
        cwd: dir,
        latestPath: crawled.latestPath,
        env: testEnv(),
        stdout: { write: () => undefined },
      });
      const found = await fetchByReviewId(config, base.review_id);
      expect(found).toHaveLength(1);
      expect(String(found[0]?.['comment_text'])).toContain('last write wins');
    },
    180_000,
  );
});
