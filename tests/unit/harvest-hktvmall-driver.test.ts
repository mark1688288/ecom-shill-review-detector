// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { HarvestSessionDroppedError } from '../../src/crawler/harvest/errors.js';
import type { HarvestLocator, HarvestPage } from '../../src/crawler/harvest/harvest-page.js';
import { harvestHktvmallProductPage } from '../../src/crawler/harvest/hktvmall-driver.js';
import * as hktvmall from '../../src/crawler/harvest/hktvmall.js';

const PRODUCT_URL =
  'https://www.hktvmall.com/hktv/zh/main/Store/s/S2090001/cat/p/S2090001_S_4000412';

function starMarkup(filled: number): string {
  const empty = '<div><span class="empty-star"></span></div>'.repeat(5);
  const stars = '<div><span class="star"></span></div>'.repeat(filled);
  return `<span class="product-review-rating"><div class="star-wrapper"><div class="star-container">${empty}</div><div class="star-container">${stars}</div></div></span>`;
}

function wrapperHtml(id: string, user: string, title: string): string {
  return `<div class="product-review-wrapper" data-reviewid="${id}"><div class="product-review-user"><table class="review-info-table"><tr><td class="user-info"><a data-user="${user}" href="/hktv/zh/review/profile?userId=${user}"><span class="review-username">Display Name</span></a></td></tr><tr><td class="td-rating-n-date">${starMarkup(5)}<span class="review-date">2024-06-01</span></td></tr></table></div><div class="product-review-rightPanel"><div class="product-review-content"><div class="review-title"><span>${title}</span></div></div></div></div>`;
}

function pageHtml(prefix: string, count: number): string {
  const wrappers = Array.from({ length: count }, (_, i) => {
    const n = String(i).padStart(2, '0');
    return wrapperHtml(`${prefix}-${n}`, `u-${prefix}-${n}`, `評語${prefix}${n}`);
  });
  return wrappers.join('');
}

class MockLocator implements HarvestLocator {
  constructor(
    private readonly impl: {
      click?: () => Promise<void>;
      count?: () => Promise<number>;
      getAttribute?: (name: string) => Promise<string | null>;
    },
  ) {}

  first(): HarvestLocator {
    return this;
  }

  visible(): HarvestLocator {
    return this;
  }

  click(opts?: { timeout?: number }): Promise<void> {
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

function emptyLocator(): HarvestLocator {
  return new MockLocator({
    count: async () => 0,
    click: async () => {
      const err = new Error('locator timeout');
      err.name = 'TimeoutError';
      throw err;
    },
  });
}

function tabLocator(): HarvestLocator {
  return new MockLocator({
    click: async () => undefined,
    count: async () => 1,
  });
}

function makePage(opts: {
  htmls: string[];
  nextMode: 'two-page' | 'single-disabled' | 'unchanged' | 'session-drop';
}): HarvestPage {
  let pageIndex = 0;
  let nextClicks = 0;
  const nextLocator = new MockLocator({
    count: async () => {
      if (opts.nextMode === 'single-disabled') {
        return 1;
      }
      return 1;
    },
    getAttribute: async (name: string) => {
      if (opts.nextMode === 'single-disabled') {
        return name === 'aria-disabled' ? 'true' : null;
      }
      if (opts.nextMode === 'two-page' || opts.nextMode === 'unchanged' || opts.nextMode === 'session-drop') {
        if (nextClicks >= 1 && name === 'aria-disabled') {
          return 'true';
        }
      }
      return null;
    },
    click: async () => {
      nextClicks += 1;
      if (opts.nextMode === 'two-page') {
        pageIndex = Math.min(pageIndex + 1, opts.htmls.length - 1);
      }
    },
  });

  return {
    goto: async () => undefined,
    setViewportSize: async () => undefined,
    waitForSelector: async () => undefined,
    content: async () => opts.htmls[pageIndex] ?? '',
    innerText: async () => '42則評論 共5頁',
    waitForNewReviewIds: async () => {
      if (opts.nextMode === 'session-drop') {
        throw new HarvestSessionDroppedError(new Error('Target closed'));
      }
      if (opts.nextMode === 'unchanged') {
        return false;
      }
      return true;
    },
    locator: (selector: string) => {
      if (selector.includes('data-tab="reviewTab"')) {
        return tabLocator();
      }
      return emptyLocator();
    },
    getByRole: (role, roleOpts) => {
      if (role === 'heading' && roleOpts?.name === '評論') {
        return tabLocator();
      }
      if ((role === 'link' || role === 'button') && roleOpts?.name === '下一頁') {
        return nextLocator;
      }
      return emptyLocator();
    },
    getByText: (text) => {
      if (text === '下一頁') {
        return nextLocator;
      }
      return emptyLocator();
    },
  };
}

describe('harvestHktvmallProductPage', () => {
  it('parses two pages, unique 20, n_pages === 2, next_disabled', async () => {
    const parseSpy = vi.spyOn(hktvmall, 'parseHktvmallReviewPage');
    const page = makePage({
      htmls: [pageHtml('p1', 10), pageHtml('p2', 10)],
      nextMode: 'two-page',
    });
    const result = await harvestHktvmallProductPage(page, PRODUCT_URL);
    expect(result.n_pages).toBe(2);
    expect(result.accepted).toHaveLength(20);
    expect(result.n_wrappers).toBe(20);
    expect(result.stopped_reason).toBe('next_disabled');
    expect(result.n_declared_reviews).toBe(42);
    expect(parseSpy).toHaveBeenCalledTimes(2);
    expect(new Set(result.accepted.map((row) => row.native_review_id)).size).toBe(20);
    parseSpy.mockRestore();
  });

  it('stops with unchanged_ids and n_pages === 1 when waitForNewReviewIds is false', async () => {
    const page = makePage({
      htmls: [pageHtml('p1', 10), pageHtml('p2', 10)],
      nextMode: 'unchanged',
    });
    const result = await harvestHktvmallProductPage(page, PRODUCT_URL);
    expect(result.n_pages).toBe(1);
    expect(result.accepted).toHaveLength(10);
    expect(result.stopped_reason).toBe('unchanged_ids');
  });

  it('returns n_pages === 1 when next is disabled on a single-page product', async () => {
    const page = makePage({
      htmls: [pageHtml('p1', 10)],
      nextMode: 'single-disabled',
    });
    const result = await harvestHktvmallProductPage(page, PRODUCT_URL);
    expect(result.n_pages).toBe(1);
    expect(result.accepted).toHaveLength(10);
    expect(result.stopped_reason).toBe('next_disabled');
  });

  it('rejects HarvestSessionDroppedError instead of treating it as unchanged_ids', async () => {
    const page = makePage({
      htmls: [pageHtml('p1', 10)],
      nextMode: 'session-drop',
    });
    await expect(harvestHktvmallProductPage(page, PRODUCT_URL)).rejects.toBeInstanceOf(
      HarvestSessionDroppedError,
    );
  });
});
