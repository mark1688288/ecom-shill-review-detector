// SPDX-License-Identifier: GPL-3.0-only
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCrawl } from '../../src/cli/commands/crawl.js';
import { runLoad } from '../../src/cli/commands/load.js';
import { buildProgram } from '../../src/cli/main.js';
import {
  parseRawReviewNdjsonLine,
  type RawReviewNdjson,
} from '../../src/crawler/persist/ndjson.js';
import { loadEnv } from '../../src/shared/env.js';
import { resolvePipelineRunId, RunIdError, writeLatestRun } from '../../src/shared/run-id.js';

const SALT = '0123456789abcdef0123456789abcdef';
const BATCH = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-load-'));
  tmpDirs.push(dir);
  return dir;
}

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
    pipeline_run_id: RUN,
    source_url_hash: null,
    language_hint: 'yue',
    has_media: false,
    raw_payload_hash: 'dd'.repeat(32),
    char_length: 14,
    updated_at: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

async function writeNdjson(dir: string, rows: RawReviewNdjson[]): Promise<string> {
  const file = path.join(dir, 'reviews.ndjson');
  const body = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  await writeFile(file, body, 'utf8');
  return file;
}

function hmacEnv(): NodeJS.ProcessEnv {
  return { REVIEWER_ID_SALT: SALT, APP_ENV: 'test', LOG_LEVEL: 'silent' };
}

function gcpEnv(): NodeJS.ProcessEnv {
  return {
    ...hmacEnv(),
    GCP_PROJECT: 'demo-project',
    GCP_LOCATION: 'asia-east1',
    BQ_DATASET: 'ecom_shill',
  };
}

describe('load CLI flags', () => {
  it('lists --ndjson, --load-mode, and --gcs-uri', () => {
    const load = buildProgram().commands.find((cmd) => cmd.name() === 'load');
    expect(load).toBeDefined();
    const help = load?.helpInformation() ?? '';
    expect(help).toContain('--ndjson');
    expect(help).toContain('--load-mode');
    expect(help).toContain('--gcs-uri');
    expect(help).toContain('--dataset');
  });
});

