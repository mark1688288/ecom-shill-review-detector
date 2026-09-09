// SPDX-License-Identifier: GPL-3.0-only
import {
  HarvestEmptyAcceptedError,
  HarvestSessionDroppedError,
  ReviewTabNotFoundError,
  UnhydratedReviewPageError,
} from './errors.js';
import type { HarvestLocator, HarvestPage, HarvestResult, HarvestStoppedReason } from './harvest-page.js';
import type { FixtureReviewRaw } from '../types.js';
import type { HktvmallHarvestContext, HktvmallWrapperFailureReason } from './hktvmall.js';
import { parseHktvmallReviewPage } from './hktvmall.js';
import {
  parseHktvmallDeclaredReviewCount,
  parseHktvmallReviewPageTotal,
} from './hktvmall-pager-html.js';
import { assertHktvmallPublicProductUrl } from './url-list.js';

export {
  HKTVMALL_DECLARED_REVIEWS_RE,
  HKTVMALL_PAGE_TOTAL_RE,
  maxPageTotalFromText,
} from './hktvmall-pager-html.js';

export const HKTVMALL_REVIEW_TAB_CSS = [
  '[data-tab="reviewTab"]',
  'li[data-tab="reviewTab"]',
] as const;

export const DEFAULT_GOTO_TIMEOUT_MS = 120_000;
export const DEFAULT_WRAPPER_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_PAGES = 20;
export const WAIT_NEW_REVIEW_IDS_MS = 15_000;
export const SETTLE_PARSE_TIMEOUT_MS = WAIT_NEW_REVIEW_IDS_MS;
export const SETTLE_PARSE_POLL_MS = 400;
export const HKTVMALL_REVIEWS_PER_PAGE = 10;
export const HARVEST_VIEWPORT = { width: 1280, height: 720 } as const;

export type HarvestDriverOpts = {
  gotoTimeoutMs?: number;
  wrapperTimeoutMs?: number;
  maxPages?: number;
  maxReviews?: number;
  settleParseTimeoutMs?: number;
  settleParsePollMs?: number;
};

type ParsedPage = {
  accepted: FixtureReviewRaw[];
  rejected: { reason: HktvmallWrapperFailureReason }[];
};

export function declaredReviewPageFloor(nDeclaredReviews: number | null): number | null {
  if (nDeclaredReviews !== null && nDeclaredReviews >= 1) {
    return Math.ceil(nDeclaredReviews / HKTVMALL_REVIEWS_PER_PAGE);
  }
  return null;
}

/** Captured pager smaller than declared implies. Driver must not `end` on this. */
export function isUnderstatedPageTotal(
  pageTotal: number | null,
  nDeclaredReviews: number | null,
): boolean {
  const floor = declaredReviewPageFloor(nDeclaredReviews);
  return pageTotal !== null && pageTotal >= 1 && floor !== null && pageTotal < floor;
}

export function expectedHktvmallReviewPageCount(
  pageTotal: number | null,
  nDeclaredReviews: number | null,
): number | null {
  const fromPager = pageTotal !== null && pageTotal >= 1 ? pageTotal : null;
  const fromDeclared = declaredReviewPageFloor(nDeclaredReviews);
  if (fromPager !== null && fromDeclared !== null) {
    return Math.max(fromPager, fromDeclared);
  }
  return fromPager ?? fromDeclared;
}

export function isHarvestCompletenessFailure(result: HarvestResult): boolean {
  if (result.stopped_reason === 'max_pages' || result.stopped_reason === 'max_reviews') {
    return false;
  }
  const expected = expectedHktvmallReviewPageCount(result.page_total, result.n_declared_reviews);
  if (expected === null) {
    return false;
  }
  if (result.n_pages >= expected) {
    return false;
  }
  return (
    result.stopped_reason === 'end' ||
    result.stopped_reason === 'unchanged_ids' ||
    result.stopped_reason === 'next_disabled'
  );
}

export async function clickReviewTab(page: HarvestPage, timeoutMs: number): Promise<void> {
  const candidates: HarvestLocator[] = [
    page.locator('[data-tab="reviewTab"]'),
    page.locator('li[data-tab="reviewTab"]'),
    page.getByRole('heading', { name: '評論' }),
  ];
  for (const loc of candidates) {
    try {
      await loc.visible().first().click({ timeout: timeoutMs, force: true });
      return;
    } catch (err) {
      if (err instanceof HarvestSessionDroppedError) {
        throw err;
      }
      continue;
    }
  }
  throw new ReviewTabNotFoundError();
}

export async function locateNextPage(page: HarvestPage): Promise<HarvestLocator | null> {
  const candidates: HarvestLocator[] = [
    page.getByRole('link', { name: '下一頁' }),
    page.getByRole('button', { name: '下一頁' }),
    page.getByText('下一頁', { exact: true }),
  ];
  for (const loc of candidates) {
    if ((await loc.visible().count()) > 0) {
      return loc.visible().first();
    }
  }
  return null;
}

export async function isNextDisabled(loc: HarvestLocator): Promise<boolean> {
  const aria = await loc.getAttribute('aria-disabled');
  if (aria === 'true') {
    return true;
  }
  if ((await loc.getAttribute('disabled')) !== null) {
    return true;
  }
  const cls = (await loc.getAttribute('class')) ?? '';
  return /\bdisabled\b/i.test(cls);
}

function hasNewNativeReviewId(parsedPage: ParsedPage, byId: Map<string, FixtureReviewRaw>): boolean {
  return parsedPage.accepted.some((row) => {
    const id = row.native_review_id;
    return id !== null && id.length > 0 && !byId.has(id);
  });
}

