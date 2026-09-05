// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  HKTVMALL_MARKETPLACE_ID,
  extractHktvmallReviewWrappers,
  hktvmallReviewTs,
  hktvmallWrapperToFixtureReviewRaw,
  parseHktvmallProductPath,
  parseHktvmallReviewPage,
  parseHktvmallReviewWrapper,
} from '../../src/crawler/harvest/hktvmall.js';
import { parseFixtureReviewLine } from '../../src/crawler/types.js';

const CTX = {
  store_id: 'S2090001',
  product_id: 'S2090001_S_4000412',
  source_url: 'https://www.hktvmall.com/hktv/zh/main/Store/s/S2090001/cat/p/S2090001_S_4000412',
};

function starMarkup(filled: number): string {
  const empty = '<div><span class="empty-star"></span></div>'.repeat(5);
  const stars = '<div><span class="star"></span></div>'.repeat(filled);
  return `<span class="product-review-rating"><div class="star-wrapper"><div class="star-container">${empty}</div><div class="star-container">${stars}</div></div></span>`;
}

function wrapperHtml(opts: {
  id: string;
  user: string;
  stars: number;
  date: string;
  title: string;
  recommend?: boolean;
  reply?: string;
  mediaSrc?: string;
}): string {
  const recommend = opts.recommend === true
    ? '<span class="recommendOrNot"><img src="/_ui/desktop/common/images/icSentimentSatisfied.svg">我會推薦給朋友。</span>'
    : '';
  const reply =
    opts.reply === undefined
      ? ''
      : `<div class="cs-reply-list"><div class="product-review-reply"><div class="product-review-reply-info"><span class="review-username">商戶回覆</span><span class="review-date"> 2024-06-03 </span></div><div class="product-review-detail"><div class="review-content"><span>${opts.reply}</span></div></div></div></div>`;
  const media =
    opts.mediaSrc === undefined
      ? ''
      : `<div class="review-photos"><img src="${opts.mediaSrc}"></div>`;
  return `<div class="product-review-wrapper" data-reviewid="${opts.id}"><div class="product-review-user"><table class="review-info-table"><tr><td class="comment-profile-pic" rowspan="2"><img src="/_ui/desktop/common/images/img_Large_ProfilePic_noImage.svg"></td><td class="user-info"><a data-user="${opts.user}" href="/hktv/zh/review/profile?userId=${opts.user}"><span class="review-username">Display Name</span></a></td></tr><tr><td class="td-rating-n-date">${starMarkup(opts.stars)}<span class="review-date">${opts.date}</span></td></tr></table></div><div class="product-review-rightPanel"><div class="product-review-content"><div class="review-title"><span>${opts.title}</span></div>${media}</div><div class="bottom-wrapper"><span class="praise-useful-wrapper"><img src="/_ui/desktop/common/images/community-praise-useful.svg"><span class="praise-useful-count"> 有用 </span></span>${recommend}</div>${reply}</div></div>`;
}

describe('parseHktvmallProductPath', () => {
  it('reads store_id and product_id from a product URL', () => {
    expect(parseHktvmallProductPath(CTX.source_url)).toEqual({
      store_id: 'S2090001',
      product_id: 'S2090001_S_4000412',
    });
  });

  it('returns null when the path has no /s/…/p/ pair', () => {
    expect(parseHktvmallProductPath('https://www.hktvmall.com/hktv/zh/')).toBeNull();
  });
});

