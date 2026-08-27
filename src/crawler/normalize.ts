// SPDX-License-Identifier: GPL-3.0-only
import { sha256Hex, stripTrackingQueryParams } from '../shared/ids.js';
import type { LanguageHint } from '../shared/types.js';
import type { NormalizedReview } from './adapter.js';
import { hashReviewerId, normalizeCommentText } from './hash.js';
import type { FixtureReviewRaw } from './types.js';

const YUE_PARTICLES = /嘅|喺|唔|咗|係/;
const HAN = /\p{Script=Han}/u;
const LATIN = /[A-Za-z]/;

/** Aligns with BigQuery CHAR_LENGTH: Unicode code points, not UTF-16 units. */
export function charLengthCodePoints(s: string): number {
  return Array.from(s).length;
}

/**
 * v1 heuristic when fixture omits language_hint:
 * particles → yue; both Han and Latin → mixed; Han only → zh-Hant; Latin only → en; else unknown.
 */
export function inferLanguageHint(text: string): LanguageHint {
  if (YUE_PARTICLES.test(text)) {
    return 'yue';
  }
  let han = 0;
  let latin = 0;
  for (const ch of text) {
    if (HAN.test(ch)) {
      han += 1;
    } else if (LATIN.test(ch)) {
      latin += 1;
    }
  }
  if (han > 0 && latin > 0) {
    return 'mixed';
  }
  if (han > 0) {
    return 'zh-Hant';
  }
  if (latin > 0) {
    return 'en';
  }
  return 'unknown';
}

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  'reviewer_id_raw',
  'cookie',
  'Cookie',
  'authorization',
  'Authorization',
]);

/** SHA-256 of fixture fields minus reviewer_id_raw and any cookie / Authorization keys. */
export function hashSanitizedRawPayload(raw: FixtureReviewRaw): string {
  const sanitized: Record<string, unknown> = {
    marketplace: raw.marketplace,
    native_review_id: raw.native_review_id,
    store_id: raw.store_id,
    product_id: raw.product_id,
    star_rating: raw.star_rating,
    comment_text: raw.comment_text,
    review_ts: raw.review_ts,
    source_url: raw.source_url,
    has_media: raw.has_media,
  };
  if (raw.language_hint !== undefined) {
    sanitized['language_hint'] = raw.language_hint;
  }
  for (const key of FORBIDDEN_PAYLOAD_KEYS) {
    delete sanitized[key];
  }
  return sha256Hex(JSON.stringify(sanitized));
}

export function canonicalizeSourceUrl(sourceUrl: string | null): string | null {
  if (sourceUrl === null) {
    return null;
  }
  return stripTrackingQueryParams(sourceUrl);
}

export function normalizeFixtureReview(raw: FixtureReviewRaw, salt: string): NormalizedReview {
  const comment_text = normalizeCommentText(raw.comment_text);
  const language_hint = raw.language_hint ?? inferLanguageHint(comment_text);
  return {
    marketplace: raw.marketplace,
    native_review_id: raw.native_review_id,
    store_id: raw.store_id,
    product_id: raw.product_id,
    reviewer_id_hash: hashReviewerId(raw.reviewer_id_raw, salt),
    star_rating: raw.star_rating,
    comment_text,
    review_ts: new Date(raw.review_ts),
    source_url_canonical: canonicalizeSourceUrl(raw.source_url),
    language_hint,
    has_media: raw.has_media,
    raw_payload_hash: hashSanitizedRawPayload(raw),
  };
}
