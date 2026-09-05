// SPDX-License-Identifier: GPL-3.0-only
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import { loadBrightDataBrowserEnv } from '../../shared/env.js';
import type { HarvestPage, HarvestResult } from '../../crawler/harvest/harvest-page.js';
import type { FixtureReviewRaw } from '../../crawler/types.js';
import {
  HarvestTosRequiredError,
  HarvestUsageError,
  UnhydratedReviewPageError,
  harvestErrorExitCode,
} from '../../crawler/harvest/errors.js';
import {
  DEFAULT_GOTO_TIMEOUT_MS,
  DEFAULT_MAX_PAGES,
  DEFAULT_WRAPPER_TIMEOUT_MS,
  harvestHktvmallProductPage,
  type HarvestDriverOpts,
} from '../../crawler/harvest/hktvmall-driver.js';
import { mergeByNativeReviewId } from '../../crawler/harvest/merge.js';
import { parseHarvestUrls, type ParsedHarvestUrl } from '../../crawler/harvest/url-list.js';

export type HarvestConnect = (opts: {
  username: string;
  password: string;
  country: string;
}) => Promise<{ page: HarvestPage; close: () => Promise<void> }>;

export type HarvestCliOptions = {
  marketplace?: string;
  url?: string[];
  urlFile?: string;
  out?: string;
  iAcceptTos?: boolean;
  dryRun?: boolean;
  country?: string;
  maxReviews?: string;
  maxPages?: string;
  gotoTimeoutMs?: string;
  wrapperTimeoutMs?: string;
  strict?: boolean;
};

export type RunHarvestOptions = HarvestCliOptions & {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  stdout?: { write(chunk: string): unknown };
  connect?: HarvestConnect;
  logger?: Logger;
};

export type HarvestManifest = {
  ok: boolean;
  failed_url: string | null;
  n_urls_ok: number;
  n_urls_failed: number;
  n_accepted: number;
  n_pages: number;
  n_rejected: number;
  stamp: string;
};

export type HarvestCommandResult = {
  exitCode: number;
  dryRun: boolean;
  ok: boolean;
  stamp: string;
  outPath: string;
  manifestPath: string;
  n_urls: number;
  n_urls_ok: number;
  n_pages: number;
  n_wrappers: number;
  n_accepted: number;
  n_rejected: number;
  n_deduped: number;
  samples: FixtureReviewRaw[];
};

export function harvestStampUtc(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function parsePositiveInt(value: string | undefined, flag: string, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HarvestUsageError(`${flag} must be a positive integer`);
  }
  return n;
}

function parseOptionalPositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HarvestUsageError(`${flag} must be a positive integer`);
  }
  return n;
}

function normalizeCountry(value: string | undefined): string {
  const c = (value ?? 'HK').trim();
  if (!/^[A-Za-z]{2}$/.test(c)) {
    throw new HarvestUsageError('--country must be a 2-letter ISO code');
  }
  return c.toUpperCase();
}

function serializeFixtureJsonl(rows: readonly FixtureReviewRaw[]): string {
  return rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

async function writeUtf8(filePath: string, body: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body, 'utf8');
}

function defaultHarvestLogger(level: string): Logger {
  return pino({ level, base: null }, process.stderr);
}

function defaultConnect(): HarvestConnect {
  return async (opts) => {
    const mod = await import('../../crawler/browser/brightdata-cdp.js');
    const connected = await mod.connectHktvmallBrowser(opts);
    return { page: connected.page, close: connected.close };
  };
}

function printDryRunPlan(
  stdout: { write(chunk: string): unknown },
  targets: readonly ParsedHarvestUrl[],
  country: string,
): void {
  for (const target of targets) {
    stdout.write(`plan_marketplace=hktvmall\n`);
    stdout.write(`plan_url=${target.href}\n`);
    stdout.write(`plan_store_id=${target.store_id}\n`);
    stdout.write(`plan_product_id=${target.product_id}\n`);
    stdout.write(`plan_host=${target.host}\n`);
    stdout.write(`plan_country=${country.toLowerCase()}\n`);
    stdout.write(`plan_click=css:[data-tab="reviewTab"]\n`);
    stdout.write(`plan_wait=div.product-review-wrapper\n`);
    stdout.write(`plan_next=role:link|button name=下一頁\n`);
    stdout.write(`plan_paginate=waitForNewReviewIds\n`);
    stdout.write(`plan_locale_path=/hktv/zh/\n`);
    stdout.write(`plan_connect=no\n`);
    stdout.write(`plan_goto_waitUntil=domcontentloaded\n`);
  }
}

