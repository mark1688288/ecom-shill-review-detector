// SPDX-License-Identifier: GPL-3.0-only
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCrawl } from '../../src/cli/commands/crawl.js';
import {
  MarketplaceNotConfiguredError,
  TosRequiredError,
} from '../../src/crawler/adapter.js';
import {
  FORBIDDEN_NDJSON_KEYS,
  RAW_REVIEW_NDJSON_KEYS,
  type RawReviewNdjson,
} from '../../src/crawler/persist/ndjson.js';

const SALT = '0123456789abcdef0123456789abcdef';
const MIX = path.join(process.cwd(), 'fixtures/reviews/cantonese-mix.jsonl');
const EDIT = path.join(process.cwd(), 'fixtures/reviews/same-native-id-edit.jsonl');

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-crawl-'));
  tmpDirs.push(dir);
  return dir;
}

function testEnv(): NodeJS.ProcessEnv {
  return { REVIEWER_ID_SALT: SALT, APP_ENV: 'test', LOG_LEVEL: 'silent' };
}

function parseNdjson(text: string): RawReviewNdjson[] {
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RawReviewNdjson);
}

async function crawlTo(dir: string, input: string, extra: { dryRun?: boolean; strict?: boolean } = {}) {
  const outDir = path.join(dir, 'batch');
  const latestPath = path.join(dir, 'data', 'runs', 'latest');
  const chunks: string[] = [];
  const result = await runCrawl({
    adapter: 'fixture',
    input,
    outDir,
    dryRun: extra.dryRun === true,
    strict: extra.strict === true,
    cwd: dir,
    latestPath,
    env: testEnv(),
    now: new Date('2026-03-01T00:00:00.000Z'),
    stdout: { write: (c: string) => chunks.push(c) },
  });
  return { result, outDir, latestPath, stdout: chunks.join('') };
}

describe('fixture inventory', () => {
  it('has at least 30 rows across the six categories plus overlap and edit', async () => {
    const dir = path.join(process.cwd(), 'fixtures/reviews');
    const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
    expect(files.sort()).toEqual(
      [
        'cantonese-mix.jsonl',
        'genuine-long.jsonl',
        'logistics-only.jsonl',
        'non-five-star.jsonl',
        'overlap-logistics.jsonl',
        'same-native-id-edit.jsonl',
        'shill-like-v0.jsonl',
        'short-five-star.jsonl',
      ].sort(),
    );
    let total = 0;
    for (const name of files) {
      const text = await readFile(path.join(dir, name), 'utf8');
      total += text.split('\n').filter((line) => line.trim().length > 0).length;
    }
    expect(total).toBeGreaterThanOrEqual(30);
  });
});

