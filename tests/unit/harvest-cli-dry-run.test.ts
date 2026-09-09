// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../../src/cli/main.js';
import { runHarvest, type HarvestConnect } from '../../src/cli/commands/harvest.js';
import {
  HarvestPaginationShortfallError,
  HarvestTosRequiredError,
  HktvmallUrlParseError,
} from '../../src/crawler/harvest/errors.js';
import type { HarvestLocator, HarvestPage } from '../../src/crawler/harvest/harvest-page.js';
import { BrightDataCredentialsError } from '../../src/shared/env.js';

const VALID_URL =
  'https://www.hktvmall.com/hktv/zh/main/Store/s/S2090001/cat/p/S2090001_S_4000412';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-harvest-'));
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

class MockLocator implements HarvestLocator {
  constructor(
    private readonly impl: {
      click?: () => Promise<void>;
      count?: () => Promise<number>;
      getAttribute?: (name: string) => Promise<string | null>;
    } = {},
  ) {}
  first(): HarvestLocator {
    return this;
  }
  visible(): HarvestLocator {
    return this;
  }
  click(opts?: { timeout?: number; force?: boolean }): Promise<void> {
    void opts;
    return this.impl.click?.() ?? Promise.resolve();
  }
  count(): Promise<number> {
    return this.impl.count?.() ?? Promise.resolve(0);
  }
  getAttribute(name: string): Promise<string | null> {
    return this.impl.getAttribute?.(name) ?? Promise.resolve(null);
  }
}

function onePageHtml(): string {
  return `<div class="product-review-wrapper" data-reviewid="rid-1"><div class="product-review-user"><table class="review-info-table"><tr><td class="user-info"><a data-user="u1" href="/hktv/zh/review/profile?userId=u1"><span class="review-username">N</span></a></td></tr><tr><td class="td-rating-n-date"><span class="product-review-rating"><div class="star-wrapper"><div class="star-container">${'<div><span class="empty-star"></span></div>'.repeat(5)}</div><div class="star-container">${'<div><span class="star"></span></div>'.repeat(5)}</div></div></span><span class="review-date">2024-06-01</span></td></tr></table></div><div class="product-review-rightPanel"><div class="product-review-content"><div class="review-title"><span>好好味！</span></div></div></div></div>`;
}

function starMarkup(filled: number): string {
  const empty = '<div><span class="empty-star"></span></div>'.repeat(5);
  const stars = '<div><span class="star"></span></div>'.repeat(filled);
  return `<span class="product-review-rating"><div class="star-wrapper"><div class="star-container">${empty}</div><div class="star-container">${stars}</div></div></span>`;
}

function wrapperHtml(id: string, user: string, title: string): string {
  return `<div class="product-review-wrapper" data-reviewid="${id}"><div class="product-review-user"><table class="review-info-table"><tr><td class="user-info"><a data-user="${user}" href="/hktv/zh/review/profile?userId=${user}"><span class="review-username">Display Name</span></a></td></tr><tr><td class="td-rating-n-date">${starMarkup(5)}<span class="review-date">2024-06-01</span></td></tr></table></div><div class="product-review-rightPanel"><div class="product-review-content"><div class="review-title"><span>${title}</span></div></div></div></div>`;
}

function tenWrappersHtml(chrome: string): string {
  const wrappers = Array.from({ length: 10 }, (_, i) => {
    const n = String(i).padStart(2, '0');
    return wrapperHtml(`rid-${n}`, `u-${n}`, `評語${n}`);
  });
  return `${chrome}${wrappers.join('')}`;
}

function mockHarvestPage(opts: {
  html: string;
  nextEnabled: boolean;
  waitForNewReviewIds?: () => Promise<boolean>;
}): HarvestPage {
  const tab = new MockLocator({ click: async () => undefined, count: async () => 1 });
  const next = new MockLocator({
    count: async () => 1,
    getAttribute: async (name) =>
      !opts.nextEnabled && name === 'aria-disabled' ? 'true' : null,
  });
  const empty = new MockLocator();
  return {
    goto: async () => undefined,
    setViewportSize: async () => undefined,
    waitForSelector: async () => undefined,
    content: async () => opts.html,
    innerText: async () => '',
    waitForNewReviewIds: async () => {
      if (opts.waitForNewReviewIds !== undefined) {
        return opts.waitForNewReviewIds();
      }
      return false;
    },
    locator: (selector: string) => (selector.includes('reviewTab') ? tab : empty),
    getByRole: (role, roleOpts) => {
      if (role === 'heading') {
        return tab;
      }
      if (roleOpts?.name === '下一頁') {
        return next;
      }
      return empty;
    },
    getByText: (text) => (text === '下一頁' ? next : empty),
  };
}

