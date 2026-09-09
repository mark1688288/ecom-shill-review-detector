// SPDX-License-Identifier: GPL-3.0-only
import { randomInt } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import { loadBrightDataBrowserEnv, loadScrapingBeeEnv } from '../../shared/env.js';
import type {
  HarvestPage,
  HarvestResult,
  HarvestStoppedReason,
} from '../../crawler/harvest/harvest-page.js';
import type { FixtureReviewRaw } from '../../crawler/types.js';
import {
  HarvestPaginationShortfallError,
  HarvestTosRequiredError,
  HarvestUsageError,
  UnhydratedReviewPageError,
  harvestErrorExitCode,
} from '../../crawler/harvest/errors.js';
import {
  DEFAULT_GOTO_TIMEOUT_MS,
  DEFAULT_MAX_PAGES,
  DEFAULT_WRAPPER_TIMEOUT_MS,
  expectedHktvmallReviewPageCount,
  harvestHktvmallProductPage,
  isHarvestCompletenessFailure,
  type HarvestDriverOpts,
} from '../../crawler/harvest/hktvmall-driver.js';
import { mergeByNativeReviewId } from '../../crawler/harvest/merge.js';
import {
  assertScrapingBeeTimeoutMs,
  fetchScrapingBeeHtmlPage,
  type ScrapingBeeHttpGet,
} from '../../crawler/harvest/scrapingbee-client.js';
import { harvestHktvmallProductViaScrapingBee } from '../../crawler/harvest/scrapingbee-driver.js';
import {
  HKTVMALL_SB_REVIEW_TAB_CSS,
  HKTVMALL_SB_WRAPPER_CSS,
} from '../../crawler/harvest/scrapingbee-js-scenario.js';
import { parseHarvestUrls, type ParsedHarvestUrl } from '../../crawler/harvest/url-list.js';

export type HarvestTransport = 'brightdata' | 'scrapingbee';

export type HarvestConnect = (opts: {
  username: string;
  password: string;
  country: string;
}) => Promise<{ page: HarvestPage; close: () => Promise<void> }>;

