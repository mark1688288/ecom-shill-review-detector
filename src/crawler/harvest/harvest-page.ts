// SPDX-License-Identifier: GPL-3.0-only
import type { FixtureReviewRaw } from '../types.js';
import type { HktvmallWrapperFailureReason } from './hktvmall.js';

export type HarvestLocator = {
  click(opts?: { timeout?: number; force?: boolean }): Promise<void>;
  count(): Promise<number>;
  getAttribute(name: string): Promise<string | null>;
  first(): HarvestLocator;
  /** CDP adapter: Playwright locator.filter({ visible: true }). Mock: return this. */
  visible(): HarvestLocator;
};

export type HarvestPage = {
  goto(
    url: string,
    opts: { timeout: number; waitUntil: 'domcontentloaded' },
  ): Promise<unknown>;
  locator(selector: string): HarvestLocator;
  getByRole(
    role: 'link' | 'button' | 'heading',
    opts?: { name?: string | RegExp },
  ): HarvestLocator;
  getByText(text: string | RegExp, opts?: { exact?: boolean }): HarvestLocator;
  waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown>;
  /**
   * true = at least one new data-reviewid appeared.
   * false = wait timeout / set unchanged (Playwright TimeoutError only).
   * CDP disconnect / target closed: throw (adapter wraps HarvestSessionDroppedError).
   */
  waitForNewReviewIds(prevIds: string[], timeoutMs: number): Promise<boolean>;
  content(): Promise<string>;
  innerText(selector: string): Promise<string>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
};

export type HarvestStoppedReason =
  | 'end'
  | 'max_pages'
  | 'max_reviews'
  | 'unchanged_ids'
  | 'next_disabled';

export type HarvestResult = {
  url: string;
  store_id: string;
  product_id: string;
  accepted: FixtureReviewRaw[];
  rejected: { reason: HktvmallWrapperFailureReason }[];
  /** Pages successfully committed (not clicks, not empty snapshots). */
  n_pages: number;
  n_wrappers: number;
  n_declared_reviews: number | null;
  /** parseHktvmallReviewPageTotal from the first committed HTML; never backfilled. */
  page_total: number | null;
  latency_ms_goto: number;
  latency_ms_click: number;
  latency_ms_total: number;
  stopped_reason: HarvestStoppedReason;
};
