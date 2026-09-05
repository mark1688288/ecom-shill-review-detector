// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HktvmallUrlParseError } from '../../src/crawler/harvest/errors.js';
import {
  assertHktvmallPublicProductUrl,
  isAllowedHktvmallHost,
  parseHarvestUrls,
} from '../../src/crawler/harvest/url-list.js';

const VALID =
  'https://www.hktvmall.com/hktv/zh/main/Store/s/S2090001/cat/p/S2090001_S_4000412';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('isAllowedHktvmallHost', () => {
  it('allows exact www and apex hosts only', () => {
    expect(isAllowedHktvmallHost('www.hktvmall.com')).toBe(true);
    expect(isAllowedHktvmallHost('HKTVmall.com')).toBe(true);
    expect(isAllowedHktvmallHost('evil.hktvmall.com')).toBe(false);
    expect(isAllowedHktvmallHost('www.hktvmall.com.evil.example')).toBe(false);
    expect(isAllowedHktvmallHost('example.invalid')).toBe(false);
  });
});

describe('assertHktvmallPublicProductUrl', () => {
  it('reads store_id and product_id and strips query from source_url', () => {
    const parsed = assertHktvmallPublicProductUrl(`${VALID}?utm_source=x`);
    expect(parsed.store_id).toBe('S2090001');
    expect(parsed.product_id).toBe('S2090001_S_4000412');
    expect(parsed.host).toBe('www.hktvmall.com');
    expect(parsed.source_url).toBe(
      'https://www.hktvmall.com/hktv/zh/main/Store/s/S2090001/cat/p/S2090001_S_4000412',
    );
  });

  it('accepts apex hktvmall.com', () => {
    const parsed = assertHktvmallPublicProductUrl(
      'https://hktvmall.com/hktv/zh/main/Store/s/S1/cat/p/S1_S_2',
    );
    expect(parsed.host).toBe('hktvmall.com');
    expect(parsed.store_id).toBe('S1');
    expect(parsed.product_id).toBe('S1_S_2');
  });

  it('rejects evil.hktvmall.com', () => {
    expect(() =>
      assertHktvmallPublicProductUrl(
        'https://evil.hktvmall.com/hktv/zh/main/Store/s/S1/cat/p/S1_S_2',
      ),
    ).toThrow(HktvmallUrlParseError);
  });

  it('rejects example.invalid', () => {
    expect(() =>
      assertHktvmallPublicProductUrl('https://example.invalid/s/S1/p/P1'),
    ).toThrow(HktvmallUrlParseError);
  });

  it('rejects /hktv/en/', () => {
    expect(() =>
      assertHktvmallPublicProductUrl(
        'https://www.hktvmall.com/hktv/en/s/S1/p/P1',
      ),
    ).toThrow(HktvmallUrlParseError);
  });

  it('rejects a relative URL', () => {
    expect(() => assertHktvmallPublicProductUrl('/hktv/zh/s/S1/p/P1')).toThrow(
      HktvmallUrlParseError,
    );
  });
});

describe('parseHarvestUrls', () => {
  it('skips blanks and # comments in --url-file and appends after --url', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-url-file-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'urls.txt');
    await writeFile(
      file,
      `# comment\n\n${VALID}\nhttps://hktvmall.com/hktv/zh/main/s/S2/cat/p/P2\n`,
      'utf8',
    );
    const parsed = parseHarvestUrls({
      urls: ['https://www.hktvmall.com/hktv/zh/main/s/S0/cat/p/P0'],
      urlFile: file,
      cwd: dir,
    });
    expect(parsed.map((row) => row.store_id)).toEqual(['S0', 'S2090001', 'S2']);
  });
});
