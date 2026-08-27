// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureAdapter } from '../../src/crawler/adapters/fixture.js';
import { JsonApiAdapter } from '../../src/crawler/adapters/json-api.js';
import {
  MarketplaceNotConfiguredError,
  TosRequiredError,
} from '../../src/crawler/adapter.js';
import { inferLanguageHint, normalizeFixtureReview } from '../../src/crawler/normalize.js';
import { lastWriteWins, toRawReviewNdjson } from '../../src/crawler/persist/ndjson.js';
import { parseFixtureReviewLine } from '../../src/crawler/types.js';
import { readFileSync } from 'node:fs';

const SALT = '0123456789abcdef0123456789abcdef';

function validRow(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    marketplace: 'fixture',
    native_review_id: 'n001',
    store_id: 'store_a',
    product_id: 'prod_shampoo',
    reviewer_id_raw: 'user-aaa',
    star_rating: 5,
    comment_text: '用咗兩個禮拜，暗瘡真係少咗',
    review_ts: '2026-01-15T08:30:00+08:00',
    source_url: null,
    has_media: false,
    ...overrides,
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
  }
  return out;
}

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('parseFixtureReviewLine', () => {
  it('accepts a design-contract row', () => {
    const result = parseFixtureReviewLine(validRow());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.native_review_id).toBe('n001');
      expect(result.data.reviewer_id_raw).toBe('user-aaa');
    }
  });

  it('rejects review_ts without a timezone', () => {
    expect(parseFixtureReviewLine(validRow({ review_ts: '2026-01-15T08:30:00' })).success).toBe(
      false,
    );
    expect(parseFixtureReviewLine(validRow({ review_ts: '2026-01-15' })).success).toBe(false);
  });

  it('rejects star_rating outside 1–5 integers', () => {
    expect(parseFixtureReviewLine(validRow({ star_rating: 0 })).success).toBe(false);
    expect(parseFixtureReviewLine(validRow({ star_rating: 6 })).success).toBe(false);
    expect(parseFixtureReviewLine(validRow({ star_rating: 5.5 })).success).toBe(false);
  });

  it('rejects invalid JSON', () => {
    const result = parseFixtureReviewLine('{not json');
    expect(result).toEqual({ success: false, reason: 'json' });
  });
});

describe('inferLanguageHint', () => {
  it('detects Yue particles', () => {
    expect(inferLanguageHint('用咗兩個禮拜')).toBe('yue');
  });

  it('marks Han+Latin without particles as mixed', () => {
    expect(inferLanguageHint('Hello 世界')).toBe('mixed');
  });

  it('marks Han-only as zh-Hant', () => {
    expect(inferLanguageHint('包裝完好')).toBe('zh-Hant');
  });

  it('marks Latin-only as en', () => {
    expect(inferLanguageHint('fast delivery well packed')).toBe('en');
  });

  it('marks digits-only as unknown', () => {
    expect(inferLanguageHint('12345')).toBe('unknown');
  });
});

describe('normalizeFixtureReview', () => {
  it('HMAC-hashes reviewer_id_raw and omits it from the normalized object', () => {
    const parsed = parseFixtureReviewLine(validRow());
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    const normalized = normalizeFixtureReview(parsed.data, SALT);
    expect(normalized.reviewer_id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(normalized).not.toHaveProperty('reviewer_id_raw');
    expect(JSON.stringify(normalized)).not.toContain('user-aaa');
  });

  it('honours an explicit language_hint', () => {
    const parsed = parseFixtureReviewLine(validRow({ language_hint: 'en', comment_text: '用咗' }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(normalizeFixtureReview(parsed.data, SALT).language_hint).toBe('en');
  });
});

describe('FixtureAdapter', () => {
  it('skips bad rows and counts rejections without throwing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'rows.jsonl');
    await writeFile(
      file,
      [
        validRow(),
        '{bad',
        validRow({ star_rating: 9, native_review_id: 'n002' }),
        validRow({ native_review_id: 'n003' }),
        '',
      ].join('\n'),
      'utf8',
    );
    const adapter = new FixtureAdapter(SALT);
    const rows = await collect(adapter.crawl({ inputPath: file }));
    expect(rows).toHaveLength(2);
    expect(adapter.stats.n_read).toBe(4);
    expect(adapter.stats.n_accepted).toBe(2);
    expect(adapter.stats.n_rejected).toBe(2);
    expect(adapter.stats.n_rejected_json).toBe(1);
    expect(adapter.stats.n_rejected_star).toBe(1);
  });

  it('requires --input', async () => {
    const adapter = new FixtureAdapter(SALT);
    await expect(collect(adapter.crawl({}))).rejects.toThrow(/--input/);
  });
});

describe('JsonApiAdapter', () => {
  it('does not contain HTTP clients', () => {
    const src = readFileSync(
      path.join(process.cwd(), 'src/crawler/adapters/json-api.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/\bfetch\s*\(|from ['"]node:https?['"]|undici|axios|got\(/);
  });

  it('throws TosRequiredError without --i-accept-tos', async () => {
    const adapter = new JsonApiAdapter();
    await expect(collect(adapter.crawl({ marketplaceId: 'example' }))).rejects.toBeInstanceOf(
      TosRequiredError,
    );
  });

  it('throws MarketplaceNotConfiguredError when yaml is missing', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-cfg-'));
    tmpDirs.push(dir);
    const adapter = new JsonApiAdapter(dir);
    await expect(
      collect(adapter.crawl({ iAcceptTos: true, marketplaceId: 'missing' })),
    ).rejects.toBeInstanceOf(MarketplaceNotConfiguredError);
  });

  it('yields zero reviews and does not call fetch when yaml exists', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const adapter = new JsonApiAdapter();
    const rows = await collect(
      adapter.crawl({ iAcceptTos: true, marketplaceId: 'example' }),
    );
    expect(rows).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('lastWriteWins', () => {
  it('keeps the last row for a duplicated review_id', () => {
    const parsed = parseFixtureReviewLine(validRow());
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    const review = normalizeFixtureReview(parsed.data, SALT);
    const ctx = {
      crawl_batch_id: '11111111-1111-1111-1111-111111111111',
      pipeline_run_id: '22222222-2222-2222-2222-222222222222',
      ingested_at: new Date('2026-01-15T00:00:00.000Z'),
    };
    const first = toRawReviewNdjson(review, ctx);
    const second = { ...first, comment_text: 'later write', content_hash: 'cc'.repeat(32) };
    const { rows, n_deduped } = lastWriteWins([first, second]);
    expect(n_deduped).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.comment_text).toBe('later write');
  });
});