export type HarvestCliOptions = {
  marketplace?: string;
  transport?: string;
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
  scrapingBeeGet?: ScrapingBeeHttpGet;
  logger?: Logger;
  driverOpts?: Pick<HarvestDriverOpts, 'settleParseTimeoutMs' | 'settleParsePollMs'>;
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
  transport?: HarvestTransport;
  stopped_reason: HarvestStoppedReason | null;
  page_total: number | null;
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

function parseHarvestTransport(value: string | undefined): HarvestTransport {
  const transport = value ?? 'brightdata';
  if (transport !== 'brightdata' && transport !== 'scrapingbee') {
    throw new HarvestUsageError(
      `harvest --transport only supports brightdata|scrapingbee (got ${transport})`,
      2,
    );
  }
  return transport;
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
  transport: HarvestTransport,
): void {
  for (const target of targets) {
    if (transport === 'scrapingbee') {
      stdout.write(`plan_transport=scrapingbee\n`);
      stdout.write(`plan_marketplace=hktvmall\n`);
      stdout.write(`plan_url=${target.href}\n`);
      stdout.write(`plan_store_id=${target.store_id}\n`);
      stdout.write(`plan_product_id=${target.product_id}\n`);
      stdout.write(`plan_host=${target.host}\n`);
      stdout.write(`plan_country=${country.toLowerCase()}\n`);
      stdout.write(`plan_click=css:${HKTVMALL_SB_REVIEW_TAB_CSS}\n`);
      stdout.write(`plan_wait=${HKTVMALL_SB_WRAPPER_CSS}\n`);
      stdout.write(
        `plan_pager_select=span.total ancestor select (not document.querySelector('select'))\n`,
      );
      stdout.write(`plan_paginate=js_scenario evaluate select.value pageIndex\n`);
      stdout.write(`plan_forbidden_locator=a.next-btn first-match\n`);
      stdout.write(`plan_render_js=true\n`);
      stdout.write(`plan_premium_proxy=true\n`);
      stdout.write(`plan_block_resources=false\n`);
      stdout.write(`plan_json_response=true\n`);
      stdout.write(`plan_screenshot=false\n`);
      stdout.write(`plan_locale_path=/hktv/zh/\n`);
      stdout.write(`plan_connect=no\n`);
      stdout.write(`plan_http=no\n`);
      continue;
    }
    stdout.write(`plan_transport=brightdata\n`);
    stdout.write(`plan_marketplace=hktvmall\n`);
    stdout.write(`plan_url=${target.href}\n`);
    stdout.write(`plan_store_id=${target.store_id}\n`);
    stdout.write(`plan_product_id=${target.product_id}\n`);
    stdout.write(`plan_host=${target.host}\n`);
    stdout.write(`plan_country=${country.toLowerCase()}\n`);
    stdout.write(`plan_click=css:[data-tab="reviewTab"]\n`);
    stdout.write(`plan_wait=div.product-review-wrapper\n`);
    stdout.write(`plan_next=role:link|button name=下一頁\n`);
    stdout.write(`plan_paginate=waitForNewReviewIds+content_poll\n`);
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

type HarvestedUrl = {
  result: HarvestResult;
  n_http_requests?: number;
  scrapingbee_credits?: number | null;
};

export async function runHarvest(opts: RunHarvestOptions): Promise<HarvestCommandResult> {
  const marketplace = opts.marketplace ?? 'hktvmall';
  if (marketplace !== 'hktvmall') {
    throw new HarvestUsageError(
      `harvest --marketplace only supports hktvmall (got ${marketplace})`,
      2,
    );
  }

  const transport = parseHarvestTransport(opts.transport);
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
  if (transport === 'scrapingbee') {
    assertScrapingBeeTimeoutMs(gotoTimeoutMs);
  }
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
    printDryRunPlan(stdout, targets, country, transport);
    logger.info({
      event: 'harvest_plan',
      transport,
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

  const scrapingBeeApiKey =
    transport === 'scrapingbee' ? loadScrapingBeeEnv(env).apiKey : undefined;
  const brightDataCreds =
    transport === 'brightdata' ? loadBrightDataBrowserEnv(env) : undefined;
  const connectFn = transport === 'brightdata' ? (opts.connect ?? defaultConnect()) : undefined;
  const driverOpts: HarvestDriverOpts = {
    gotoTimeoutMs,
    wrapperTimeoutMs,
    maxPages,
    ...(maxReviews === undefined ? {} : { maxReviews }),
    ...(opts.driverOpts ?? {}),
  };

  logger.info({
    event: 'harvest_started',
    transport,
    marketplace: 'hktvmall',
    n_urls: targets.length,
    country: country.toLowerCase(),
    max_pages: maxPages,
    ...(maxReviews === undefined ? {} : { max_reviews: maxReviews }),
  });
  if (transport === 'scrapingbee') {
    logger.debug({
      event: 'wrapper_timeout_ms_ignored',
      wrapper_timeout_ms: wrapperTimeoutMs,
      transport,
    });
  }

  const merged: FixtureReviewRaw[] = [];
  let n_pages = 0;
  let n_wrappers = 0;
  let n_rejected = 0;
  let n_deduped = 0;
  let n_urls_ok = 0;
  let n_http_requests = 0;
  let scrapingbeeCreditsSum = 0;
  let sawScrapingBeeCredits = false;
  let sidecarStoppedReason: HarvestStoppedReason | null = null;
  let sidecarPageTotal: number | null = null;

  const writeFailManifest = async (failedUrl: string, err: unknown): Promise<void> => {
    const { rows, n_deduped: mergedDeduped } = mergeByNativeReviewId(merged);
    await writeUtf8(outPartial, serializeFixtureJsonl(rows));
    const shortfall = err instanceof HarvestPaginationShortfallError;
    const manifest: HarvestManifest = {
      ok: false,
      failed_url: failedUrl,
      n_urls_ok,
      n_urls_failed: 1,
      n_accepted: rows.length,
      n_pages,
      n_rejected,
      stamp,
      transport,
      stopped_reason: shortfall ? err.stopped_reason : null,
      page_total: shortfall ? err.page_total : null,
    };
    await writeUtf8(manifestPath, `${JSON.stringify(manifest)}\n`);
    logger.info({
      event: 'harvest_finished',
      transport,
      n_urls: targets.length,
      n_urls_ok,
      n_pages,
      n_wrappers,
      n_accepted: rows.length,
      n_rejected,
      n_deduped: n_deduped + mergedDeduped,
      out_path: outPath,
      ok: false,
      ...(transport === 'scrapingbee' ? { n_http_requests } : {}),
      ...(sawScrapingBeeCredits ? { scrapingbee_credits: scrapingbeeCreditsSum } : {}),
    });
  };

  for (const target of targets) {
    try {
      const harvested =
        transport === 'scrapingbee'
          ? await harvestOneScrapingBeeUrl({
              href: target.href,
              apiKey: scrapingBeeApiKey ?? '',
              country: country.toLowerCase(),
              gotoTimeoutMs,
              wrapperTimeoutMs,
              maxPages,
              maxReviews,
              httpGet: opts.scrapingBeeGet,
            })
          : await harvestOneBrightDataUrl({
              href: target.href,
              creds: brightDataCreds ?? { username: '', password: '' },
              country,
              connectFn: connectFn ?? defaultConnect(),
              driverOpts,
              logger,
            });
      const urlDeduped = nDedupedFromResult(harvested.result);
      n_pages += harvested.result.n_pages;
      n_wrappers += harvested.result.n_wrappers;
      n_rejected += harvested.result.rejected.length;
      n_deduped += urlDeduped;
      merged.push(...harvested.result.accepted);
      if (harvested.n_http_requests !== undefined) {
        n_http_requests += harvested.n_http_requests;
      }
      if (harvested.scrapingbee_credits !== undefined && harvested.scrapingbee_credits !== null) {
        scrapingbeeCreditsSum += harvested.scrapingbee_credits;
        sawScrapingBeeCredits = true;
      }

      for (const row of harvested.result.rejected) {
        logger.debug({ event: 'harvest_wrapper_rejected', reason: row.reason });
      }
      logger.info({
        event: 'harvest_url_done',
        transport,
        store_id: harvested.result.store_id,
        product_id: harvested.result.product_id,
        n_pages: harvested.result.n_pages,
        n_wrappers: harvested.result.n_wrappers,
        n_accepted: harvested.result.accepted.length,
        n_rejected: harvested.result.rejected.length,
        n_deduped: urlDeduped,
        ...(harvested.result.n_declared_reviews === null
          ? {}
          : { n_declared_reviews: harvested.result.n_declared_reviews }),
        ...(harvested.result.page_total === null ? {} : { page_total: harvested.result.page_total }),
        stopped_reason: harvested.result.stopped_reason,
        latency_ms_goto: harvested.result.latency_ms_goto,
        latency_ms_click: harvested.result.latency_ms_click,
        latency_ms_total: harvested.result.latency_ms_total,
        ...(harvested.n_http_requests === undefined
          ? {}
          : { n_http_requests: harvested.n_http_requests }),
        ...(harvested.scrapingbee_credits === undefined || harvested.scrapingbee_credits === null
          ? {}
          : { scrapingbee_credits: harvested.scrapingbee_credits }),
      });
      if (harvested.result.stopped_reason === 'max_pages') {
        logger.warn({
          event: 'harvest_max_pages',
          n_pages: harvested.result.n_pages,
          max_pages: maxPages,
          store_id: harvested.result.store_id,
          product_id: harvested.result.product_id,
        });
      }
      const expected_pages = expectedHktvmallReviewPageCount(
        harvested.result.page_total,
        harvested.result.n_declared_reviews,
      );
      if (isHarvestCompletenessFailure(harvested.result) && expected_pages !== null) {
        logger.error({
          event: 'harvest_pagination_shortfall',
          store_id: harvested.result.store_id,
          product_id: harvested.result.product_id,
          n_pages: harvested.result.n_pages,
          page_total: harvested.result.page_total,
          expected_pages,
          n_accepted: harvested.result.accepted.length,
          n_declared_reviews: harvested.result.n_declared_reviews,
          stopped_reason: harvested.result.stopped_reason,
        });
        throw new HarvestPaginationShortfallError({
          url: target.href,
          n_pages: harvested.result.n_pages,
          page_total: harvested.result.page_total,
          n_declared_reviews: harvested.result.n_declared_reviews,
          n_accepted: harvested.result.accepted.length,
          expected_pages,
          stopped_reason: harvested.result.stopped_reason,
        });
      }
      const incomplete =
        harvested.result.stopped_reason === 'unchanged_ids' ||
        (harvested.result.n_declared_reviews !== null &&
          harvested.result.accepted.length < harvested.result.n_declared_reviews);
      if (incomplete) {
        logger.warn({
          event: 'harvest_incomplete_pages',
          n_accepted: harvested.result.accepted.length,
          ...(harvested.result.n_declared_reviews === null
            ? {}
            : { n_declared_reviews: harvested.result.n_declared_reviews }),
          n_pages: harvested.result.n_pages,
          stopped_reason: harvested.result.stopped_reason,
        });
      }

      sidecarStoppedReason = harvested.result.stopped_reason;
      sidecarPageTotal = harvested.result.page_total;
      n_urls_ok += 1;
      const { rows } = mergeByNativeReviewId(merged);
      await writeUtf8(outPartial, serializeFixtureJsonl(rows));
    } catch (err) {
      if (err instanceof UnhydratedReviewPageError) {
        logger.error({
          event: 'harvest_unhydrated',
          transport,
          store_id: target.store_id,
          product_id: target.product_id,
          wait_ms: err.wait_ms,
        });
      }
      try {
        await writeFailManifest(target.href, err);
      } catch {
        // Preserve the harvest error even if sidecar write fails.
      }
      throw err;
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
    transport,
    stopped_reason: targets.length === 1 ? sidecarStoppedReason : null,
    page_total: targets.length === 1 ? sidecarPageTotal : null,
  };
  await writeUtf8(manifestPath, `${JSON.stringify(manifest)}\n`);

  const totalDeduped = n_deduped + mergedDeduped;
  stdout.write(
    `n_pages=${String(n_pages)} n_wrappers=${String(n_wrappers)} n_accepted=${String(rows.length)} n_rejected=${String(n_rejected)} n_urls=${String(targets.length)}\n`,
  );
  stdout.write(`out=${outPath}\n`);
  logger.info({
    event: 'harvest_finished',
    transport,
    n_urls: targets.length,
    n_urls_ok,
    n_pages,
    n_wrappers,
    n_accepted: rows.length,
    n_rejected,
    n_deduped: totalDeduped,
    out_path: outPath,
    ok: true,
    ...(transport === 'scrapingbee' ? { n_http_requests } : {}),
    ...(sawScrapingBeeCredits ? { scrapingbee_credits: scrapingbeeCreditsSum } : {}),
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

async function harvestOneBrightDataUrl(opts: {
  href: string;
  creds: { username: string; password: string };
  country: string;
  connectFn: HarvestConnect;
  driverOpts: HarvestDriverOpts;
  logger: Logger;
}): Promise<HarvestedUrl> {
  let session: { page: HarvestPage; close: () => Promise<void> } | undefined;
  try {
    session = await opts.connectFn({
      username: opts.creds.username,
      password: opts.creds.password,
      country: opts.country,
    });
    const result = await harvestHktvmallProductPage(session.page, opts.href, opts.driverOpts);
    return { result };
  } finally {
    if (session !== undefined) {
      let closedOk = false;
      try {
        await session.close();
        closedOk = true;
      } catch {
        closedOk = false;
      }
      opts.logger.info({ event: 'harvest_browser_closed', ok: closedOk });
    }
  }
}

async function harvestOneScrapingBeeUrl(opts: {
  href: string;
  apiKey: string;
  country: string;
  gotoTimeoutMs: number;
  wrapperTimeoutMs: number;
  maxPages: number;
  maxReviews: number | undefined;
  httpGet: ScrapingBeeHttpGet | undefined;
}): Promise<HarvestedUrl> {
  const sessionId = randomInt(0, 10_000_001);
  const harvested = await harvestHktvmallProductViaScrapingBee(opts.href, {
    fetchPage: async (pageIndex) =>
      fetchScrapingBeeHtmlPage({
        apiKey: opts.apiKey,
        targetUrl: opts.href,
        countryCode: opts.country,
        timeoutMs: opts.gotoTimeoutMs,
        sessionId,
        pageIndex,
        ...(opts.httpGet === undefined ? {} : { httpGet: opts.httpGet }),
      }),
    maxPages: opts.maxPages,
    wrapperTimeoutMs: opts.wrapperTimeoutMs,
    ...(opts.maxReviews === undefined ? {} : { maxReviews: opts.maxReviews }),
  });
  return {
    result: harvested,
    n_http_requests: harvested.n_http_requests,
    scrapingbee_credits: harvested.scrapingbee_credits,
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