function nDedupedFromResult(result: HarvestResult): number {
  const acceptedRaw = result.n_wrappers - result.rejected.length;
  const n = acceptedRaw - result.accepted.length;
  return n > 0 ? n : 0;
}

export async function runHarvest(opts: RunHarvestOptions): Promise<HarvestCommandResult> {
  const marketplace = opts.marketplace ?? 'hktvmall';
  if (marketplace !== 'hktvmall') {
    throw new HarvestUsageError(
      `harvest --marketplace only supports hktvmall (got ${marketplace})`,
      2,
    );
  }

  const dryRun = opts.dryRun === true;
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const stdout = opts.stdout ?? process.stdout;
  const logger = opts.logger ?? defaultHarvestLogger(env['LOG_LEVEL'] ?? 'info');
  const country = normalizeCountry(opts.country);
  const maxPages = parsePositiveInt(opts.maxPages, '--max-pages', DEFAULT_MAX_PAGES);
  const gotoTimeoutMs = parsePositiveInt(
    opts.gotoTimeoutMs,
    '--goto-timeout-ms',
    DEFAULT_GOTO_TIMEOUT_MS,
  );
  const wrapperTimeoutMs = parsePositiveInt(
    opts.wrapperTimeoutMs,
    '--wrapper-timeout-ms',
    DEFAULT_WRAPPER_TIMEOUT_MS,
  );
  const maxReviews = parseOptionalPositiveInt(opts.maxReviews, '--max-reviews');
  const stamp = harvestStampUtc(now);
  const outPath = path.resolve(
    cwd,
    opts.out ?? path.join('data', 'harvested', `${stamp}-hktvmall.jsonl`),
  );
  const outPartial = `${outPath}.partial`;
  const manifestPath = `${outPath.replace(/\.jsonl$/i, '')}.manifest.json`;

  const targets = parseHarvestUrls({
    urls: opts.url ?? [],
    urlFile: opts.urlFile,
    cwd,
  });

  const emptyResult = (): HarvestCommandResult => ({
    exitCode: 0,
    dryRun,
    ok: true,
    stamp,
    outPath,
    manifestPath,
    n_urls: targets.length,
    n_urls_ok: 0,
    n_pages: 0,
    n_wrappers: 0,
    n_accepted: 0,
    n_rejected: 0,
    n_deduped: 0,
    samples: [],
  });

  if (dryRun) {
    printDryRunPlan(stdout, targets, country);
    logger.info({
      event: 'harvest_plan',
      store_id: targets[0]?.store_id,
      product_id: targets[0]?.product_id,
      country: country.toLowerCase(),
      n_urls: targets.length,
      host: targets[0]?.host,
    });
    return emptyResult();
  }

  if (opts.iAcceptTos !== true) {
    throw new HarvestTosRequiredError();
  }

  const creds = loadBrightDataBrowserEnv(env);
  const connectFn = opts.connect ?? defaultConnect();
  const driverOpts: HarvestDriverOpts = {
    gotoTimeoutMs,
    wrapperTimeoutMs,
    maxPages,
    ...(maxReviews === undefined ? {} : { maxReviews }),
  };

  logger.info({
    event: 'harvest_started',
    marketplace: 'hktvmall',
    n_urls: targets.length,
    country: country.toLowerCase(),
    max_pages: maxPages,
    ...(maxReviews === undefined ? {} : { max_reviews: maxReviews }),
  });

  const merged: FixtureReviewRaw[] = [];
  let n_pages = 0;
  let n_wrappers = 0;
  let n_rejected = 0;
  let n_deduped = 0;
  let n_urls_ok = 0;

  const writeFailManifest = async (failedUrl: string): Promise<void> => {
    const { rows, n_deduped: mergedDeduped } = mergeByNativeReviewId(merged);
    await writeUtf8(outPartial, serializeFixtureJsonl(rows));
    const manifest: HarvestManifest = {
      ok: false,
      failed_url: failedUrl,
      n_urls_ok,
      n_urls_failed: 1,
      n_accepted: rows.length,
      n_pages,
      n_rejected,
      stamp,
    };
    await writeUtf8(manifestPath, `${JSON.stringify(manifest)}\n`);
    logger.info({
      event: 'harvest_finished',
      n_urls: targets.length,
      n_urls_ok,
      n_pages,
      n_wrappers,
      n_accepted: rows.length,
      n_rejected,
      n_deduped: n_deduped + mergedDeduped,
      out_path: outPath,
      ok: false,
    });
  };

  for (const target of targets) {
    let session: { page: HarvestPage; close: () => Promise<void> } | undefined;
    try {
      session = await connectFn({
        username: creds.username,
        password: creds.password,
        country,
      });
      const result = await harvestHktvmallProductPage(session.page, target.href, driverOpts);
      const urlDeduped = nDedupedFromResult(result);
      n_pages += result.n_pages;
      n_wrappers += result.n_wrappers;
      n_rejected += result.rejected.length;
      n_deduped += urlDeduped;
      merged.push(...result.accepted);
      n_urls_ok += 1;

      for (const row of result.rejected) {
        logger.debug({ event: 'harvest_wrapper_rejected', reason: row.reason });
      }
      logger.info({
        event: 'harvest_url_done',
        store_id: result.store_id,
        product_id: result.product_id,
        n_pages: result.n_pages,
        n_wrappers: result.n_wrappers,
        n_accepted: result.accepted.length,
        n_rejected: result.rejected.length,
        n_deduped: urlDeduped,
        ...(result.n_declared_reviews === null
          ? {}
          : { n_declared_reviews: result.n_declared_reviews }),
        stopped_reason: result.stopped_reason,
        latency_ms_goto: result.latency_ms_goto,
        latency_ms_click: result.latency_ms_click,
        latency_ms_total: result.latency_ms_total,
      });
      if (result.stopped_reason === 'max_pages') {
        logger.warn({
          event: 'harvest_max_pages',
          n_pages: result.n_pages,
          max_pages: maxPages,
          store_id: result.store_id,
          product_id: result.product_id,
        });
      }
      const incomplete =
        result.stopped_reason === 'unchanged_ids' ||
        (result.n_declared_reviews !== null && result.accepted.length < result.n_declared_reviews);
      if (incomplete) {
        logger.warn({
          event: 'harvest_incomplete_pages',
          n_accepted: result.accepted.length,
          ...(result.n_declared_reviews === null
            ? {}
            : { n_declared_reviews: result.n_declared_reviews }),
          n_pages: result.n_pages,
          stopped_reason: result.stopped_reason,
        });
      }

      const { rows } = mergeByNativeReviewId(merged);
      await writeUtf8(outPartial, serializeFixtureJsonl(rows));
    } catch (err) {
      if (err instanceof UnhydratedReviewPageError) {
        logger.error({
          event: 'harvest_unhydrated',
          store_id: target.store_id,
          product_id: target.product_id,
          wait_ms: err.wait_ms,
        });
      }
      try {
        await writeFailManifest(target.href);
      } catch {
        // Preserve the harvest error even if sidecar write fails.
      }
      throw err;
    } finally {
      if (session !== undefined) {
        let closedOk = false;
        try {
          await session.close();
          closedOk = true;
        } catch {
          closedOk = false;
        }
        logger.info({ event: 'harvest_browser_closed', ok: closedOk });
      }
    }
  }

  const { rows, n_deduped: mergedDeduped } = mergeByNativeReviewId(merged);
  await writeUtf8(outPartial, serializeFixtureJsonl(rows));
  await mkdir(path.dirname(outPath), { recursive: true });
  await rename(outPartial, outPath);
  const manifest: HarvestManifest = {
    ok: true,
    failed_url: null,
    n_urls_ok,
    n_urls_failed: 0,
    n_accepted: rows.length,
    n_pages,
    n_rejected,
    stamp,
  };
  await writeUtf8(manifestPath, `${JSON.stringify(manifest)}\n`);

  const totalDeduped = n_deduped + mergedDeduped;
  stdout.write(
    `n_pages=${String(n_pages)} n_wrappers=${String(n_wrappers)} n_accepted=${String(rows.length)} n_rejected=${String(n_rejected)} n_urls=${String(targets.length)}\n`,
  );
  stdout.write(`out=${outPath}\n`);
  logger.info({
    event: 'harvest_finished',
    n_urls: targets.length,
    n_urls_ok,
    n_pages,
    n_wrappers,
    n_accepted: rows.length,
    n_rejected,
    n_deduped: totalDeduped,
    out_path: outPath,
    ok: true,
  });

  const exitCode = opts.strict === true && n_rejected > 0 ? 1 : 0;
  return {
    exitCode,
    dryRun: false,
    ok: true,
    stamp,
    outPath,
    manifestPath,
    n_urls: targets.length,
    n_urls_ok,
    n_pages,
    n_wrappers,
    n_accepted: rows.length,
    n_rejected,
    n_deduped: totalDeduped,
    samples: rows.slice(0, 3),
  };
}

export async function harvestAction(opts: HarvestCliOptions): Promise<void> {
  try {
    const result = await runHarvest(opts);
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exitCode = harvestErrorExitCode(err);
  }
}