describe('parseHktvmallReviewWrapper', () => {
  it('maps data-reviewid, data-user, filled stars, title, and date', () => {
    const html = wrapperHtml({
      id: '665ada67e352c56b7736e590',
      user: '10611964837892',
      stars: 5,
      date: '2024-06-01',
      title: '好好味！',
      recommend: true,
      reply: '多謝支持，希望下次再能為您服務~!',
    });
    const parsed = parseHktvmallReviewWrapper(html);
    expect(parsed).toEqual({
      success: true,
      data: {
        native_review_id: '665ada67e352c56b7736e590',
        reviewer_id_raw: '10611964837892',
        star_rating: 5,
        comment_text: '好好味！',
        review_date: '2024-06-01',
        has_media: false,
      },
    });
  });

  it('counts overlay span.star and ignores the five empty-star backing row', () => {
    const parsed = parseHktvmallReviewWrapper(
      wrapperHtml({
        id: 'rid-4',
        user: '1002',
        stars: 4,
        date: '2021-01-23',
        title: '送貨得',
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.star_rating).toBe(4);
    }
  });

  it('does not treat merchant reply or recommend badge as comment_text', () => {
    const parsed = parseHktvmallReviewWrapper(
      wrapperHtml({
        id: 'rid-1',
        user: '1001',
        stars: 5,
        date: '2024-06-01',
        title: '好好味！',
        recommend: true,
        reply: '多謝支持',
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.comment_text).toBe('好好味！');
      expect(parsed.data.comment_text).not.toContain('多謝支持');
      expect(parsed.data.comment_text).not.toContain('我會推薦給朋友');
    }
  });

  it('sets has_media when product-review-content has a non-UI image', () => {
    const parsed = parseHktvmallReviewWrapper(
      wrapperHtml({
        id: 'rid-media',
        user: '1003',
        stars: 5,
        date: '2024-06-01',
        title: '有圖',
        mediaSrc: 'https://cdn.example.test/review.jpg',
      }),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.has_media).toBe(true);
    }
  });

  it('rejects wrappers with no filled stars', () => {
    const parsed = parseHktvmallReviewWrapper(
      wrapperHtml({
        id: 'rid-0',
        user: '1004',
        stars: 0,
        date: '2024-06-01',
        title: '無星',
      }),
    );
    expect(parsed).toEqual({ success: false, reason: 'star_rating' });
  });

  it('rejects empty titles', () => {
    const parsed = parseHktvmallReviewWrapper(
      wrapperHtml({
        id: 'rid-empty',
        user: '1005',
        stars: 5,
        date: '2024-06-01',
        title: '   ',
      }),
    );
    expect(parsed).toEqual({ success: false, reason: 'empty_comment' });
  });
});

describe('hktvmallWrapperToFixtureReviewRaw', () => {
  it('emits a FixtureReviewRaw row with HK midnight offset and no invented keys', () => {
    const parsed = parseHktvmallReviewWrapper(
      wrapperHtml({
        id: '665ada67e352c56b7736e590',
        user: '10611964837892',
        stars: 5,
        date: '2024-06-01',
        title: '好好味！',
      }),
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    const row = hktvmallWrapperToFixtureReviewRaw(parsed.data, CTX);
    expect(hktvmallReviewTs('2024-06-01')).toBe('2024-06-01T00:00:00+08:00');
    expect(parseFixtureReviewLine(JSON.stringify(row)).success).toBe(true);
    expect(row).toMatchObject({
      marketplace: HKTVMALL_MARKETPLACE_ID,
      native_review_id: '665ada67e352c56b7736e590',
      store_id: 'S2090001',
      product_id: 'S2090001_S_4000412',
      reviewer_id_raw: '10611964837892',
      star_rating: 5,
      comment_text: '好好味！',
      review_ts: '2024-06-01T00:00:00+08:00',
      source_url: CTX.source_url,
      has_media: false,
    });
    expect(row).not.toHaveProperty('language_hint');
    expect(JSON.stringify(row)).not.toContain('Display Name');
    expect(JSON.stringify(row)).not.toContain('recommendOrNot');
  });
});

describe('parseHktvmallReviewPage', () => {
  it('parses sibling wrappers and skips a shell page with none', () => {
    const page = `${wrapperHtml({
      id: 'aaa',
      user: '1',
      stars: 5,
      date: '2024-06-01',
      title: '五星',
    })}${wrapperHtml({
      id: 'bbb',
      user: '2',
      stars: 3,
      date: '2020-11-10',
      title: '三星',
    })}`;
    const result = parseHktvmallReviewPage(page, CTX);
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(2);
    expect(result.accepted[0]?.native_review_id).toBe('aaa');
    expect(result.accepted[0]?.star_rating).toBe(5);
    expect(result.accepted[1]?.native_review_id).toBe('bbb');
    expect(result.accepted[1]?.star_rating).toBe(3);

    expect(extractHktvmallReviewWrappers('<div id="reviews" class="reviews"></div>')).toEqual([]);
    expect(parseHktvmallReviewPage('<div id="reviews" data-reviews=""></div>', CTX)).toEqual({
      accepted: [],
      rejected: [],
    });
  });
});
