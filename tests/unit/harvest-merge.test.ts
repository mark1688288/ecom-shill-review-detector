// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { mergeByNativeReviewId } from '../../src/crawler/harvest/merge.js';
import type { FixtureReviewRaw } from '../../src/crawler/types.js';

function row(overrides: Partial<FixtureReviewRaw> & Pick<FixtureReviewRaw, 'native_review_id' | 'comment_text'>): FixtureReviewRaw {
  return {
    marketplace: 'hktvmall',
    store_id: 'S2090001',
    product_id: 'S2090001_S_4000412',
    reviewer_id_raw: 'user-1',
    star_rating: 5,
    review_ts: '2024-06-01T00:00:00+08:00',
    source_url: 'https://www.hktvmall.com/hktv/zh/main/Store/s/S2090001/cat/p/S2090001_S_4000412',
    has_media: false,
    ...overrides,
  };
}

describe('mergeByNativeReviewId', () => {
  it('last-write-wins on native_review_id and counts duplicates', () => {
    const first = row({ native_review_id: 'aaa', comment_text: '舊' });
    const second = row({ native_review_id: 'bbb', comment_text: '另一則' });
    const third = row({ native_review_id: 'aaa', comment_text: '新' });
    const { rows, n_deduped } = mergeByNativeReviewId([first, second, third]);
    expect(n_deduped).toBe(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.comment_text).toBe('新');
    expect(rows[0]?.native_review_id).toBe('aaa');
    expect(rows[1]?.native_review_id).toBe('bbb');
  });

  it('keeps rows with a null native_review_id instead of collapsing them', () => {
    const a = row({ native_review_id: null, comment_text: '甲' });
    const b = row({ native_review_id: null, comment_text: '乙' });
    const { rows, n_deduped } = mergeByNativeReviewId([a, b]);
    expect(n_deduped).toBe(0);
    expect(rows).toHaveLength(2);
  });
});
