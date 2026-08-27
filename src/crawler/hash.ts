// SPDX-License-Identifier: GPL-3.0-only
// Hex lowercase SHA-256 / HMAC-SHA256. REVIEWER_ID_SALT is an argument — never read
// from process.env here, never written to git or BigQuery.
import { assertSalt } from '../shared/env.js';
import {
  hmacSha256Hex,
  REVIEW_ID_VERSION,
  sha256Hex,
  stripTrackingQueryParams,
} from '../shared/ids.js';

export type MakeReviewIdInput = {
  marketplace: string;
  nativeReviewId: string | null;
  storeId: string;
  productId: string;
  reviewerIdHash: string;
  contentHash: string;
  reviewTsIso: string;
};

export function hashReviewerId(raw: string, salt: string): string {
  const checked = assertSalt(salt);
  if (raw.length === 0) {
    throw new Error('hashReviewerId: raw reviewer id must not be empty');
  }
  return hmacSha256Hex(checked, raw);
}

/** NFC + collapse Unicode whitespace. Shared by content_hash so rewrite detection is stable. */
export function normalizeCommentText(commentText: string): string {
  return commentText.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function contentHash(commentText: string): string {
  return sha256Hex(normalizeCommentText(commentText));
}

export function sourceUrlHash(canonicalUrl: string | null): string | null {
  if (canonicalUrl === null) {
    return null;
  }
  return sha256Hex(stripTrackingQueryParams(canonicalUrl));
}

/**
 * Stable row key for `raw_reviews`.
 * Native marketplace id present → identity ignores body (rewrites keep the same row).
 * Otherwise the key includes content_hash (and store/product/reviewer/ts).
 */
export function makeReviewId(input: MakeReviewIdInput): string {
  if (input.nativeReviewId !== null && input.nativeReviewId.length > 0) {
    return sha256Hex(
      `${REVIEW_ID_VERSION}|${input.marketplace}|${input.nativeReviewId}`,
    );
  }
  return sha256Hex(
    `${REVIEW_ID_VERSION}|${input.marketplace}|${input.storeId}|${input.productId}|${input.reviewerIdHash}|${input.contentHash}|${input.reviewTsIso}`,
  );
}
