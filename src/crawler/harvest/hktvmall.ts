// SPDX-License-Identifier: GPL-3.0-only
/**
 * Maps hydrated HKTVmall `div.product-review-wrapper` HTML onto FixtureReviewRaw.
 * Does not change the v1 ingest contract. Not a live crawl adapter.
 */
import { z } from 'zod';
import { FixtureReviewRaw, type FixtureReviewRaw as FixtureReviewRawType } from '../types.js';

export const HKTVMALL_MARKETPLACE_ID = 'hktvmall' as const;

/** HKTVmall review dates are calendar days in Hong Kong (no DST). */
export const HKTVMALL_REVIEW_TZ = '+08:00' as const;

export const HktvmallHarvestContext = z.object({
  store_id: z.string().min(1),
  product_id: z.string().min(1),
  source_url: z.string().url(),
});

export type HktvmallHarvestContext = z.infer<typeof HktvmallHarvestContext>;

/** Fields taken from one `div.product-review-wrapper`. Display names and merchant replies are dropped. */
export const HktvmallWrapperReview = z.object({
  native_review_id: z.string().min(1),
  reviewer_id_raw: z.string().min(1),
  star_rating: z.number().int().min(1).max(5),
  comment_text: z.string().min(1),
  review_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  has_media: z.boolean(),
});

export type HktvmallWrapperReview = z.infer<typeof HktvmallWrapperReview>;

export const HKTVMALL_WRAPPER_FAILURE_REASONS = [
  'missing_review_id',
  'missing_reviewer_id',
  'star_rating',
  'empty_comment',
  'bad_date',
] as const;

export type HktvmallWrapperFailureReason = (typeof HKTVMALL_WRAPPER_FAILURE_REASONS)[number];

export type HktvmallWrapperParseResult =
  | { success: true; data: HktvmallWrapperReview }
  | { success: false; reason: HktvmallWrapperFailureReason };

const WRAPPER_OPEN_RE = /<div\b[^>]*\bproduct-review-wrapper\b[^>]*>/gi;
const FILLED_STAR_CLASS_RE = /<span\b[^>]*class="([^"]*)"[^>]*>/gi;
const REVIEW_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PRODUCT_PATH_RE = /\/s\/([^/?#]+)\/[\s\S]*?\/p\/([^/?#]+)/;
const UI_IMG_RE = /\/_ui\//;

export function hktvmallReviewTs(reviewDate: string): string {
  return `${reviewDate}T00:00:00${HKTVMALL_REVIEW_TZ}`;
}

export function parseHktvmallProductPath(
  url: string,
): { store_id: string; product_id: string } | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }
  const match = PRODUCT_PATH_RE.exec(pathname);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return { store_id: match[1], product_id: match[2] };
}

export function hktvmallWrapperToFixtureReviewRaw(
  review: HktvmallWrapperReview,
  ctx: HktvmallHarvestContext,
): FixtureReviewRawType {
  return FixtureReviewRaw.parse({
    marketplace: HKTVMALL_MARKETPLACE_ID,
    native_review_id: review.native_review_id,
    store_id: ctx.store_id,
    product_id: ctx.product_id,
    reviewer_id_raw: review.reviewer_id_raw,
    star_rating: review.star_rating,
    comment_text: review.comment_text,
    review_ts: hktvmallReviewTs(review.review_date),
    source_url: ctx.source_url,
    has_media: review.has_media,
  });
}

export function extractHktvmallReviewWrappers(html: string): string[] {
  const wrappers: string[] = [];
  WRAPPER_OPEN_RE.lastIndex = 0;
  let match = WRAPPER_OPEN_RE.exec(html);
  while (match !== null) {
    const sliced = sliceBalancedDiv(html, match.index);
    if (sliced !== null) {
      wrappers.push(sliced);
    }
    match = WRAPPER_OPEN_RE.exec(html);
  }
  return wrappers;
}

