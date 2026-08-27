// SPDX-License-Identifier: GPL-3.0-only
import { createHash, createHmac } from 'node:crypto';

/** Prefix baked into `review_id` material. Bumping this is a new identity epoch. */
export const REVIEW_ID_VERSION = 'v1';

export const SHA256_HEX_LENGTH = 64;

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Query keys treated as tracking noise when hashing `source_url`.
 * Any key that lowercases to one of these, or starts with `utm_`, is stripped.
 * Not a marketplace-specific list.
 */
export const TRACKING_QUERY_KEYS = new Set([
  'gclid',
  'gbraid',
  'wbraid',
  'dclid',
  'fbclid',
  'msclkid',
  'twclid',
  'ttclid',
  'li_fat_id',
  'mc_cid',
  'mc_eid',
  'igshid',
  'yclid',
  'ysclid',
  '_ga',
  '_gl',
  '_gac',
  '_gid',
]);

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacSha256Hex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

export function isTrackingQueryKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_QUERY_KEYS.has(lower);
}

/** Drop fragment and known tracking query params. Host/path/other query stay as `URL` parsed them. */
export function stripTrackingQueryParams(urlString: string): string {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new TypeError(`Invalid URL for source_url_hash: ${urlString}`);
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (isTrackingQueryKey(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}
