// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { HarvestSessionDroppedError } from '../../src/crawler/harvest/errors.js';
import type { HarvestLocator, HarvestPage, HarvestResult } from '../../src/crawler/harvest/harvest-page.js';
import {
  harvestHktvmallProductPage,
  isHarvestCompletenessFailure,
  maxPageTotalFromText,
} from '../../src/crawler/harvest/hktvmall-driver.js';
import * as hktvmall from '../../src/crawler/harvest/hktvmall.js';

const PRODUCT_URL =
  'https://www.hktvmall.com/hktv/zh/main/Store/s/S2090001/cat/p/S2090001_S_4000412';

const FAST_SETTLE = { settleParsePollMs: 0 } as const;
const SHORT_SETTLE = { settleParsePollMs: 0, settleParseTimeoutMs: 20 } as const;

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

class ClickCounter {
  count = 0;
}

function makePage(opts: {
  contents: Array<string | (() => Promise<string>)>;
  nextEnabled?: 'always' | 'never' | 'until-clicked';
  waitForNewReviewIds?: () => Promise<boolean>;
  clicks?: ClickCounter;
}): HarvestPage {
  const clicks = opts.clicks ?? new ClickCounter();
  const nextEnabled = opts.nextEnabled ?? 'until-clicked';
  let contentCalls = 0;
  const nextLocator = new MockLocator({
    count: async () => 1,
    getAttribute: async (name) => {
      const disabled =
        nextEnabled === 'never' || (nextEnabled === 'until-clicked' && clicks.count >= 1);
      if (disabled && name === 'aria-disabled') {
        return 'true';
      }
      return null;
    },
    click: async () => {
      clicks.count += 1;
    },
  });

  return {
    goto: async () => undefined,
    setViewportSize: async () => undefined,
    waitForSelector: async () => undefined,
    content: async () => {
      const idx = contentCalls < opts.contents.length ? contentCalls : Math.max(opts.contents.length - 1, 0);
      contentCalls += 1;
      const item = opts.contents[idx];
      if (item === undefined) {
        return '';
      }
      if (typeof item === 'function') {
        return item();
      }
      return item;
    },
    innerText: async () => '',
    waitForNewReviewIds: async () => {
      if (opts.waitForNewReviewIds !== undefined) {
        return opts.waitForNewReviewIds();
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

function completenessResult(
  partial: Pick<HarvestResult, 'stopped_reason' | 'n_pages' | 'page_total' | 'n_declared_reviews'>,
): HarvestResult {
  return {
    url: PRODUCT_URL,
    store_id: 'S2090001',
    product_id: 'S2090001_S_4000412',
    accepted: [],
    rejected: [],
    n_pages: partial.n_pages,
    n_wrappers: 0,
    n_declared_reviews: partial.n_declared_reviews,
    page_total: partial.page_total,
    latency_ms_goto: 0,
    latency_ms_click: 0,
    latency_ms_total: 0,
    stopped_reason: partial.stopped_reason,
  };
}

describe('maxPageTotalFromText', () => {
  it('uses the larger review pager when Q&A 共1頁 is also present', () => {
    expect(maxPageTotalFromText('4.6 (381 則評論)\n/共39頁\n問問大家\n/共1頁')).toBe(39);
  });
});

describe('harvestHktvmallProductPage', () => {
  it('parses two pages, unique 20, n_pages === 2, next_disabled', async () => {
    const parseSpy = vi.spyOn(hktvmall, 'parseHktvmallReviewPage');
    const page = makePage({
      contents: [pageHtml('p1', 10), pageHtml('p2', 10)],
    });
    const result = await harvestHktvmallProductPage(page, PRODUCT_URL, FAST_SETTLE);
    expect(result.n_pages).toBe(2);
    expect(result.accepted).toHaveLength(20);
    expect(result.n_wrappers).toBe(20);
    expect(result.stopped_reason).toBe('next_disabled');
    expect(result.n_declared_reviews).toBeNull();
    expect(result.page_total).toBeNull();
    expect(parseSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(result.accepted.map((row) => row.native_review_id)).size).toBe(20);
    parseSpy.mockRestore();
  });

  it('1 race: empty content after wait true then 10 new ids commits page 2', async () => {
    const parseSpy = vi.spyOn(hktvmall, 'parseHktvmallReviewPage');
    const page = makePage({
      contents: [pageHtml('p1', 10), '', '', pageHtml('p2', 10)],
    });
    const result = await harvestHktvmallProductPage(page, PRODUCT_URL, FAST_SETTLE);
    expect(result.n_pages).toBe(2);
    expect(result.accepted).toHaveLength(20);
    expect(result.n_wrappers).toBe(20);
    expect(result.stopped_reason).toBe('next_disabled');
    expect(new Set(result.accepted.map((row) => row.native_review_id)).size).toBe(20);
    expect(parseSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    parseSpy.mockRestore();
  });

  it('1b remainder: 8 new ids on page 2 with /共2頁/ ends without a third click', async () => {
    const clicks = new ClickCounter();
    const chrome = '<span class="total">/共2頁</span>';
    const page = makePage({
      contents: [`${chrome}${pageHtml('p1', 10)}`, `${chrome}${pageHtml('p2', 8)}`],
      nextEnabled: 'always',
      clicks,
    });
    const result = await harvestHktvmallProductPage(page, PRODUCT_URL, FAST_SETTLE);
    expect(result.stopped_reason).toBe('end');
    expect(result.n_pages).toBe(2);
    expect(result.accepted).toHaveLength(18);
    expect(result.page_total).toBe(2);
    expect(result.n_declared_reviews).toBeNull();
    expect(clicks.count).toBe(1);
  });

  it('1c page-1 empty content then wrappers does not throw UnhydratedReviewPageError', async () => {
    const page = makePage({
      contents: ['', pageHtml('p1', 10)],
      nextEnabled: 'never',
    });
    const result = await harvestHktvmallProductPage(page, PRODUCT_URL, FAST_SETTLE);
    expect(result.n_pages).toBe(1);
    expect(result.accepted).toHaveLength(10);
    expect(result.stopped_reason).toBe('next_disabled');
  });

  it('2 settle timeout after wait true does not throw and stays on page 1', async () => {
    const page = makePage({
      contents: [pageHtml('p1', 10), ''],
      nextEnabled: 'always',
    });
    const result = await harvestHktvmallProductPage(page, PRODUCT_URL, SHORT_SETTLE);
    expect(result.stopped_reason).toBe('unchanged_ids');
    expect(result.n_pages).toBe(1);
    expect(result.accepted).toHaveLength(10);
    expect(result.n_wrappers).toBe(10);
  });

  it('3 Q&A 共1頁 vs review 共54頁 freezes page_total at 54', async () => {
    const first = `<span class="total">/共1頁</span><span class="total">/共54頁</span>${pageHtml('p1', 10)}`;
    const emptyQa = '<span class="total">/共1頁</span>';
    const page = makePage({
      contents: [first, emptyQa],
      nextEnabled: 'always',
    });
    const result = await harvestHktvmallProductPage(page, PRODUCT_URL, SHORT_SETTLE);
    expect(result.page_total).toBe(54);
    expect(result.n_pages).toBe(1);
    expect(result.stopped_reason).toBe('unchanged_ids');
  });

  it('3b understated page_total=1 with declared=536 does not end on page 1', async () => {
    const clicks = new ClickCounter();
    const html = `<span class="total">/共1頁</span><span class="comment__count">536</span>${pageHtml('p1', 10)}`;
    const page = makePage({
      contents: [html],
      nextEnabled: 'always',
      waitForNewReviewIds: async () => false,
      clicks,
    });
    const result = await harvestHktvmallProductPage(page, PRODUCT_URL, FAST_SETTLE);
    expect(result.stopped_reason).not.toBe('end');
    expect(clicks.count).toBe(1);
    expect(result.stopped_reason).toBe('unchanged_ids');
    expect(result.n_pages).toBe(1);
    expect(result.page_total).toBe(1);
    expect(result.n_declared_reviews).toBe(536);
    expect(isHarvestCompletenessFailure(result)).toBe(true);
  });

  it('stops with unchanged_ids and n_pages === 1 when waitForNewReviewIds is false', async () => {
    const page = makePage({
      contents: [pageHtml('p1', 10), pageHtml('p2', 10)],
      waitForNewReviewIds: async () => false,
    });
    const result = await harvestHktvmallProductPage(page, PRODUCT_URL, FAST_SETTLE);
    expect(result.n_pages).toBe(1);
    expect(result.accepted).toHaveLength(10);
    expect(result.stopped_reason).toBe('unchanged_ids');
  });

  it('returns n_pages === 1 when next is disabled on a single-page product', async () => {
    const page = makePage({
      contents: [pageHtml('p1', 10)],
      nextEnabled: 'never',
    });
    const result = await harvestHktvmallProductPage(page, PRODUCT_URL, FAST_SETTLE);
    expect(result.n_pages).toBe(1);
    expect(result.accepted).toHaveLength(10);
    expect(result.stopped_reason).toBe('next_disabled');
  });

  it('rejects HarvestSessionDroppedError instead of treating it as unchanged_ids', async () => {
    const page = makePage({
      contents: [pageHtml('p1', 10)],
      waitForNewReviewIds: async () => {
        throw new HarvestSessionDroppedError(new Error('Target closed'));
      },
    });
    await expect(harvestHktvmallProductPage(page, PRODUCT_URL, FAST_SETTLE)).rejects.toBeInstanceOf(
      HarvestSessionDroppedError,
    );
  });

  it('rejects HarvestSessionDroppedError from settle content() and does not map to unchanged_ids', async () => {
    const page = makePage({
      contents: [
        pageHtml('p1', 10),
        async () => {
          throw new HarvestSessionDroppedError(new Error('Target closed'));
        },
      ],
      nextEnabled: 'always',
    });
    await expect(harvestHktvmallProductPage(page, PRODUCT_URL, FAST_SETTLE)).rejects.toBeInstanceOf(
      HarvestSessionDroppedError,
    );
  });
});

describe('isHarvestCompletenessFailure', () => {
  it('4 predicate matrix', () => {
    expect(
      isHarvestCompletenessFailure(
        completenessResult({
          stopped_reason: 'end',
          n_pages: 28,
          page_total: 54,
          n_declared_reviews: 536,
        }),
      ),
    ).toBe(true);
    expect(
      isHarvestCompletenessFailure(
        completenessResult({
          stopped_reason: 'unchanged_ids',
          n_pages: 1,
          page_total: 54,
          n_declared_reviews: 536,
        }),
      ),
    ).toBe(true);
    expect(
      isHarvestCompletenessFailure(
        completenessResult({
          stopped_reason: 'end',
          n_pages: 54,
          page_total: 54,
          n_declared_reviews: 536,
        }),
      ),
    ).toBe(false);
    expect(
      isHarvestCompletenessFailure(
        completenessResult({
          stopped_reason: 'max_pages',
          n_pages: 20,
          page_total: 54,
          n_declared_reviews: 536,
        }),
      ),
    ).toBe(false);
    expect(
      isHarvestCompletenessFailure(
        completenessResult({
          stopped_reason: 'end',
          n_pages: 1,
          page_total: null,
          n_declared_reviews: 25,
        }),
      ),
    ).toBe(true);
    expect(
      isHarvestCompletenessFailure(
        completenessResult({
          stopped_reason: 'next_disabled',
          n_pages: 1,
          page_total: 1,
          n_declared_reviews: null,
        }),
      ),
    ).toBe(false);
    expect(
      isHarvestCompletenessFailure(
        completenessResult({
          stopped_reason: 'end',
          n_pages: 1,
          page_total: 1,
          n_declared_reviews: 536,
        }),
      ),
    ).toBe(true);
    expect(
      isHarvestCompletenessFailure(
        completenessResult({
          stopped_reason: 'next_disabled',
          n_pages: 54,
          page_total: 54,
          n_declared_reviews: 541,
        }),
      ),
    ).toBe(true);
  });
});