function onePagePage(): HarvestPage {
  const tab = new MockLocator({ click: async () => undefined, count: async () => 1 });
  const next = new MockLocator({
    count: async () => 1,
    getAttribute: async (name) => (name === 'aria-disabled' ? 'true' : null),
  });
  const empty = new MockLocator();
  return {
    goto: async () => undefined,
    setViewportSize: async () => undefined,
    waitForSelector: async () => undefined,
    content: async () => onePageHtml(),
    innerText: async () => '1則評論 共1頁',
    waitForNewReviewIds: async () => false,
    locator: (selector: string) => (selector.includes('reviewTab') ? tab : empty),
    getByRole: (role, opts) => {
      if (role === 'heading') {
        return tab;
      }
      if (opts?.name === '下一頁') {
        return next;
      }
      return empty;
    },
    getByText: (text) => (text === '下一頁' ? next : empty),
  };
}

function dummyCreds(): NodeJS.ProcessEnv {
  return {
    LOG_LEVEL: 'silent',
    BRIGHTDATA_BROWSERAPI_USERNAME: 'brd-customer-test-zone-browser',
    BRIGHTDATA_BROWSERAPI_PASSWORD: 'dummy-pass',
  };
}

describe('harvest CLI flags', () => {
  it('does not register addRunFlags options', () => {
    const harvest = buildProgram().commands.find((cmd) => cmd.name() === 'harvest');
    expect(harvest).toBeDefined();
    const help = harvest?.helpInformation() ?? '';
    expect(help).toContain('--url');
    expect(help).toContain('--transport');
    expect(help).toContain('--i-accept-tos');
    expect(help).toContain('--dry-run');
    expect(help).toContain('wrapper');
    expect(help).toContain('does not create pipeline runs');
    expect(help).toContain('cost cap');
    expect(help).toMatch(/Does not control pagination\s+completeness/);
    expect(help).not.toContain('--pipeline-run-id');
    expect(help).not.toContain('--continue-latest');
    expect(help).not.toContain('--i-am-prod');
    expect(help).not.toMatch(/Fail crawl on any fixture row Zod/);
  });
});

