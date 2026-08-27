// SPDX-License-Identifier: GPL-3.0-only
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LanguageHint } from '../../shared/types.js';
import type { NormalizedReview } from '../adapter.js';
import { contentHash, makeReviewId, sourceUrlHash } from '../hash.js';
import { charLengthCodePoints } from '../normalize.js';

/** Column names match `raw_reviews`. Never include reviewer_id_raw / cookie / Authorization. */
export type RawReviewNdjson = {
  review_id: string;
  marketplace: string;
  native_review_id: string | null;
  store_id: string;
  product_id: string;
  reviewer_id_hash: string;
  star_rating: number;
  comment_text: string;
  content_hash: string;
  review_ts: string;
  ingested_at: string;
  crawl_batch_id: string;
  pipeline_run_id: string;
  source_url_hash: string | null;
  language_hint: LanguageHint;
  has_media: boolean;
  raw_payload_hash: string;
  char_length: number;
  updated_at: string;
};

export const RAW_REVIEW_NDJSON_KEYS = [
  'review_id',
  'marketplace',
  'native_review_id',
  'store_id',
  'product_id',
  'reviewer_id_hash',
  'star_rating',
  'comment_text',
  'content_hash',
  'review_ts',
  'ingested_at',
  'crawl_batch_id',
  'pipeline_run_id',
  'source_url_hash',
  'language_hint',
  'has_media',
  'raw_payload_hash',
  'char_length',
  'updated_at',
] as const;

export const FORBIDDEN_NDJSON_KEYS = [
  'reviewer_id_raw',
  'cookie',
  'Cookie',
  'authorization',
  'Authorization',
] as const;

export type PersistContext = {
  crawl_batch_id: string;
  pipeline_run_id: string;
  ingested_at: Date;
};

export function toRawReviewNdjson(
  review: NormalizedReview,
  ctx: PersistContext,
): RawReviewNdjson {
  const content_hash = contentHash(review.comment_text);
  const review_ts = review.review_ts.toISOString();
  const ingested_at = ctx.ingested_at.toISOString();
  return {
    review_id: makeReviewId({
      marketplace: review.marketplace,
      nativeReviewId: review.native_review_id,
      storeId: review.store_id,
      productId: review.product_id,
      reviewerIdHash: review.reviewer_id_hash,
      contentHash: content_hash,
      reviewTsIso: review_ts,
    }),
    marketplace: review.marketplace,
    native_review_id: review.native_review_id,
    store_id: review.store_id,
    product_id: review.product_id,
    reviewer_id_hash: review.reviewer_id_hash,
    star_rating: review.star_rating,
    comment_text: review.comment_text,
    content_hash,
    review_ts,
    ingested_at,
    crawl_batch_id: ctx.crawl_batch_id,
    pipeline_run_id: ctx.pipeline_run_id,
    source_url_hash: sourceUrlHash(review.source_url_canonical),
    language_hint: review.language_hint,
    has_media: review.has_media,
    raw_payload_hash: review.raw_payload_hash,
    char_length: charLengthCodePoints(review.comment_text),
    updated_at: ingested_at,
  };
}

export function lastWriteWins(rows: Iterable<RawReviewNdjson>): {
  rows: RawReviewNdjson[];
  n_deduped: number;
} {
  const map = new Map<string, RawReviewNdjson>();
  let n_deduped = 0;
  for (const row of rows) {
    if (map.has(row.review_id)) {
      n_deduped += 1;
    }
    map.set(row.review_id, row);
  }
  return { rows: [...map.values()], n_deduped };
}

export function writeReviewsNdjson(
  filePath: string,
  rows: Iterable<RawReviewNdjson>,
): { n_written: number; n_deduped: number } {
  const { rows: unique, n_deduped } = lastWriteWins(rows);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const body =
    unique.length === 0 ? '' : `${unique.map((row) => JSON.stringify(row)).join('\n')}\n`;
  writeFileSync(filePath, body, 'utf8');
  return { n_written: unique.length, n_deduped };
}

export type CrawlManifest = {
  adapter: string;
  input: string | null;
  crawl_batch_id: string;
  pipeline_run_id: string;
  n_read: number;
  n_accepted: number;
  n_rejected: number;
  n_written: number;
  n_deduped: number;
  started_at: string;
  finished_at: string;
};

export function writeManifest(filePath: string, manifest: CrawlManifest): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}
