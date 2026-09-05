// SPDX-License-Identifier: GPL-3.0-only
import type { FixtureReviewRaw } from '../types.js';

/** Last-write-wins on `native_review_id`. Null ids are kept in encounter order and never collapse. */
export function mergeByNativeReviewId(rows: Iterable<FixtureReviewRaw>): {
  rows: FixtureReviewRaw[];
  n_deduped: number;
} {
  const map = new Map<string, FixtureReviewRaw>();
  const noId: FixtureReviewRaw[] = [];
  let n_deduped = 0;
  for (const row of rows) {
    const key = row.native_review_id;
    if (key === null || key === '') {
      noId.push(row);
      continue;
    }
    if (map.has(key)) {
      n_deduped += 1;
    }
    map.set(key, row);
  }
  return { rows: [...map.values(), ...noId], n_deduped };
}