export function parseHktvmallReviewWrapper(wrapperHtml: string): HktvmallWrapperParseResult {
  const open = wrapperHtml.match(/^<div\b[^>]*>/i)?.[0];
  const native_review_id = open === undefined ? null : attrValue(open, 'data-reviewid');
  if (native_review_id === null || native_review_id.length === 0) {
    return { success: false, reason: 'missing_review_id' };
  }

  const reviewer_id_raw = attrValue(wrapperHtml, 'data-user');
  if (reviewer_id_raw === null || reviewer_id_raw.length === 0) {
    return { success: false, reason: 'missing_reviewer_id' };
  }

  const ratingHtml = innerByClass(wrapperHtml, 'product-review-rating');
  const star_rating = countFilledStars(ratingHtml ?? '');
  if (star_rating < 1 || star_rating > 5) {
    return { success: false, reason: 'star_rating' };
  }

  const titleHtml = innerByClass(wrapperHtml, 'review-title');
  const comment_text = decodeBasicEntities(stripTags(titleHtml ?? '')).replace(/\s+/g, ' ').trim();
  if (comment_text.length === 0) {
    return { success: false, reason: 'empty_comment' };
  }

  const dateRaw = decodeBasicEntities(
    stripTags(firstByClass(wrapperHtml, 'review-date') ?? ''),
  ).trim();
  if (!REVIEW_DATE_RE.test(dateRaw)) {
    return { success: false, reason: 'bad_date' };
  }

  return {
    success: true,
    data: {
      native_review_id,
      reviewer_id_raw,
      star_rating,
      comment_text,
      review_date: dateRaw,
      has_media: contentHasMedia(wrapperHtml),
    },
  };
}

export function parseHktvmallReviewPage(
  html: string,
  ctx: HktvmallHarvestContext,
): {
  accepted: FixtureReviewRawType[];
  rejected: { reason: HktvmallWrapperFailureReason }[];
} {
  const context = HktvmallHarvestContext.parse(ctx);
  const accepted: FixtureReviewRawType[] = [];
  const rejected: { reason: HktvmallWrapperFailureReason }[] = [];
  for (const wrapper of extractHktvmallReviewWrappers(html)) {
    const parsed = parseHktvmallReviewWrapper(wrapper);
    if (!parsed.success) {
      rejected.push({ reason: parsed.reason });
      continue;
    }
    accepted.push(hktvmallWrapperToFixtureReviewRaw(parsed.data, context));
  }
  return { accepted, rejected };
}

function sliceBalancedDiv(html: string, start: number): string | null {
  return sliceBalancedTag(html, start, 'div');
}

function sliceBalancedTag(html: string, start: number, tag: string): string | null {
  const openRe = new RegExp(`^<${tag}\\b[^>]*>`, 'i');
  const open = openRe.exec(html.slice(start));
  if (open === null || open[0] === undefined) {
    return null;
  }
  const tokenRe = new RegExp(`</?${tag}\\b[^>]*>`, 'gi');
  tokenRe.lastIndex = start + open[0].length;
  let depth = 1;
  let token = tokenRe.exec(html);
  while (token !== null) {
    const raw = token[0];
    if (/^<\//.test(raw)) {
      depth -= 1;
    } else if (!raw.endsWith('/>')) {
      depth += 1;
    }
    if (depth === 0) {
      return html.slice(start, token.index + raw.length);
    }
    token = tokenRe.exec(html);
  }
  return null;
}

function attrValue(html: string, name: string): string | null {
  const re = new RegExp(`\\b${name}="([^"]*)"`, 'i');
  const match = re.exec(html);
  return match?.[1] ?? null;
}

function innerByClass(html: string, className: string): string | null {
  const openRe = new RegExp(
    `<(div|span)\\b[^>]*\\bclass="[^"]*\\b${className}\\b[^"]*"[^>]*>`,
    'i',
  );
  const open = openRe.exec(html);
  if (open === null || open[1] === undefined) {
    return null;
  }
  const sliced = sliceBalancedTag(html, open.index, open[1]);
  if (sliced === null) {
    return null;
  }
  const closeRe = new RegExp(`</${open[1]}\\b[^>]*>\\s*$`, 'i');
  const close = closeRe.exec(sliced);
  if (close === null) {
    return null;
  }
  return sliced.slice(open[0].length, close.index);
}

function firstByClass(html: string, className: string): string | null {
  return innerByClass(html, className);
}

function countFilledStars(html: string): number {
  FILLED_STAR_CLASS_RE.lastIndex = 0;
  let count = 0;
  let match = FILLED_STAR_CLASS_RE.exec(html);
  while (match !== null) {
    const tokens = (match[1] ?? '').split(/\s+/);
    if (tokens.includes('star') && !tokens.includes('empty-star')) {
      count += 1;
    }
    match = FILLED_STAR_CLASS_RE.exec(html);
  }
  return count;
}

function contentHasMedia(wrapperHtml: string): boolean {
  const content = innerByClass(wrapperHtml, 'product-review-content');
  if (content === null) {
    return false;
  }
  const srcs = [...content.matchAll(/<img\b[^>]*src="([^"]+)"/gi)].map((m) => m[1] ?? '');
  return srcs.some((src) => src.length > 0 && !UI_IMG_RE.test(src));
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_whole, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_whole, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}