describe('runHarvest dry-run', () => {
  it('prints plan_* without creds, salt, ToS, files, or connect', async () => {
    const dir = await tmp();
    const out = path.join(dir, 'out.jsonl');
    const { stdout, text } = collectStdout();
    const connect = vi.fn<HarvestConnect>(async () => {
      throw new Error('connect must not run on dry-run');
    });
    const result = await runHarvest({
      url: [VALID_URL],
      dryRun: true,
      out,
      cwd: dir,
      env: { LOG_LEVEL: 'silent' },
      stdout,
      connect,
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(connect).not.toHaveBeenCalled();
    expect(existsSync(out)).toBe(false);
    expect(existsSync(`${out}.partial`)).toBe(false);
    const printed = text();
    expect(printed).toContain('plan_transport=brightdata');
    expect(printed).toContain('plan_marketplace=hktvmall');
    expect(printed).toContain(`plan_url=${VALID_URL}`);
    expect(printed).toContain('plan_store_id=S2090001');
    expect(printed).toContain('plan_product_id=S2090001_S_4000412');
    expect(printed).toContain('plan_host=www.hktvmall.com');
    expect(printed).toContain('plan_country=hk');
    expect(printed).toContain('plan_click=css:[data-tab="reviewTab"]');
    expect(printed).toContain('plan_wait=div.product-review-wrapper');
    expect(printed).toContain('plan_next=role:link|button name=下一頁');
    expect(printed).toContain('plan_paginate=waitForNewReviewIds+content_poll');
    expect(printed).toContain('plan_locale_path=/hktv/zh/');
    expect(printed).toContain('plan_connect=no');
    expect(printed).toContain('plan_goto_waitUntil=domcontentloaded');
  });

  it('rejects evil.hktvmall.com, example.invalid, and /hktv/en/ without connect', async () => {
    const connect = vi.fn<HarvestConnect>(async () => {
      throw new Error('connect must not run');
    });
    const dir = await tmp();
    const cases = [
      'https://evil.hktvmall.com/hktv/zh/main/Store/s/S1/cat/p/P1',
      'https://example.invalid/s/S1/p/P1',
      'https://www.hktvmall.com/hktv/en/s/S1/p/P1',
    ];
    for (const url of cases) {
      await expect(
        runHarvest({
          url: [url],
          dryRun: true,
          cwd: dir,
          env: { LOG_LEVEL: 'silent' },
          stdout: { write: () => true },
          connect,
          logger: silentLogger(),
        }),
      ).rejects.toBeInstanceOf(HktvmallUrlParseError);
    }
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('runHarvest live gates', () => {
  it('exits via HarvestTosRequiredError without --i-accept-tos and does not connect', async () => {
    const connect = vi.fn<HarvestConnect>(async () => {
      throw new Error('connect must not run without ToS');
    });
    await expect(
      runHarvest({
        url: [VALID_URL],
        cwd: await tmp(),
        env: dummyCreds(),
        stdout: { write: () => true },
        connect,
        logger: silentLogger(),
      }),
    ).rejects.toBeInstanceOf(HarvestTosRequiredError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('HarvestTosRequiredError message does not claim v1 still sends no HTTP', async () => {
    const err = new HarvestTosRequiredError();
    expect(err.message).toMatch(/ToS/);
    expect(err.message).not.toMatch(/v1 still sends no HTTP/);
  });

  it('requires Browser API creds after ToS', async () => {
    const connect = vi.fn<HarvestConnect>(async () => {
      throw new Error('connect must not run without creds');
    });
    await expect(
      runHarvest({
        url: [VALID_URL],
        iAcceptTos: true,
        cwd: await tmp(),
        env: { LOG_LEVEL: 'silent' },
        stdout: { write: () => true },
        connect,
        logger: silentLogger(),
      }),
    ).rejects.toBeInstanceOf(BrightDataCredentialsError);
    expect(connect).not.toHaveBeenCalled();
  });

  it('rejects unsupported marketplace with exitCode 2', async () => {
    try {
      await runHarvest({
        marketplace: 'fixture',
        url: [VALID_URL],
        dryRun: true,
        cwd: await tmp(),
        env: { LOG_LEVEL: 'silent' },
        stdout: { write: () => true },
        logger: silentLogger(),
      });
      expect.fail('expected HarvestUsageError');
    } catch (err) {
      expect(err).toMatchObject({ exitCode: 2 });
    }
  });
});

describe('runHarvest live mock (no CDP)', () => {
  it('writes JSONL + ok manifest using the default stamp and does not invent language_hint', async () => {
    const dir = await tmp();
    const { stdout, text } = collectStdout();
    const connect = vi.fn<HarvestConnect>(async () => ({
      page: onePagePage(),
      close: async () => undefined,
    }));
    const result = await runHarvest({
      url: [VALID_URL],
      iAcceptTos: true,
      cwd: dir,
      env: dummyCreds(),
      now: new Date('2026-09-05T12:00:00.000Z'),
      stdout,
      connect,
      logger: silentLogger(),
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.n_pages).toBe(1);
    expect(result.n_accepted).toBe(1);
    expect(result.outPath).toBe(
      path.join(dir, 'data', 'harvested', '20260905T120000Z-hktvmall.jsonl'),
    );
    const body = await readFile(result.outPath, 'utf8');
    const row = JSON.parse(body.trim()) as Record<string, unknown>;
    expect(row['native_review_id']).toBe('rid-1');
    expect(row['reviewer_id_raw']).toBe('u1');
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
    expect(manifest.stopped_reason).toBe('next_disabled');
    expect(manifest.page_total).toBeNull();
    expect(existsSync(`${result.outPath}.partial`)).toBe(false);
    expect(text()).toMatch(/n_pages=1/);
    expect(text()).toMatch(/n_accepted=1/);
  });

  it('does not unlink an existing --out on failure and writes ok:false sidecar', async () => {
    const dir = await tmp();
    const out = path.join(dir, 'keep.jsonl');
    await writeFile(out, '{"old":true}\n', 'utf8');
    const connect = vi.fn<HarvestConnect>(async () => {
      throw new Error('Target closed');
    });
    await expect(
      runHarvest({
        url: [VALID_URL],
        iAcceptTos: true,
        out,
        cwd: dir,
        env: dummyCreds(),
        stdout: { write: () => true },
        connect,
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/Target closed|session dropped|connectOverCDP/i);
    expect(await readFile(out, 'utf8')).toBe('{"old":true}\n');
    const manifest = JSON.parse(
      await readFile(path.join(dir, 'keep.manifest.json'), 'utf8'),
    ) as {
      ok: boolean;
      failed_url: string;
      n_urls_ok: number;
      stopped_reason: string | null;
      page_total: number | null;
    };
    expect(manifest.ok).toBe(false);
    expect(manifest.failed_url).toBe(VALID_URL);
    expect(manifest.n_urls_ok).toBe(0);
    expect(manifest.stopped_reason).toBeNull();
    expect(manifest.page_total).toBeNull();
    expect(existsSync(`${out}.partial`)).toBe(true);
  });

  it('7 rejects HarvestPaginationShortfallError when waitForNewReviewIds is false on a 54-page product', async () => {
    const dir = await tmp();
    const out = path.join(dir, 'keep.jsonl');
    await writeFile(out, '{"old":true}\n', 'utf8');
    const events: string[] = [];
    const logger = {
      info: (obj: { event?: string }) => {
        if (typeof obj.event === 'string') {
          events.push(obj.event);
        }
      },
      warn: (obj: { event?: string }) => {
        if (typeof obj.event === 'string') {
          events.push(obj.event);
        }
      },
      error: (obj: { event?: string }) => {
        if (typeof obj.event === 'string') {
          events.push(obj.event);
        }
      },
      debug: () => undefined,
    } as never;
    const connect = vi.fn<HarvestConnect>(async () => ({
      page: mockHarvestPage({
        html: tenWrappersHtml(
          '<span class="comment__count">536</span><span class="total">/共54頁</span>',
        ),
        nextEnabled: true,
        waitForNewReviewIds: async () => false,
      }),
      close: async () => undefined,
    }));
    await expect(
      runHarvest({
        url: [VALID_URL],
        iAcceptTos: true,
        out,
        cwd: dir,
        env: dummyCreds(),
        now: new Date('2026-09-09T12:00:00.000Z'),
        stdout: { write: () => true },
        connect,
        logger,
      }),
    ).rejects.toBeInstanceOf(HarvestPaginationShortfallError);
    expect(await readFile(out, 'utf8')).toBe('{"old":true}\n');
    expect(existsSync(out)).toBe(true);
    const partial = await readFile(`${out}.partial`, 'utf8');
    expect(partial.split('\n').filter((line) => line.length > 0)).toHaveLength(10);
    const manifest = JSON.parse(await readFile(path.join(dir, 'keep.manifest.json'), 'utf8')) as {
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
      transport: 'brightdata',
      stopped_reason: 'unchanged_ids',
      page_total: 54,
    });
    expect(events).toContain('harvest_pagination_shortfall');
    expect(events).not.toContain('harvest_incomplete_pages');
  });

  it('9 max_pages is not a shortfall and still ok:true', async () => {
    const dir = await tmp();
    const events: string[] = [];
    const logger = {
      info: () => undefined,
      warn: (obj: { event?: string }) => {
        if (typeof obj.event === 'string') {
          events.push(obj.event);
        }
      },
      error: (obj: { event?: string }) => {
        if (typeof obj.event === 'string') {
          events.push(obj.event);
        }
      },
      debug: () => undefined,
    } as never;
    const connect = vi.fn<HarvestConnect>(async () => ({
      page: mockHarvestPage({
        html: tenWrappersHtml('<span class="total">/共3頁</span>'),
        nextEnabled: true,
        waitForNewReviewIds: async () => {
          throw new Error('waitForNewReviewIds must not run after max_pages');
        },
      }),
      close: async () => undefined,
    }));
    const result = await runHarvest({
      url: [VALID_URL],
      iAcceptTos: true,
      maxPages: '1',
      cwd: dir,
      env: dummyCreds(),
      now: new Date('2026-09-09T12:00:00.000Z'),
      stdout: { write: () => true },
      connect,
      logger,
    });
    expect(result.ok).toBe(true);
    expect(result.n_pages).toBe(1);
    expect(result.n_accepted).toBe(10);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as {
      ok: boolean;
      stopped_reason: string | null;
      page_total: number | null;
    };
    expect(manifest.ok).toBe(true);
    expect(manifest.stopped_reason).toBe('max_pages');
    expect(manifest.page_total).toBe(3);
    expect(events).toContain('harvest_max_pages');
    expect(events).not.toContain('harvest_pagination_shortfall');
    expect(existsSync(`${result.outPath}.partial`)).toBe(false);
  });

  it('fail-fast: second URL is not connected after the first throws', async () => {
    const dir = await tmp();
    const url2 = 'https://www.hktvmall.com/hktv/zh/main/Store/s/S2/cat/p/S2_S_1';
    let calls = 0;
    const failingConnect: HarvestConnect = async () => {
      calls += 1;
      throw new Error('cdp drop url1');
    };
    await expect(
      runHarvest({
        url: [VALID_URL, url2],
        iAcceptTos: true,
        out: path.join(dir, 'out.jsonl'),
        cwd: dir,
        env: dummyCreds(),
        stdout: { write: () => true },
        connect: failingConnect,
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/cdp drop url1/);
    expect(calls).toBe(1);
  });
});
