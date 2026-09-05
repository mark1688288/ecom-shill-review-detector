// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod';
import { LANGUAGE_HINTS } from '../shared/types.js';

/**
 * One JSONL object per line. Field names are the v1 contract — do not invent others.
 * `reviewer_id_raw` exists only in memory; never write it to NDJSON / BigQuery.
 * Marketplace harvest (e.g. HKTVmall wrappers) must map onto this object.
 */
export const FixtureReviewRaw = z.object({
  marketplace: z.string().min(1).default('fixture'),
  native_review_id: z.string().min(1).nullable().default(null),
  store_id: z.string().min(1),
  product_id: z.string().min(1),
  reviewer_id_raw: z.string().min(1),
  star_rating: z.number().int().min(1).max(5),
  comment_text: z.string().min(1),
  review_ts: z.iso.datetime({ offset: true }),
  source_url: z.string().url().nullable().default(null),
  has_media: z.boolean().default(false),
  language_hint: z.enum(LANGUAGE_HINTS).optional(),
});

export type FixtureReviewRaw = z.infer<typeof FixtureReviewRaw>;

export type FixtureParseFailureReason = 'json' | 'zod';

export type FixtureParseResult =
  | { success: true; data: FixtureReviewRaw }
  | { success: false; reason: FixtureParseFailureReason };

export function parseFixtureReviewLine(line: string): FixtureParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return { success: false, reason: 'json' };
  }
  const result = FixtureReviewRaw.safeParse(parsed);
  if (!result.success) {
    return { success: false, reason: 'zod' };
  }
  return { success: true, data: result.data };
}

export function zodFailureIsStarRating(line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return false;
  }
  const result = FixtureReviewRaw.safeParse(parsed);
  if (result.success) {
    return false;
  }
  return result.error.issues.some((issue) => issue.path[0] === 'star_rating');
}
