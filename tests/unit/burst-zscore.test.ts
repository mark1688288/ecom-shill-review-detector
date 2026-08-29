// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { burstZScore, isDayBurst, isHourBurst } from '../../src/analysis/burst.js';

describe('burstZScore', () => {
  it('is (n - mean) / stddev', () => {
    expect(burstZScore(40, 10, 10)).toBe(3);
    expect(burstZScore(10, 10, 5)).toBe(0);
  });
});

describe('isDayBurst', () => {
  it('is false when baseline n < 5', () => {
    expect(
      isDayBurst({
        nReviews: 100,
        baselineBuckets: 4,
        baselineMean: 5,
        baselineStddev: 1,
      }),
    ).toEqual({ zScore: null, isBurst: false });
  });

  it('is false when stddev is 0 or null', () => {
    expect(
      isDayBurst({
        nReviews: 100,
        baselineBuckets: 7,
        baselineMean: 10,
        baselineStddev: 0,
      }),
    ).toEqual({ zScore: null, isBurst: false });
    expect(
      isDayBurst({
        nReviews: 100,
        baselineBuckets: 7,
        baselineMean: 10,
        baselineStddev: null,
      }),
    ).toEqual({ zScore: null, isBurst: false });
  });

  it('is true on a z>=3 spike with n_reviews >= 10', () => {
    expect(
      isDayBurst({
        nReviews: 40,
        baselineBuckets: 14,
        baselineMean: 10,
        baselineStddev: 10,
      }),
    ).toEqual({ zScore: 3, isBurst: true });
  });

  it('is false when z>=3 but n_reviews < 10', () => {
    expect(
      isDayBurst({
        nReviews: 9,
        baselineBuckets: 14,
        baselineMean: 1,
        baselineStddev: 1,
      }),
    ).toEqual({ zScore: 8, isBurst: false });
  });
});

describe('isHourBurst', () => {
  it('is false when the group has fewer than 5 hour buckets', () => {
    expect(
      isHourBurst({
        nReviews: 20,
        nFiveStar: 20,
        groupBucketCount: 4,
      }),
    ).toBe(false);
  });

  it('is false when n_reviews < 8', () => {
    expect(
      isHourBurst({
        nReviews: 7,
        nFiveStar: 7,
        groupBucketCount: 8,
      }),
    ).toBe(false);
  });

  it('is true when n>=8, five-star ratio >= 0.9, and enough buckets', () => {
    expect(
      isHourBurst({
        nReviews: 10,
        nFiveStar: 9,
        groupBucketCount: 5,
      }),
    ).toBe(true);
  });

  it('is false when five-star ratio is below 0.9', () => {
    expect(
      isHourBurst({
        nReviews: 10,
        nFiveStar: 8,
        groupBucketCount: 5,
      }),
    ).toBe(false);
  });
});
