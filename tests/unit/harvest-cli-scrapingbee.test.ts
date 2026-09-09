// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHarvest, type HarvestConnect } from '../../src/cli/commands/harvest.js';
import {
  HarvestPaginationShortfallError,
  HarvestTosRequiredError,
  HarvestUsageError,
} from '../../src/crawler/harvest/errors.js';
import type { ScrapingBeeHttpGet } from '../../src/crawler/harvest/scrapingbee-client.js';
import { ScrapingBeeCredentialsError } from '../../src/shared/env.js';

const VALID_URL =
  'https://www.hktvmall.com/hktv/zh/main/Store/s/S2090001/cat/p/S2090001_S_4000412';
const URL_2 = 'https://www.hktvmall.com/hktv/zh/main/Store/s/S2090002/cat/p/S2090002_S_1';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-harvest-sb-'));
  tmpDirs.push(dir);
  return dir;
}

function collectStdout(): { stdout: { write(chunk: string): unknown }; text: () => string } {
  let buf = '';
  return {
    stdout: {
      write: (chunk: string) => {
        buf += chunk;
        return true;
      },
    },
    text: () => buf,
  };
}

function silentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as never;
}

function starMarkup(filled: number): string {
  const empty = '<div><span class="empty-star"></span></div>'.repeat(5);
  const stars = '<div><span class="star"></span></div>'.repeat(filled);
  return `<span class="product-review-rating"><div class="star-wrapper"><div class="star-container">${empty}</div><div class="star-container">${stars}</div></div></span>`;
}

function wrapperHtml(id: string, user: string, title: string): string {
  return `<div class="product-review-wrapper" data-reviewid="${id}"><div class="product-review-user"><table class="review-info-table"><tr><td class="user-info"><a data-user="${user}" href="/hktv/zh/review/profile?userId=${user}"><span class="review-username">Display Name</span></a></td></tr><tr><td class="td-rating-n-date">${starMarkup(5)}<span class="review-date">2024-06-01</span></td></tr></table></div><div class="product-review-rightPanel"><div class="product-review-content"><div class="review-title"><span>${title}</span></div></div></div></div>`;
}

function wrappersHtml(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i).padStart(2, '0');
    return wrapperHtml(`${prefix}-${n}`, `u-${prefix}-${n}`, `評語${prefix}${n}`);
  }).join('');
}

const THREE_PAGE_CHROME = `<span class="comment__count">25</span>
<a class="next-btn" href="javascript:void(0)">上一頁</a>
<select>
  <option value="0">1</option>
  <option value="1">2</option>
  <option value="2">3</option>
</select>
<div><span class="total">/共3頁</span></div>
<a class="next-btn" href="javascript:void(0)">下一頁</a>
<select><option>規格A</option><option>規格B</option></select>
<script type="application/ld+json">{"numberOfReviews":0}</script>`;

function threePageHtml(pageIndex: number): string {
  if (pageIndex === 0) {
    return `${THREE_PAGE_CHROME}${wrappersHtml('p0', 10)}`;
  }
  if (pageIndex === 1) {
    return wrappersHtml('p1', 10);
  }
  if (pageIndex === 2) {
    return wrappersHtml('p2', 5);
  }
  throw new Error(`unexpected pageIndex ${String(pageIndex)}`);
}

function envelope(html: string): string {
  return JSON.stringify({ body: html, type: 'html', cost: 25 });
}

function mockThreePageGet(): ScrapingBeeHttpGet {
  let calls = 0;
  return async () => {
    const pageIndex = calls;
    calls += 1;
    return {
      status: 200,
      headers: new Headers(),
      bodyText: envelope(threePageHtml(pageIndex)),
    };
  };
}

function sbKeyEnv(): NodeJS.ProcessEnv {
  return { LOG_LEVEL: 'silent', SCRAPINGBEE_API_KEY: 'sb-test-key-not-placeholder' };
}

