// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  parseHktvmallDeclaredReviewCount,
  parseHktvmallReviewPageTotal,
} from '../../src/crawler/harvest/hktvmall-pager-html.js';
import { harvestHktvmallProductViaScrapingBee } from '../../src/crawler/harvest/scrapingbee-driver.js';

const PRODUCT_URL =
  'https://www.hktvmall.com/hktv/zh/main/Store/s/S2090001/cat/p/S2090001_S_4000412';

const PAGER_SAMPLE = `<span class="comment__count">25</span>
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

function starMarkup(filled: number): string {
  const empty = '<div><span class="empty-star"></span></div>'.repeat(5);
  const stars = '<div><span class="star"></span></div>'.repeat(filled);
  return `<span class="product-review-rating"><div class="star-wrapper"><div class="star-container">${empty}</div><div class="star-container">${stars}</div></div></span>`;
}

function wrapperHtml(id: string, user: string, title: string): string {
  return `<div class="product-review-wrapper" data-reviewid="${id}"><div class="product-review-user"><table class="review-info-table"><tr><td class="user-info"><a data-user="${user}" href="/hktv/zh/review/profile?userId=${user}"><span class="review-username">Display Name</span></a></td></tr><tr><td class="td-rating-n-date">${starMarkup(5)}<span class="review-date">2024-06-01</span></td></tr></table></div><div class="product-review-rightPanel"><div class="product-review-content"><div class="review-title"><span>${title}</span></div></div></div></div>`;
}

describe('parseHktvmallDeclaredReviewCount / parseHktvmallReviewPageTotal', () => {
  it('reads comment__count=25 and 共3頁, ignoring JSON-LD 0 and the spec select', () => {
    expect(parseHktvmallDeclaredReviewCount(PAGER_SAMPLE)).toBe(25);
    expect(parseHktvmallReviewPageTotal(PAGER_SAMPLE)).toBe(3);
  });

  it('returns null when 共N頁 is missing and does not treat JSON-LD as declared', () => {
    const html = `<select><option>規格A</option><option>規格B</option></select>
<script type="application/ld+json">{"numberOfReviews":0}</script>`;
    expect(parseHktvmallDeclaredReviewCount(html)).toBeNull();
    expect(parseHktvmallReviewPageTotal(html)).toBeNull();
  });

  it('parses 共0頁 as 0', () => {
    expect(parseHktvmallReviewPageTotal('<span class="total">/共0頁</span>')).toBe(0);
  });

  it('falls back to 則評論 when comment__count is absent', () => {
    expect(parseHktvmallDeclaredReviewCount('<p>42則評論</p>')).toBe(42);
  });
});

describe('driver N from pager HTML', () => {
  it('uses pageTotal=3 from /共3頁/ (spec select does not change N)', async () => {
    const calls: number[] = [];
    const result = await harvestHktvmallProductViaScrapingBee(PRODUCT_URL, {
      fetchPage: async (pageIndex) => {
        calls.push(pageIndex);
        if (pageIndex === 0) {
          return {
            html: `${PAGER_SAMPLE}${wrapperHtml('p0-00', 'u0', '評語0')}`,
            credits: null,
            latency_ms: 1,
          };
        }
        return {
          html: wrapperHtml(`p${String(pageIndex)}-00`, `u${String(pageIndex)}`, `評語${String(pageIndex)}`),
          credits: null,
          latency_ms: 1,
        };
      },
    });
    expect(calls).toEqual([0, 1, 2]);
    expect(result.n_pages).toBe(3);
    expect(result.stopped_reason).toBe('end');
    expect(result.n_declared_reviews).toBe(25);
  });

  it('uses N===1 when 共N頁 is missing', async () => {
    const calls: number[] = [];
    const result = await harvestHktvmallProductViaScrapingBee(PRODUCT_URL, {
      fetchPage: async (pageIndex) => {
        calls.push(pageIndex);
        return {
          html: `${wrapperHtml('p0-00', 'u0', '評語0')}<select><option>規格A</option></select>`,
          credits: null,
          latency_ms: 1,
        };
      },
    });
    expect(calls).toEqual([0]);
    expect(result.n_pages).toBe(1);
    expect(result.stopped_reason).toBe('end');
  });

  it('uses N===1 when HTML says /共0頁/', async () => {
    const calls: number[] = [];
    const result = await harvestHktvmallProductViaScrapingBee(PRODUCT_URL, {
      fetchPage: async (pageIndex) => {
        calls.push(pageIndex);
        return {
          html: `<span class="total">/共0頁</span>${wrapperHtml('p0-00', 'u0', '評語0')}`,
          credits: null,
          latency_ms: 1,
        };
      },
    });
    expect(calls).toEqual([0]);
    expect(result.n_pages).toBe(1);
    expect(result.stopped_reason).toBe('end');
  });
});
