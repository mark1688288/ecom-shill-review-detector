// SPDX-License-Identifier: GPL-3.0-only

export const BURST_BASELINE_WINDOW_DAYS = 14;
export const BURST_MIN_BASELINE_BUCKETS = 5;
export const BURST_DAY_Z_THRESHOLD = 3;
export const BURST_DAY_MIN_REVIEWS = 10;
export const BURST_HOUR_MIN_REVIEWS = 8;
export const BURST_HOUR_MIN_FIVE_STAR_RATIO = 0.9;

export type DayBurstInput = {
  nReviews: number;
  baselineBuckets: number;
  baselineMean: number | null;
  baselineStddev: number | null;
};

export type HourBurstInput = {
  nReviews: number;
  nFiveStar: number;
  groupBucketCount: number;
};

export type DayBurstResult = {
  zScore: number | null;
  isBurst: boolean;
};

export function burstZScore(nReviews: number, baselineMean: number, baselineStddev: number): number {
  return (nReviews - baselineMean) / baselineStddev;
}

export function isDayBurst(input: DayBurstInput): DayBurstResult {
  const { nReviews, baselineBuckets, baselineMean, baselineStddev } = input;
  if (
    baselineBuckets < BURST_MIN_BASELINE_BUCKETS ||
    baselineMean === null ||
    baselineStddev === null ||
    baselineStddev === 0
  ) {
    return { zScore: null, isBurst: false };
  }
  const zScore = burstZScore(nReviews, baselineMean, baselineStddev);
  return {
    zScore,
    isBurst: zScore >= BURST_DAY_Z_THRESHOLD && nReviews >= BURST_DAY_MIN_REVIEWS,
  };
}

export function isHourBurst(input: HourBurstInput): boolean {
  if (input.groupBucketCount < BURST_MIN_BASELINE_BUCKETS) {
    return false;
  }
  if (input.nReviews < BURST_HOUR_MIN_REVIEWS) {
    return false;
  }
  return input.nFiveStar / input.nReviews >= BURST_HOUR_MIN_FIVE_STAR_RATIO;
}
