// SPDX-License-Identifier: GPL-3.0-only

export const HKTVMALL_PAGE_TOTAL_RE = /共\s*(\d+)\s*頁/;
export const HKTVMALL_DECLARED_REVIEWS_RE = /(\d+)\s*則評論/;

const COMMENT_COUNT_RE =
  /<span\b[^>]*\bclass="[^"]*\bcomment__count\b[^"]*"[^>]*>\s*(\d+)\s*</i;
const TOTAL_SPAN_RE =
  /<span\b[^>]*\bclass="[^"]*\btotal\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;

function parseNonNegativeIntCapture(match: RegExpExecArray | null): number | null {
  const raw = match?.[1];
  if (raw === undefined) {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Text may contain both the review pager (共39頁) and Q&A (共1頁); take the max. */
export function maxPageTotalFromText(text: string): number | null {
  const re = /共\s*(\d+)\s*頁/g;
  let max: number | null = null;
  for (const match of text.matchAll(re)) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const n = Number(raw);
    if (Number.isFinite(n) && (max === null || n > max)) {
      max = n;
    }
  }
  return max;
}

export function parseHktvmallDeclaredReviewCount(html: string): number | null {
  const fromCount = parseNonNegativeIntCapture(COMMENT_COUNT_RE.exec(html));
  if (fromCount !== null) {
    return fromCount;
  }
  const text = html.replace(/<[^>]+>/g, ' ');
  return parseNonNegativeIntCapture(HKTVMALL_DECLARED_REVIEWS_RE.exec(text));
}

export function parseHktvmallReviewPageTotal(html: string): number | null {
  TOTAL_SPAN_RE.lastIndex = 0;
  let max: number | null = null;
  let span = TOTAL_SPAN_RE.exec(html);
  while (span !== null) {
    const inner = span[1] ?? '';
    const fromSpan = parseNonNegativeIntCapture(HKTVMALL_PAGE_TOTAL_RE.exec(inner));
    if (fromSpan !== null && (max === null || fromSpan > max)) {
      max = fromSpan;
    }
    span = TOTAL_SPAN_RE.exec(html);
  }
  if (max !== null) {
    return max;
  }
  return maxPageTotalFromText(html.replace(/<[^>]+>/g, ' '));
}
