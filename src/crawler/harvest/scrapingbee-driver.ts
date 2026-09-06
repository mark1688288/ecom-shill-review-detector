// SPDX-License-Identifier: GPL-3.0-only
import {
  HarvestEmptyAcceptedError,
  UnhydratedReviewPageError,
} from './errors.js';
import type { HarvestResult, HarvestStoppedReason } from './harvest-page.js';
import type { FixtureReviewRaw } from '../types.js';
import type { HktvmallHarvestContext, HktvmallWrapperFailureReason } from './hktvmall.js';
import { parseHktvmallReviewPage } from './hktvmall.js';
import {
  parseHktvmallDeclaredReviewCount,
  parseHktvmallReviewPageTotal,
} from './hktvmall-pager-html.js';
import { DEFAULT_MAX_PAGES } from './hktvmall-driver.js';
import { SCRAPINGBEE_PAGER_WAIT_MS } from './scrapingbee-js-scenario.js';
import { assertHktvmallPublicProductUrl } from './url-list.js';

export type ScrapingBeeFetchPage = (pageIndex: number) => Promise<{
  html: string;
  credits: number | null;
  latency_ms: number;
}>;

export type ScrapingBeeDriverOpts = {
  fetchPage: ScrapingBeeFetchPage;
  maxPages?: number;
  maxReviews?: number;
  wrapperTimeoutMs?: number;
};

export type ScrapingBeeHarvestResult = HarvestResult & {
  n_http_requests: number;
  scrapingbee_credits: number | null;
};

type ParsedPage = {
  accepted: FixtureReviewRaw[];
  rejected: { reason: HktvmallWrapperFailureReason }[];
};

export async function harvestHktvmallProductViaScrapingBee(
  url: string,
  opts: ScrapingBeeDriverOpts,
): Promise<ScrapingBeeHarvestResult> {
  void opts.wrapperTimeoutMs;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxReviews = opts.maxReviews;
  const parsed = assertHktvmallPublicProductUrl(url);
  const ctx: HktvmallHarvestContext = {
    store_id: parsed.store_id,
    product_id: parsed.product_id,
    source_url: parsed.source_url,
  };

  const started = Date.now();
  const byId = new Map<string, FixtureReviewRaw>();
  const rejected: { reason: HktvmallWrapperFailureReason }[] = [];
  let n_wrappers = 0;
  let n_http_requests = 0;
  let creditsSum = 0;
  let sawCredits = false;
  let stopped_reason: HarvestStoppedReason | null = null;

  const addCredits = (credits: number | null): void => {
    if (credits !== null && Number.isFinite(credits)) {
      creditsSum += credits;
      sawCredits = true;
    }
  };

  const commitPage = (parsedPage: ParsedPage): void => {
    n_wrappers += parsedPage.accepted.length + parsedPage.rejected.length;
    rejected.push(...parsedPage.rejected);
    for (const row of parsedPage.accepted) {
      const id = row.native_review_id;
      if (id !== null && id.length > 0) {
        byId.set(id, row);
      }
    }
  };

  const page0 = await opts.fetchPage(0);
  n_http_requests += 1;
  addCredits(page0.credits);
  const latency_ms_goto = page0.latency_ms;
  commitPage(parseHktvmallReviewPage(page0.html, ctx));

  if (n_wrappers === 0) {
    throw new UnhydratedReviewPageError(SCRAPINGBEE_PAGER_WAIT_MS);
  }

  const n_declared_reviews = parseHktvmallDeclaredReviewCount(page0.html);
  const pageTotal = parseHktvmallReviewPageTotal(page0.html);
  const pageCount = pageTotal !== null && pageTotal >= 1 ? pageTotal : 1;
  let n_pages = 1;

  const considerStopAfterCommit = (): void => {
    if (maxReviews !== undefined && byId.size >= maxReviews) {
      stopped_reason = 'max_reviews';
      return;
    }
    if (n_pages >= maxPages) {
      stopped_reason = 'max_pages';
      return;
    }
    if (n_pages >= pageCount) {
      stopped_reason = 'end';
    }
  };

  considerStopAfterCommit();

  while (stopped_reason === null) {
    const next = await opts.fetchPage(n_pages);
    n_http_requests += 1;
    addCredits(next.credits);
    const parsedPage = parseHktvmallReviewPage(next.html, ctx);
    const hasNewId = parsedPage.accepted.some((row) => {
      const id = row.native_review_id;
      return id !== null && id.length > 0 && !byId.has(id);
    });
    if (!hasNewId) {
      stopped_reason = 'unchanged_ids';
      break;
    }
    commitPage(parsedPage);
    n_pages += 1;
    considerStopAfterCommit();
  }

  if (stopped_reason === null) {
    stopped_reason = 'end';
  }

  if (n_wrappers > 0 && byId.size === 0) {
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
    latency_ms_click: 0,
    latency_ms_total: Date.now() - started,
    stopped_reason,
    n_http_requests,
    scrapingbee_credits: sawCredits ? creditsSum : null,
  };
}