function commitPage(
  parsedPage: ParsedPage,
  byId: Map<string, FixtureReviewRaw>,
  rejected: { reason: HktvmallWrapperFailureReason }[],
): { n_wrappers_delta: number } {
  const n_wrappers_delta = parsedPage.accepted.length + parsedPage.rejected.length;
  rejected.push(...parsedPage.rejected);
  for (const row of parsedPage.accepted) {
    const id = row.native_review_id;
    if (id !== null && id.length > 0) {
      byId.set(id, row);
    }
  }
  return { n_wrappers_delta };
}

async function sleepPoll(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function harvestHktvmallProductPage(
  page: HarvestPage,
  url: string,
  opts: HarvestDriverOpts = {},
): Promise<HarvestResult> {
  const gotoTimeoutMs = opts.gotoTimeoutMs ?? DEFAULT_GOTO_TIMEOUT_MS;
  const wrapperTimeoutMs = opts.wrapperTimeoutMs ?? DEFAULT_WRAPPER_TIMEOUT_MS;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxReviews = opts.maxReviews;
  const settleParseTimeoutMs = opts.settleParseTimeoutMs ?? SETTLE_PARSE_TIMEOUT_MS;
  const settleParsePollMs = opts.settleParsePollMs ?? SETTLE_PARSE_POLL_MS;
  const parsed = assertHktvmallPublicProductUrl(url);
  const ctx: HktvmallHarvestContext = {
    store_id: parsed.store_id,
    product_id: parsed.product_id,
    source_url: parsed.source_url,
  };

  const started = Date.now();
  await page.setViewportSize(HARVEST_VIEWPORT);

  const gotoStarted = Date.now();
  await page.goto(url, { timeout: gotoTimeoutMs, waitUntil: 'domcontentloaded' });
  const latency_ms_goto = Date.now() - gotoStarted;

  const clickStarted = Date.now();
  await clickReviewTab(page, wrapperTimeoutMs);
  const latency_ms_click = Date.now() - clickStarted;

  try {
    await page.waitForSelector('div.product-review-wrapper', { timeout: wrapperTimeoutMs });
  } catch (err) {
    if (err instanceof HarvestSessionDroppedError) {
      throw err;
    }
    throw new UnhydratedReviewPageError(wrapperTimeoutMs);
  }

  const byId = new Map<string, FixtureReviewRaw>();
  const rejected: { reason: HktvmallWrapperFailureReason }[] = [];
  let n_pages = 0;
  let n_wrappers = 0;
  let stopped_reason: HarvestStoppedReason | null = null;

  const page1Deadline = Date.now() + settleParseTimeoutMs;
  let html = '';
  let parsedPage: ParsedPage = { accepted: [], rejected: [] };
  do {
    html = await page.content();
    parsedPage = parseHktvmallReviewPage(html, ctx);
    if (parsedPage.accepted.length + parsedPage.rejected.length > 0) {
      break;
    }
    await sleepPoll(settleParsePollMs);
  } while (Date.now() < page1Deadline);

  if (parsedPage.accepted.length + parsedPage.rejected.length === 0) {
    throw new UnhydratedReviewPageError(wrapperTimeoutMs);
  }

  n_wrappers += commitPage(parsedPage, byId, rejected).n_wrappers_delta;
  n_pages = 1;
  const page_total = parseHktvmallReviewPageTotal(html);
  const n_declared_reviews = parseHktvmallDeclaredReviewCount(html);

  const considerStopAfterCommit = (): void => {
    if (maxReviews !== undefined && byId.size >= maxReviews) {
      stopped_reason = 'max_reviews';
      return;
    }
    if (n_pages >= maxPages) {
      stopped_reason = 'max_pages';
      return;
    }
    if (
      page_total !== null &&
      page_total >= 1 &&
      n_pages >= page_total &&
      !isUnderstatedPageTotal(page_total, n_declared_reviews)
    ) {
      stopped_reason = 'end';
    }
  };

  considerStopAfterCommit();

  while (stopped_reason === null) {
    const next = await locateNextPage(page);
    if (next === null || (await isNextDisabled(next))) {
      stopped_reason = 'next_disabled';
      break;
    }

    const prevIds = [...byId.keys()];
    await next.click({ force: true });
    const gotNew = await page.waitForNewReviewIds(prevIds, WAIT_NEW_REVIEW_IDS_MS);
    if (!gotNew) {
      stopped_reason = 'unchanged_ids';
      break;
    }

    const settleDeadline = Date.now() + settleParseTimeoutMs;
    let committed = false;
    while (Date.now() < settleDeadline) {
      html = await page.content();
      parsedPage = parseHktvmallReviewPage(html, ctx);
      if (hasNewNativeReviewId(parsedPage, byId)) {
        n_wrappers += commitPage(parsedPage, byId, rejected).n_wrappers_delta;
        n_pages += 1;
        committed = true;
        break;
      }
      await sleepPoll(settleParsePollMs);
    }
    if (!committed) {
      stopped_reason = 'unchanged_ids';
      break;
    }
    considerStopAfterCommit();
  }

  if (stopped_reason === null) {
    throw new Error('harvestHktvmallProductPage exited pagination without stopped_reason');
  }

  if (n_wrappers === 0) {
    throw new UnhydratedReviewPageError(wrapperTimeoutMs);
  }
  if (byId.size === 0) {
    throw new HarvestEmptyAcceptedError();
  }

  let accepted = [...byId.values()];
  if (maxReviews !== undefined && accepted.length > maxReviews) {
    accepted = accepted.slice(0, maxReviews);
  }

  return {
    url,
    store_id: parsed.store_id,
    product_id: parsed.product_id,
    accepted,
    rejected,
    n_pages,
    n_wrappers,
    n_declared_reviews,
    page_total,
    latency_ms_goto,
    latency_ms_click,
    latency_ms_total: Date.now() - started,
    stopped_reason,
  };
}
