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
import { assertHktvmallPublicProductUrl } from './url-list.js';

export const HKTVMALL_REVIEW_TAB_CSS = [
  '[data-tab="reviewTab"]',
  'li[data-tab="reviewTab"]',
] as const;

export const HKTVMALL_PAGE_TOTAL_RE = /共\s*(\d+)\s*頁/;
export const HKTVMALL_DECLARED_REVIEWS_RE = /(\d+)\s*則評論/;

export const DEFAULT_GOTO_TIMEOUT_MS = 120_000;
export const DEFAULT_WRAPPER_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_PAGES = 20;
export const WAIT_NEW_REVIEW_IDS_MS = 15_000;
export const HARVEST_VIEWPORT = { width: 1280, height: 720 } as const;

export type HarvestDriverOpts = {
  gotoTimeoutMs?: number;
  wrapperTimeoutMs?: number;
  maxPages?: number;
  maxReviews?: number;
};

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

function parsePositiveCapture(match: RegExpExecArray | null): number | null {
  const raw = match?.[1];
  if (raw === undefined) {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Body innerText may contain both the review pager (共39頁) and Q&A (共1頁). */
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

export async function harvestHktvmallProductPage(
  page: HarvestPage,
  url: string,
  opts: HarvestDriverOpts = {},
): Promise<HarvestResult> {
  const gotoTimeoutMs = opts.gotoTimeoutMs ?? DEFAULT_GOTO_TIMEOUT_MS;
  const wrapperTimeoutMs = opts.wrapperTimeoutMs ?? DEFAULT_WRAPPER_TIMEOUT_MS;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxReviews = opts.maxReviews;
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
  let n_declared_reviews: number | null = null;
  let stopped_reason: HarvestStoppedReason = 'end';

  for (;;) {
    const html = await page.content();
    const parsedPage = parseHktvmallReviewPage(html, ctx);
    n_wrappers += parsedPage.accepted.length + parsedPage.rejected.length;
    rejected.push(...parsedPage.rejected);
    for (const row of parsedPage.accepted) {
      const id = row.native_review_id;
      if (id !== null && id.length > 0) {
        byId.set(id, row);
      }
    }
    n_pages += 1;

    if (n_pages === 1 && n_wrappers === 0) {
      throw new UnhydratedReviewPageError(wrapperTimeoutMs);
    }

    if (maxReviews !== undefined && byId.size >= maxReviews) {
      stopped_reason = 'max_reviews';
      break;
    }
    if (n_pages >= maxPages) {
      stopped_reason = 'max_pages';
      break;
    }

    const bodyText = await page.innerText('body');
    if (n_declared_reviews === null) {
      n_declared_reviews = parsePositiveCapture(HKTVMALL_DECLARED_REVIEWS_RE.exec(bodyText));
    }
    const pageTotal = maxPageTotalFromText(bodyText);
    if (pageTotal !== null && n_pages >= pageTotal) {
      stopped_reason = 'end';
      break;
    }

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
    latency_ms_goto,
    latency_ms_click,
    latency_ms_total: Date.now() - started,
    stopped_reason,
  };
}
