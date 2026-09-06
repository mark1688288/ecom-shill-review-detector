// SPDX-License-Identifier: GPL-3.0-only
import { HKTVMALL_DECLARED_REVIEWS_RE, HKTVMALL_PAGE_TOTAL_RE } from './hktvmall-driver.js';

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
  let span = TOTAL_SPAN_RE.exec(html);
  while (span !== null) {
    const inner = span[1] ?? '';
    const fromSpan = parseNonNegativeIntCapture(HKTVMALL_PAGE_TOTAL_RE.exec(inner));
    if (fromSpan !== null) {
      return fromSpan;
    }
    span = TOTAL_SPAN_RE.exec(html);
  }
  return parseNonNegativeIntCapture(HKTVMALL_PAGE_TOTAL_RE.exec(html));
}