describe('crawl replay', () => {
  it('produces the same review_id set when the same fixture is crawled twice', async () => {
    const a = await tmp();
    const b = await tmp();
    const first = await crawlTo(a, MIX);
    const second = await crawlTo(b, MIX);
    expect(first.result.exitCode).toBe(0);
    expect(second.result.exitCode).toBe(0);
    const idsA = parseNdjson(await readFile(path.join(first.outDir, 'reviews.ndjson'), 'utf8')).map(
      (row) => row.review_id,
    );
    const idsB = parseNdjson(await readFile(path.join(second.outDir, 'reviews.ndjson'), 'utf8')).map(
      (row) => row.review_id,
    );
    expect(idsA.sort()).toEqual(idsB.sort());
    expect(idsA.length).toBeGreaterThan(0);
  });

  it('writes NDJSON without reviewer_id_raw, cookie, or Authorization keys', async () => {
    const dir = await tmp();
    const { outDir } = await crawlTo(dir, MIX);
    const rows = parseNdjson(await readFile(path.join(outDir, 'reviews.ndjson'), 'utf8'));
    const allowed = new Set<string>(RAW_REVIEW_NDJSON_KEYS);
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        expect(allowed.has(key)).toBe(true);
      }
      for (const forbidden of FORBIDDEN_NDJSON_KEYS) {
        expect(row).not.toHaveProperty(forbidden);
      }
      expect(JSON.stringify(row)).not.toContain('reviewer_id_raw');
      expect(JSON.stringify(row)).not.toContain('user-aaa');
    }
  });

  it('does not write data/ or latest on --dry-run', async () => {
    const dir = await tmp();
    const { result, outDir, latestPath, stdout } = await crawlTo(dir, MIX, { dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.n_written).toBe(0);
    expect(existsSync(outDir)).toBe(false);
    expect(existsSync(latestPath)).toBe(false);
    expect(existsSync(path.join(dir, 'data'))).toBe(false);
    expect(stdout).toMatch(/n_read=/);
    expect(stdout).toMatch(/sample_1=/);
    expect(stdout).not.toMatch(/pipeline_run_id=/);
  });

  it('writes reviews.ndjson, manifest.json, and data/runs/latest; does not mention BigQuery', async () => {
    const dir = await tmp();
    const { result, outDir, latestPath, stdout } = await crawlTo(dir, MIX);
    expect(result.exitCode).toBe(0);
    expect(existsSync(path.join(outDir, 'reviews.ndjson'))).toBe(true);
    expect(existsSync(path.join(outDir, 'manifest.json'))).toBe(true);
    const latest = JSON.parse(await readFile(latestPath, 'utf8')) as {
      pipeline_run_id: string;
      crawl_batch_id: string;
      phase: string;
    };
    expect(latest.phase).toBe('crawl');
    expect(latest.pipeline_run_id).toBe(result.pipeline_run_id);
    expect(stdout).toContain(`pipeline_run_id=${latest.pipeline_run_id}`);
    const manifest = JSON.parse(await readFile(path.join(outDir, 'manifest.json'), 'utf8')) as {
      n_written: number;
    };
    expect(manifest.n_written).toBe(result.n_written);
  });

  it('keeps review_id and changes content_hash for the same-native-id edit file', async () => {
    const origDir = await tmp();
    const editDir = await tmp();
    const orig = await crawlTo(origDir, MIX);
    const edited = await crawlTo(editDir, EDIT);
    const origRows = parseNdjson(await readFile(path.join(orig.outDir, 'reviews.ndjson'), 'utf8'));
    const editRows = parseNdjson(await readFile(path.join(edited.outDir, 'reviews.ndjson'), 'utf8'));
    const original = origRows.find((row) => row.native_review_id === 'n001');
    const rewrite = editRows.find((row) => row.native_review_id === 'n001');
    expect(original).toBeDefined();
    expect(rewrite).toBeDefined();
    expect(rewrite?.review_id).toBe(original?.review_id);
    expect(rewrite?.content_hash).not.toBe(original?.content_hash);
    expect(rewrite?.comment_text).toContain('防曬');
  });

  it('last-write-wins when a single JSONL repeats a native id', async () => {
    const dir = await tmp();
    const input = path.join(dir, 'dup.jsonl');
    const line1 =
      '{"marketplace":"fixture","native_review_id":"dup1","store_id":"store_a","product_id":"prod_shampoo","reviewer_id_raw":"user-dup","star_rating":5,"comment_text":"第一則正文，要夠長先至有內容。","review_ts":"2026-01-15T08:30:00+08:00","source_url":null,"has_media":false}';
    const line2 =
      '{"marketplace":"fixture","native_review_id":"dup1","store_id":"store_a","product_id":"prod_shampoo","reviewer_id_raw":"user-dup","star_rating":5,"comment_text":"第二則正文，last write wins 應該留呢句。","review_ts":"2026-01-15T08:30:00+08:00","source_url":null,"has_media":false}';
    await writeFile(input, `${line1}\n${line2}\n`, 'utf8');
    const { result, outDir } = await crawlTo(dir, input);
    expect(result.n_written).toBe(1);
    expect(result.n_deduped).toBe(1);
    const rows = parseNdjson(await readFile(path.join(outDir, 'reviews.ndjson'), 'utf8'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.comment_text).toContain('last write wins');
  });

  it('exits 1 in --strict when a row fails Zod', async () => {
    const dir = await tmp();
    const input = path.join(dir, 'bad.jsonl');
    await writeFile(
      input,
      '{"marketplace":"fixture","native_review_id":"x","store_id":"s","product_id":"p","reviewer_id_raw":"u","star_rating":9,"comment_text":"好用","review_ts":"2026-01-15T08:30:00+08:00","source_url":null,"has_media":false}\n',
      'utf8',
    );
    const { result } = await crawlTo(dir, input, { dryRun: true, strict: true });
    expect(result.exitCode).toBe(1);
    expect(result.stats?.n_rejected).toBe(1);
  });
});

describe('json_api crawl', () => {
  it('errors without --i-accept-tos', async () => {
    await expect(
      runCrawl({
        adapter: 'json_api',
        marketplace: 'example',
        dryRun: true,
        env: testEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toBeInstanceOf(TosRequiredError);
  });

  it('errors when the marketplace yaml is missing', async () => {
    const dir = await tmp();
    await expect(
      runCrawl({
        adapter: 'json_api',
        marketplace: 'nope',
        iAcceptTos: true,
        dryRun: true,
        jsonApiConfigDir: dir,
        env: testEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toBeInstanceOf(MarketplaceNotConfiguredError);
  });

  it('emits zero reviews with example.yaml and never calls fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const dir = await tmp();
    const result = await runCrawl({
      adapter: 'json_api',
      marketplace: 'example',
      iAcceptTos: true,
      dryRun: true,
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: testEnv(),
      stdout: { write: () => undefined },
    });
    expect(result.exitCode).toBe(0);
    expect(result.n_written).toBe(0);
    expect(result.samples).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, 'data'))).toBe(false);
    fetchSpy.mockRestore();
  });
});