describe('runHarvest --transport scrapingbee dry-run', () => {
  it('prints scrapingbee plan_* without key, ToS, connect, HTTP, or --out', async () => {
    const dir = await tmp();
    const out = path.join(dir, 'out.jsonl');
    const { stdout, text } = collectStdout();
    const connect = vi.fn<HarvestConnect>(async () => {
      throw new Error('connect must not run on dry-run');
    });
    const scrapingBeeGet = vi.fn<ScrapingBeeHttpGet>(async () => {
      throw new Error('scrapingBeeGet must not run on dry-run');
    });
    const result = await runHarvest({
      transport: 'scrapingbee',
      url: [VALID_URL],
      dryRun: true,
      out,
      cwd: dir,
      env: { LOG_LEVEL: 'silent' },
      stdout,
      connect,
      scrapingBeeGet,
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(connect).not.toHaveBeenCalled();
    expect(scrapingBeeGet).not.toHaveBeenCalled();
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
    const printed = text();
    expect(printed).toContain('plan_transport=scrapingbee');
    expect(printed).toContain('plan_pager_select=');
    expect(printed).toContain('plan_paginate=js_scenario evaluate select.value pageIndex');
    expect(printed).toContain('plan_http=no');
    expect(printed).not.toContain('plan_next=role:link|button name=下一頁');
    expect(printed).not.toContain('plan_paginate=waitForNewReviewIds');
  });

  it('rejects out-of-range --goto-timeout-ms before ToS, key, or HTTP', async () => {
    const connect = vi.fn<HarvestConnect>(async () => {
      throw new Error('connect must not run');
    });
    const scrapingBeeGet = vi.fn<ScrapingBeeHttpGet>(async () => {
      throw new Error('scrapingBeeGet must not run');
    });
    const dir = await tmp();
    for (const gotoTimeoutMs of ['999', '140001']) {
      await expect(
        runHarvest({
          transport: 'scrapingbee',
          url: [VALID_URL],
          dryRun: true,
          gotoTimeoutMs,
          cwd: dir,
          env: { LOG_LEVEL: 'silent' },
          stdout: { write: () => true },
          connect,
          scrapingBeeGet,
          logger: silentLogger(),
        }),
      ).rejects.toBeInstanceOf(HarvestUsageError);
    }
    expect(connect).not.toHaveBeenCalled();
    expect(scrapingBeeGet).not.toHaveBeenCalled();

    const { stdout, text } = collectStdout();
    const ok = await runHarvest({
      transport: 'brightdata',
      url: [VALID_URL],
      dryRun: true,
      gotoTimeoutMs: '999',
      cwd: dir,
      env: { LOG_LEVEL: 'silent' },
      stdout,
      connect,
      scrapingBeeGet,
      logger: silentLogger(),
    });
    expect(ok.exitCode).toBe(0);
    expect(text()).toContain('plan_transport=brightdata');
    expect(connect).not.toHaveBeenCalled();
    expect(scrapingBeeGet).not.toHaveBeenCalled();
  });
});

describe('runHarvest --transport scrapingbee live gates', () => {
  it('requires ToS before reading the key or calling scrapingBeeGet', async () => {
    const connect = vi.fn<HarvestConnect>(async () => {
      throw new Error('connect must not run without ToS');
    });
    const scrapingBeeGet = vi.fn<ScrapingBeeHttpGet>(async () => {
      throw new Error('scrapingBeeGet must not run without ToS');
    });
    await expect(
      runHarvest({
        transport: 'scrapingbee',
        url: [VALID_URL],
        cwd: await tmp(),
        env: sbKeyEnv(),
        stdout: { write: () => true },
        connect,
        scrapingBeeGet,
        logger: silentLogger(),
      }),
    ).rejects.toBeInstanceOf(HarvestTosRequiredError);
    expect(connect).not.toHaveBeenCalled();
    expect(scrapingBeeGet).not.toHaveBeenCalled();
  });

  it('rejects missing or placeholder key without Bright Data creds or HTTP', async () => {
    const connect = vi.fn<HarvestConnect>(async () => {
      throw new Error('connect must not run');
    });
    const scrapingBeeGet = vi.fn<ScrapingBeeHttpGet>(async () => {
      throw new Error('scrapingBeeGet must not run');
    });
    const dir = await tmp();
    for (const env of [{ LOG_LEVEL: 'silent' }, { LOG_LEVEL: 'silent', SCRAPINGBEE_API_KEY: 'YOUR_API_KEY' }]) {
      await expect(
        runHarvest({
          transport: 'scrapingbee',
          url: [VALID_URL],
          iAcceptTos: true,
          cwd: dir,
          env,
          stdout: { write: () => true },
          connect,
          scrapingBeeGet,
          logger: silentLogger(),
        }),
      ).rejects.toBeInstanceOf(ScrapingBeeCredentialsError);
    }
    expect(connect).not.toHaveBeenCalled();
    expect(scrapingBeeGet).not.toHaveBeenCalled();
  });
});

describe('runHarvest --transport scrapingbee mock HTML API', () => {
  it('writes JSONL + ok manifest from three envelopes without connect or browser_closed', async () => {
    const dir = await tmp();
    const out = path.join(dir, 'sb.jsonl');
    const { stdout, text } = collectStdout();
    const connect = vi.fn<HarvestConnect>(async () => {
      throw new Error('connect must not run on scrapingbee');
    });
    const events: string[] = [];
    const logger = {
      info: (obj: { event?: string }) => {
        if (typeof obj.event === 'string') {
          events.push(obj.event);
        }
      },
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as never;
    const result = await runHarvest({
      transport: 'scrapingbee',
      url: [VALID_URL],
      iAcceptTos: true,
      out,
      cwd: dir,
      env: sbKeyEnv(),
      stdout,
      connect,
      scrapingBeeGet: mockThreePageGet(),
      logger,
    });
    expect(connect).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    expect(result.n_pages).toBe(3);
    expect(result.n_accepted).toBe(25);
    const body = await readFile(result.outPath, 'utf8');
    const lines = body.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(25);
    const row = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(row['marketplace']).toBe('hktvmall');
    expect(row).not.toHaveProperty('language_hint');
    expect(row).not.toHaveProperty('review_id');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
      ok: boolean;
      failed_url: string | null;
      stopped_reason: string | null;
      page_total: number | null;
    };
    expect(manifest.ok).toBe(true);
    expect(manifest.failed_url).toBeNull();
    expect(manifest.stopped_reason).toBe('end');
    expect(manifest.page_total).toBe(3);
    expect(existsSync(`${result.outPath}.partial`)).toBe(false);
    expect(text()).toMatch(/n_pages=3/);
    expect(text()).toMatch(/n_accepted=25/);
    expect(events).toContain('harvest_url_done');
    expect(events).not.toContain('harvest_browser_closed');
  });

  it('keeps an existing --out when the second URL throws and writes ok:false sidecar', async () => {
    const dir = await tmp();
    const out = path.join(dir, 'keep.jsonl');
    await writeFile(out, '{"old":true}\n', 'utf8');
    const connect = vi.fn<HarvestConnect>(async () => {
      throw new Error('connect must not run');
    });
    let calls = 0;
    const scrapingBeeGet: ScrapingBeeHttpGet = async () => {
      calls += 1;
      if (calls > 3) {
        throw new Error('sb drop url2');
      }
      return {
        status: 200,
        headers: new Headers(),
        bodyText: envelope(threePageHtml(calls - 1)),
      };
    };
    await expect(
      runHarvest({
        transport: 'scrapingbee',
        url: [VALID_URL, URL_2],
        iAcceptTos: true,
        out,
        cwd: dir,
        env: sbKeyEnv(),
        stdout: { write: () => true },
        connect,
        scrapingBeeGet,
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/sb drop url2/);
    expect(connect).not.toHaveBeenCalled();
    expect(await readFile(out, 'utf8')).toBe('{"old":true}\n');
    const manifest = JSON.parse(await readFile(path.join(dir, 'keep.manifest.json'), 'utf8')) as {
      ok: boolean;
      failed_url: string;
      n_urls_ok: number;
      stopped_reason: string | null;
      page_total: number | null;
    };
    expect(manifest.ok).toBe(false);
    expect(manifest.failed_url).toBe(URL_2);
    expect(manifest.n_urls_ok).toBe(1);
    expect(manifest.stopped_reason).toBeNull();
    expect(manifest.page_total).toBeNull();
    expect(existsSync(`${out}.partial`)).toBe(true);
  });

  it('rejects HarvestPaginationShortfallError when page 1 repeats page-0 ids', async () => {
    const dir = await tmp();
    const out = path.join(dir, 'sb-stall.jsonl');
    await writeFile(out, '{"old":true}\n', 'utf8');
    const connect = vi.fn<HarvestConnect>(async () => {
      throw new Error('connect must not run');
    });
    let calls = 0;
    const scrapingBeeGet: ScrapingBeeHttpGet = async () => {
      const pageIndex = calls;
      calls += 1;
      if (pageIndex === 0) {
        return {
          status: 200,
          headers: new Headers(),
          bodyText: envelope(`${THREE_PAGE_CHROME}${wrappersHtml('p0', 10)}`),
        };
      }
      if (pageIndex === 1) {
        return {
          status: 200,
          headers: new Headers(),
          bodyText: envelope(wrappersHtml('p0', 10)),
        };
      }
      throw new Error(`unexpected pageIndex ${String(pageIndex)}`);
    };
    await expect(
      runHarvest({
        transport: 'scrapingbee',
        url: [VALID_URL],
        iAcceptTos: true,
        out,
        cwd: dir,
        env: sbKeyEnv(),
        now: new Date('2026-09-09T12:00:00.000Z'),
        stdout: { write: () => true },
        connect,
        scrapingBeeGet,
        logger: silentLogger(),
      }),
    ).rejects.toBeInstanceOf(HarvestPaginationShortfallError);
    expect(connect).not.toHaveBeenCalled();
    expect(await readFile(out, 'utf8')).toBe('{"old":true}\n');
    const partial = await readFile(`${out}.partial`, 'utf8');
    expect(partial.split('\n').filter((line) => line.length > 0)).toHaveLength(10);
    const manifest = JSON.parse(await readFile(path.join(dir, 'sb-stall.manifest.json'), 'utf8')) as {
      ok: boolean;
      failed_url: string;
      n_urls_ok: number;
      n_urls_failed: number;
      n_accepted: number;
      n_pages: number;
      n_rejected: number;
      stamp: string;
      transport: string;
      stopped_reason: string | null;
      page_total: number | null;
    };
    expect(manifest).toEqual({
      ok: false,
      failed_url: VALID_URL,
      n_urls_ok: 0,
      n_urls_failed: 1,
      n_accepted: 10,
      n_pages: 1,
      n_rejected: 0,
      stamp: '20260909T120000Z',
      transport: 'scrapingbee',
      stopped_reason: 'unchanged_ids',
      page_total: 3,
    });
  });

  it('rejects HarvestPaginationShortfallError when 共N頁 is missing but declared=25', async () => {
    const dir = await tmp();
    const connect = vi.fn<HarvestConnect>(async () => {
      throw new Error('connect must not run');
    });
    const scrapingBeeGet: ScrapingBeeHttpGet = async () => ({
      status: 200,
      headers: new Headers(),
      bodyText: envelope(`<span class="comment__count">25</span>${wrappersHtml('p0', 10)}`),
    });
    await expect(
      runHarvest({
        transport: 'scrapingbee',
        url: [VALID_URL],
        iAcceptTos: true,
        out: path.join(dir, 'sb-declared.jsonl'),
        cwd: dir,
        env: sbKeyEnv(),
        stdout: { write: () => true },
        connect,
        scrapingBeeGet,
        logger: silentLogger(),
      }),
    ).rejects.toBeInstanceOf(HarvestPaginationShortfallError);
    expect(connect).not.toHaveBeenCalled();
    const manifest = JSON.parse(
      await readFile(path.join(dir, 'sb-declared.manifest.json'), 'utf8'),
    ) as {
      ok: boolean;
      n_urls_ok: number;
      n_accepted: number;
      n_pages: number;
      stopped_reason: string | null;
      page_total: number | null;
    };
    expect(manifest.ok).toBe(false);
    expect(manifest.n_urls_ok).toBe(0);
    expect(manifest.n_accepted).toBe(10);
    expect(manifest.n_pages).toBe(1);
    expect(manifest.stopped_reason).toBe('end');
    expect(manifest.page_total).toBeNull();
  });
});
