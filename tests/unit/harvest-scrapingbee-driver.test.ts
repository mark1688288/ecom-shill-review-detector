// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  HarvestEmptyAcceptedError,
  UnhydratedReviewPageError,
} from '../../src/crawler/harvest/errors.js';
import { harvestHktvmallProductViaScrapingBee } from '../../src/crawler/harvest/scrapingbee-driver.js';
import { SCRAPINGBEE_PAGER_WAIT_MS } from '../../src/crawler/harvest/scrapingbee-js-scenario.js';

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

function recordFetch(htmlFor: (pageIndex: number) => string): {
  calls: number[];
  fetchPage: (pageIndex: number) => Promise<{ html: string; credits: number | null; latency_ms: number }>;
} {
  const calls: number[] = [];
  return {
    calls,
    fetchPage: async (pageIndex) => {
      calls.push(pageIndex);
      return { html: htmlFor(pageIndex), credits: 25, latency_ms: 8 };
    },
  };
}

describe('harvestHktvmallProductViaScrapingBee', () => {
  it('walks three pages from /共3頁/, unique 25, stopped_reason=end', async () => {
    const { calls, fetchPage } = recordFetch(threePageHtml);
    const result = await harvestHktvmallProductViaScrapingBee(PRODUCT_URL, { fetchPage });
    expect(calls).toEqual([0, 1, 2]);
    expect(result.n_pages).toBe(3);
    expect(result.accepted).toHaveLength(25);
    expect(new Set(result.accepted.map((row) => row.native_review_id)).size).toBe(25);
    expect(result.stopped_reason).toBe('end');
    expect(result.n_declared_reviews).toBe(25);
    expect(result.n_http_requests).toBe(3);
    expect(result.scrapingbee_credits).toBe(75);
    expect(result.latency_ms_click).toBe(0);
  });

  it('stops with max_pages when maxPages=2 even if N=3', async () => {
    const { calls, fetchPage } = recordFetch(threePageHtml);
    const result = await harvestHktvmallProductViaScrapingBee(PRODUCT_URL, {
      fetchPage,
      maxPages: 2,
    });
    expect(calls).toEqual([0, 1]);
    expect(result.n_pages).toBe(2);
    expect(result.stopped_reason).toBe('max_pages');
    expect(result.accepted).toHaveLength(20);
    expect(result.n_http_requests).toBe(2);
  });

  it('stops with max_pages when maxPages=1 and only fetches page 0', async () => {
    const { calls, fetchPage } = recordFetch(threePageHtml);
    const result = await harvestHktvmallProductViaScrapingBee(PRODUCT_URL, {
      fetchPage,
      maxPages: 1,
    });
    expect(calls).toEqual([0]);
    expect(result.n_pages).toBe(1);
    expect(result.stopped_reason).toBe('max_pages');
    expect(result.accepted).toHaveLength(10);
  });

  it('stops with end and n_pages=1 when page 0 has no 共N頁', async () => {
    const { calls, fetchPage } = recordFetch((pageIndex) => {
      if (pageIndex !== 0) {
        throw new Error(`unexpected pageIndex ${String(pageIndex)}`);
      }
      return wrappersHtml('p0', 10);
    });
    const result = await harvestHktvmallProductViaScrapingBee(PRODUCT_URL, { fetchPage });
    expect(calls).toEqual([0]);
    expect(result.n_pages).toBe(1);
    expect(result.stopped_reason).toBe('end');
    expect(result.n_declared_reviews).toBeNull();
  });

  it('stalls with unchanged_ids without committing the repeated page', async () => {
    const { calls, fetchPage } = recordFetch((pageIndex) => {
      if (pageIndex === 0) {
        return `${THREE_PAGE_CHROME}${wrappersHtml('p0', 10)}`;
      }
      if (pageIndex === 1) {
        return wrappersHtml('p0', 10);
      }
      throw new Error(`unexpected pageIndex ${String(pageIndex)}`);
    });
    const result = await harvestHktvmallProductViaScrapingBee(PRODUCT_URL, { fetchPage });
    expect(calls).toEqual([0, 1]);
    expect(result.n_pages).toBe(1);
    expect(result.stopped_reason).toBe('unchanged_ids');
    expect(result.accepted).toHaveLength(10);
    expect(result.n_wrappers).toBe(10);
    expect(result.n_http_requests).toBe(2);
  });

  it('throws UnhydratedReviewPageError with wait_ms=7000 when there are 0 wrappers', async () => {
    const html = `<script type="application/ld+json">{"numberOfReviews":0}</script>
<div>no reviews</div>`;
    try {
      await harvestHktvmallProductViaScrapingBee(PRODUCT_URL, {
        fetchPage: async () => ({ html, credits: null, latency_ms: 1 }),
      });
      expect.unreachable('expected UnhydratedReviewPageError');
    } catch (err) {
      expect(err).toBeInstanceOf(UnhydratedReviewPageError);
      expect((err as UnhydratedReviewPageError).wait_ms).toBe(SCRAPINGBEE_PAGER_WAIT_MS);
      expect((err as UnhydratedReviewPageError).wait_ms).toBe(7000);
    }
  });

  it('throws HarvestEmptyAcceptedError when wrappers exist but none are accepted', async () => {
    const html = `<div class="product-review-wrapper"></div><span class="total">/共1頁</span>`;
    await expect(
      harvestHktvmallProductViaScrapingBee(PRODUCT_URL, {
        fetchPage: async () => ({ html, credits: null, latency_ms: 1 }),
      }),
    ).rejects.toBeInstanceOf(HarvestEmptyAcceptedError);
  });
});
