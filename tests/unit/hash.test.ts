// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  contentHash,
  hashReviewerId,
  makeReviewId,
  normalizeCommentText,
  sourceUrlHash,
} from '../../src/crawler/hash.js';
import {
  hmacSha256Hex,
  isSha256Hex,
  REVIEW_ID_VERSION,
  sha256Hex,
  SHA256_HEX_LENGTH,
  stripTrackingQueryParams,
} from '../../src/shared/ids.js';

/** 32-hex test salt (same length as CI dummy). Not a production secret. */
const SALT = '0123456789abcdef0123456789abcdef';
const OTHER_SALT = 'ffffffffffffffff';

const HEX_USER_AAA =
  '7186a7a716d4545e02ff7b27d3f82e29da57517e9f3a09064338279a058d9b8b';
const HEX_NATIVE_N001 =
  '4aed90c7f56d713fd3e39e100f696ad0bbefd64be74c42a6134da3208129017d';
const HEX_CONTENT_NFC =
  '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c';
const HEX_URL_KEEP =
  '473a34d148143d8c2e90528b553c77998e889cdd00d151452bb7224d7b6159b7';

function syntheticInput(overrides: Partial<Parameters<typeof makeReviewId>[0]> = {}) {
  return {
    marketplace: 'fixture',
    nativeReviewId: null as string | null,
    storeId: 'store_a',
    productId: 'prod_shampoo',
    reviewerIdHash: 'aa'.repeat(32),
    contentHash: 'bb'.repeat(32),
    reviewTsIso: '2026-01-15T00:30:00.000Z',
    ...overrides,
  };
}

describe('ids primitives', () => {
  it('sha256Hex is lowercase 64-char hex', () => {
    const digest = sha256Hex('v1|fixture|n001');
    expect(digest).toBe(HEX_NATIVE_N001);
    expect(digest).toHaveLength(SHA256_HEX_LENGTH);
    expect(isSha256Hex(digest)).toBe(true);
  });

  it('hmacSha256Hex matches HMAC-SHA256(salt, raw)', () => {
    expect(hmacSha256Hex(SALT, 'user-aaa')).toBe(HEX_USER_AAA);
  });

  it('REVIEW_ID_VERSION is v1', () => {
    expect(REVIEW_ID_VERSION).toBe('v1');
  });
});

describe('hashReviewerId', () => {
  it('returns a frozen HMAC vector for the test salt', () => {
    expect(hashReviewerId('user-aaa', SALT)).toBe(HEX_USER_AAA);
    expect(isSha256Hex(hashReviewerId('user-aaa', SALT))).toBe(true);
  });

  it('changes when the salt changes', () => {
    expect(hashReviewerId('user-aaa', OTHER_SALT)).not.toBe(HEX_USER_AAA);
  });

  it('rejects a missing, empty, or short salt (never HMAC with "")', () => {
    expect(() => hashReviewerId('user-aaa', '')).toThrow(/REVIEWER_ID_SALT/);
    expect(() => hashReviewerId('user-aaa', 'short-salt')).toThrow(/REVIEWER_ID_SALT/);
  });

  it('rejects an empty raw reviewer id', () => {
    expect(() => hashReviewerId('', SALT)).toThrow(/empty/);
  });
});

describe('contentHash', () => {
  it('NFC-normalizes so composed and decomposed é match', () => {
    expect(contentHash('\u00e9')).toBe(contentHash('e\u0301'));
    expect(contentHash('\u00e9')).toBe(HEX_CONTENT_NFC);
  });

  it('collapses whitespace before hashing', () => {
    expect(normalizeCommentText('  a\n\tb  ')).toBe('a b');
    expect(contentHash('  a\n\tb  ')).toBe(contentHash('a b'));
    expect(contentHash('  a\n\tb  ')).not.toBe(contentHash('a b c'));
  });

  it('detects a rewrite of the same comment', () => {
    const original = contentHash('用咗兩個禮拜，暗瘡真係少咗');
    const edited = contentHash('用咗兩個禮拜，暗瘡真係少咗，再補一句。');
    expect(original).not.toBe(edited);
    expect(isSha256Hex(original)).toBe(true);
  });
});

describe('sourceUrlHash', () => {
  it('returns null when the url is null', () => {
    expect(sourceUrlHash(null)).toBeNull();
  });

  it('strips tracking query params and fragments so equivalent landings share a hash', () => {
    const tracked =
      'https://example.com/reviews/n001?utm_source=ad&utm_medium=cpc&fbclid=abc&keep=1';
    const clean = 'https://example.com/reviews/n001?keep=1';
    const withHash = 'https://example.com/reviews/n001?keep=1#section';
    expect(stripTrackingQueryParams(tracked)).toBe(clean);
    expect(sourceUrlHash(tracked)).toBe(sourceUrlHash(clean));
    expect(sourceUrlHash(withHash)).toBe(sourceUrlHash(clean));
    expect(sourceUrlHash(tracked)).toBe(HEX_URL_KEEP);
  });

  it('keeps non-tracking query params', () => {
    expect(stripTrackingQueryParams('https://example.com/reviews/n001?keep=1&utm_campaign=x')).toBe(
      'https://example.com/reviews/n001?keep=1',
    );
  });

  it('throws on an invalid URL', () => {
    expect(() => sourceUrlHash('not a url')).toThrow(/Invalid URL/);
  });
});

describe('makeReviewId', () => {
  it('with a native id is sha256(v1|marketplace|nativeReviewId) and ignores body fields', () => {
    const original = makeReviewId(
      syntheticInput({
        nativeReviewId: 'n001',
        contentHash: '11'.repeat(32),
        storeId: 'store_a',
        reviewTsIso: '2026-01-15T00:30:00.000Z',
      }),
    );
    const rewritten = makeReviewId(
      syntheticInput({
        nativeReviewId: 'n001',
        contentHash: '22'.repeat(32),
        storeId: 'store_other',
        productId: 'prod_other',
        reviewerIdHash: 'cc'.repeat(32),
        reviewTsIso: '2026-02-01T00:00:00.000Z',
      }),
    );
    expect(original).toBe(HEX_NATIVE_N001);
    expect(rewritten).toBe(original);
    expect(contentHash('old body')).not.toBe(contentHash('new body'));
  });

  it('without a native id includes content_hash so a rewrite is a new row', () => {
    const first = makeReviewId(syntheticInput({ nativeReviewId: null, contentHash: '11'.repeat(32) }));
    const second = makeReviewId(
      syntheticInput({ nativeReviewId: null, contentHash: '22'.repeat(32) }),
    );
    expect(first).not.toBe(second);
    expect(isSha256Hex(first)).toBe(true);
  });

  it('treats empty nativeReviewId as absent', () => {
    const emptyNative = makeReviewId(syntheticInput({ nativeReviewId: '', contentHash: '11'.repeat(32) }));
    const noNative = makeReviewId(syntheticInput({ nativeReviewId: null, contentHash: '11'.repeat(32) }));
    expect(emptyNative).toBe(noNative);
  });

  it('scopes native ids by marketplace', () => {
    const fixture = makeReviewId(syntheticInput({ nativeReviewId: 'n001', marketplace: 'fixture' }));
    const other = makeReviewId(syntheticInput({ nativeReviewId: 'n001', marketplace: 'other' }));
    expect(fixture).not.toBe(other);
  });
});