describe('runLoad validation', () => {
  it('errors when --ndjson is missing', async () => {
    const dir = await tmp();
    await expect(
      runLoad({
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: hmacEnv(),
        stdout: { write: () => undefined },
        dryRun: true,
      }),
    ).rejects.toThrow(/--ndjson is required/);
  });

  it('rejects --pipeline-run-id together with --continue-latest', async () => {
    const dir = await tmp();
    const ndjson = await writeNdjson(dir, [sampleRow()]);
    await expect(
      runLoad({
        ndjson,
        pipelineRunId: RUN,
        continueLatest: true,
        dryRun: true,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: hmacEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toBeInstanceOf(RunIdError);
  });

  it('requires GCP_PROJECT for non-dry-run load', async () => {
    const dir = await tmp();
    const ndjson = await writeNdjson(dir, [sampleRow()]);
    expect(() =>
      loadEnv({
        command: 'load',
        env: hmacEnv(),
      }),
    ).toThrow(/GCP_PROJECT/);
    await expect(
      runLoad({
        ndjson,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: hmacEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toThrow(/GCP_PROJECT/);
  });

  it('rejects forbidden keys in NDJSON', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'bad.ndjson');
    const row = { ...sampleRow(), reviewer_id_raw: 'user-aaa' };
    await writeFile(file, `${JSON.stringify(row)}\n`, 'utf8');
    await expect(
      runLoad({
        ndjson: file,
        dryRun: true,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: hmacEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toThrow(/forbidden key reviewer_id_raw/);
    expect(() => parseRawReviewNdjsonLine(JSON.stringify({ ...sampleRow(), cookie: 'x' }), 1)).toThrow(
      /forbidden key cookie/,
    );
  });
});

describe('resolvePipelineRunId allowCreate for load', () => {
  it('continues latest when the file exists and no flags are passed', async () => {
    const dir = await tmp();
    const latestPath = path.join(dir, 'data', 'runs', 'latest');
    writeLatestRun(
      {
        pipeline_run_id: RUN,
        crawl_batch_id: BATCH,
        phase: 'crawl',
        started_at: '2026-03-01T00:00:00.000Z',
      },
      latestPath,
    );
    const resolved = resolvePipelineRunId({ allowCreate: true, latestPath });
    expect(resolved.pipeline_run_id).toBe(RUN);
    expect(resolved.created).toBe(false);
    expect(resolved.fromLatest).toBe(true);

    const ndjson = await writeNdjson(dir, [sampleRow()]);
    const result = await runLoad({
      ndjson,
      dryRun: true,
      cwd: dir,
      latestPath,
      env: hmacEnv(),
      stdout: { write: () => undefined },
    });
    expect(result.pipeline_run_id).toBe(RUN);
    expect(result.fromLatest).toBe(true);
    expect(result.createdRun).toBe(false);
  });

  it('creates a UUID when latest is missing and no flags are passed', async () => {
    const dir = await tmp();
    const latestPath = path.join(dir, 'data', 'runs', 'latest');
    const ndjson = await writeNdjson(dir, [sampleRow()]);
    const result = await runLoad({
      ndjson,
      dryRun: true,
      cwd: dir,
      latestPath,
      env: hmacEnv(),
      stdout: { write: () => undefined },
    });
    expect(result.createdRun).toBe(true);
    expect(result.fromLatest).toBe(false);
    expect(result.pipeline_run_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('honors --pipeline-run-id', async () => {
    const dir = await tmp();
    const ndjson = await writeNdjson(dir, [sampleRow()]);
    const result = await runLoad({
      ndjson,
      pipelineRunId: RUN,
      dryRun: true,
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: hmacEnv(),
      stdout: { write: () => undefined },
    });
    expect(result.pipeline_run_id).toBe(RUN);
    expect(result.createdRun).toBe(false);
    expect(result.fromLatest).toBe(false);
  });
});

describe('crawl does not write BigQuery', () => {
  it('crawl command source never imports BigQuery or pipeline_runs', async () => {
    const src = await readFile(path.join(process.cwd(), 'src/cli/commands/crawl.ts'), 'utf8');
    expect(src).not.toMatch(/bigquery/i);
    expect(src).not.toMatch(/@google-cloud/);
    expect(src).not.toContain('pipeline_runs');
  });

  it('runCrawl does not require GCP env', async () => {
    const dir = await tmp();
    const input = path.join(process.cwd(), 'fixtures/reviews/cantonese-mix.jsonl');
    const chunks: string[] = [];
    const result = await runCrawl({
      adapter: 'fixture',
      input,
      outDir: path.join(dir, 'batch'),
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: hmacEnv(),
      now: new Date('2026-03-01T00:00:00.000Z'),
      stdout: { write: (c: string) => chunks.push(c) },
    });
    expect(result.exitCode).toBe(0);
    expect(result.n_written).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('pipeline_run_id=');
  });
});

describe('load dry-run', () => {
  it('parses NDJSON and does not require GCP', async () => {
    const dir = await tmp();
    const ndjson = await writeNdjson(dir, [
      sampleRow(),
      sampleRow({
        comment_text: '改寫正文 last write',
        updated_at: '2026-03-01T00:02:00.000Z',
      }),
    ]);
    const result = await runLoad({
      ndjson,
      dryRun: true,
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: hmacEnv(),
      stdout: { write: () => undefined },
    });
    expect(result.exitCode).toBe(0);
    expect(result.n_read).toBe(2);
    expect(result.n_deduped).toBe(1);
    expect(result.crawl_batch_id).toBe(BATCH);
    expect(result.n_inserted).toBe(0);
    expect(existsSync(path.join(dir, 'data', 'runs', 'latest'))).toBe(false);
  });

  it('accepts gcp env on dry-run without constructing a live client', async () => {
    const dir = await tmp();
    const ndjson = await writeNdjson(dir, [sampleRow()]);
    const result = await runLoad({
      ndjson,
      dryRun: true,
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: gcpEnv(),
      stdout: { write: () => undefined },
    });
    expect(result.exitCode).toBe(0);
  });
});
