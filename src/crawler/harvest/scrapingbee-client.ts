// SPDX-License-Identifier: GPL-3.0-only
import { ScrapingBeeCredentialsError } from '../../shared/env.js';
import {
  HarvestUsageError,
  ReviewTabNotFoundError,
  ScrapingBeeHttpError,
  ScrapingBeeJsScenarioError,
  UnhydratedReviewPageError,
} from './errors.js';
import { HARVEST_VIEWPORT } from './hktvmall-driver.js';
import {
  buildHktvmallReviewJsScenario,
  SCRAPINGBEE_MAX_HREF_CHARS,
  SCRAPINGBEE_PAGER_WAIT_MS,
  SCRAPINGBEE_TIMEOUT_MS_MAX,
  SCRAPINGBEE_TIMEOUT_MS_MIN,
  type HktvmallReviewJsScenario,
} from './scrapingbee-js-scenario.js';

export const SCRAPINGBEE_HTML_API_URL = 'https://app.scrapingbee.com/api/v1';

const POLLINATOR_TIMEOUT_RE = /pollinator function has timed-out/i;

export type ScrapingBeeHttpResponse = {
  status: number;
  headers: Headers;
  bodyText: string;
};

export type ScrapingBeeHttpGet = (opts: {
  href: string;
  headers: Record<string, string>;
  timeoutMs: number;
}) => Promise<ScrapingBeeHttpResponse>;

export type ScrapingBeeJsScenarioReport = {
  task_failure?: number;
  task_success?: number;
  tasks?: { success?: boolean; task?: string; params?: unknown }[];
};

export type ParsedScrapingBeeHtmlEnvelope = {
  html: string;
  credits: number | null;
  js_scenario_report: ScrapingBeeJsScenarioReport | null;
};

export type ScrapingBeeHtmlPage = {
  html: string;
  credits: number | null;
  latency_ms: number;
};

export function assertScrapingBeeTimeoutMs(timeoutMs: number): number {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < SCRAPINGBEE_TIMEOUT_MS_MIN ||
    timeoutMs > SCRAPINGBEE_TIMEOUT_MS_MAX
  ) {
    throw new HarvestUsageError(
      `--goto-timeout-ms for ScrapingBee must be an integer in [${String(SCRAPINGBEE_TIMEOUT_MS_MIN)}, ${String(SCRAPINGBEE_TIMEOUT_MS_MAX)}]`,
    );
  }
  return timeoutMs;
}

export function buildScrapingBeeHtmlApiHref(opts: {
  targetUrl: string;
  countryCode: string;
  timeoutMs: number;
  sessionId: number;
  jsScenario: HktvmallReviewJsScenario;
}): string {
  const timeoutMs = assertScrapingBeeTimeoutMs(opts.timeoutMs);
  const endpoint = new URL(SCRAPINGBEE_HTML_API_URL);
  const params = new URLSearchParams();
  params.set('url', opts.targetUrl);
  params.set('render_js', 'true');
  params.set('premium_proxy', 'true');
  params.set('country_code', opts.countryCode.trim().toLowerCase());
  params.set('block_resources', 'false');
  params.set('json_response', 'true');
  params.set('window_width', String(HARVEST_VIEWPORT.width));
  params.set('window_height', String(HARVEST_VIEWPORT.height));
  params.set('timeout', String(timeoutMs));
  params.set('wait_browser', 'domcontentloaded');
  params.set('js_scenario', JSON.stringify(opts.jsScenario));
  params.set('session_id', String(opts.sessionId));
  endpoint.search = params.toString();
  const href = endpoint.href;
  if (/[?&]api_key=/i.test(href)) {
    throw new HarvestUsageError('ScrapingBee GET href must not contain api_key');
  }
  if (href.length >= SCRAPINGBEE_MAX_HREF_CHARS) {
    throw new HarvestUsageError(
      `ScrapingBee GET href exceeds ${String(SCRAPINGBEE_MAX_HREF_CHARS)} characters (${String(href.length)})`,
    );
  }
  return href;
}

export function parseScrapingBeeHtmlEnvelope(
  bodyText: string,
  headers: Headers,
): ParsedScrapingBeeHtmlEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    throw new ScrapingBeeHttpError('ScrapingBee HTML API envelope is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ScrapingBeeHttpError('ScrapingBee HTML API envelope is not a JSON object');
  }
  const envelope = parsed as Record<string, unknown>;
  const type = envelope['type'];
  const body = envelope['body'];
  if (typeof body !== 'string' || (type !== undefined && type !== 'html')) {
    throw new ScrapingBeeHttpError('ScrapingBee HTML API envelope body is not HTML');
  }
  return {
    html: body,
    credits: readCredits(envelope['cost'], headers),
    js_scenario_report: readJsScenarioReport(envelope['js_scenario_report']),
  };
}

export async function defaultScrapingBeeHttpGet(opts: {
  href: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<ScrapingBeeHttpResponse> {
  let response: Response;
  try {
    response = await fetch(opts.href, {
      method: 'GET',
      headers: opts.headers,
      signal: AbortSignal.timeout(opts.timeoutMs + 10_000),
    });
  } catch (err) {
    throw wrapScrapingBeeFetchError(err);
  }
  return {
    status: response.status,
    headers: response.headers,
    bodyText: await response.text(),
  };
}

export async function fetchScrapingBeeHtmlPage(opts: {
  apiKey: string;
  targetUrl: string;
  countryCode: string;
  timeoutMs: number;
  sessionId: number;
  pageIndex: number;
  httpGet?: ScrapingBeeHttpGet;
}): Promise<ScrapingBeeHtmlPage> {
  const jsScenario = buildHktvmallReviewJsScenario(opts.pageIndex);
  const href = buildScrapingBeeHtmlApiHref({
    targetUrl: opts.targetUrl,
    countryCode: opts.countryCode,
    timeoutMs: opts.timeoutMs,
    sessionId: opts.sessionId,
    jsScenario,
  });
  const headers = { Authorization: `Bearer ${opts.apiKey}` };
  const httpGet = opts.httpGet ?? defaultScrapingBeeHttpGet;
  const started = Date.now();
  let response: ScrapingBeeHttpResponse;
  try {
    response = await httpGet({ href, headers, timeoutMs: opts.timeoutMs });
  } catch (err) {
    throw wrapScrapingBeeFetchError(err);
  }
  const latency_ms = Date.now() - started;
  throwIfScrapingBeeHttpFailed(response);
  const parsed = parseScrapingBeeHtmlEnvelope(response.bodyText, response.headers);
  throwIfJsScenarioFailed(parsed.js_scenario_report);
  return { html: parsed.html, credits: parsed.credits, latency_ms };
}

function readCredits(cost: unknown, headers: Headers): number | null {
  if (typeof cost === 'number' && Number.isFinite(cost)) {
    return cost;
  }
  const header = headers.get('Spb-cost');
  if (header === null || header === '') {
    return null;
  }
  const n = Number(header);
  return Number.isFinite(n) ? n : null;
}

function readJsScenarioReport(value: unknown): ScrapingBeeJsScenarioReport | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const report: ScrapingBeeJsScenarioReport = {};
  if (typeof raw['task_failure'] === 'number') {
    report.task_failure = raw['task_failure'];
  }
  if (typeof raw['task_success'] === 'number') {
    report.task_success = raw['task_success'];
  }
  if (Array.isArray(raw['tasks'])) {
    report.tasks = raw['tasks'].map((task) => {
      if (typeof task !== 'object' || task === null || Array.isArray(task)) {
        return {};
      }
      const row = task as Record<string, unknown>;
      const mapped: { success?: boolean; task?: string; params?: unknown } = {};
      if (typeof row['success'] === 'boolean') {
        mapped.success = row['success'];
      }
      if (typeof row['task'] === 'string') {
        mapped.task = row['task'];
      }
      if ('params' in row) {
        mapped.params = row['params'];
      }
      return mapped;
    });
  }
  return report;
}

function throwIfScrapingBeeHttpFailed(response: ScrapingBeeHttpResponse): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }
  if (POLLINATOR_TIMEOUT_RE.test(response.bodyText)) {
    throw new ScrapingBeeJsScenarioError('ScrapingBee js_scenario timed out');
  }
  if (response.status === 401) {
    throw new ScrapingBeeCredentialsError('ScrapingBee HTML API rejected the API key (HTTP 401)');
  }
  const requestId = response.headers.get('Spb-request-id');
  const suffix = requestId !== null && requestId.length > 0 ? ` request_id=${requestId}` : '';
  throw new ScrapingBeeHttpError(
    `ScrapingBee HTML API HTTP ${String(response.status)}${suffix}`,
    response.status,
  );
}

function throwIfJsScenarioFailed(report: ScrapingBeeJsScenarioReport | null): void {
  if (report === null || report.task_failure === undefined || report.task_failure <= 0) {
    return;
  }
  const failed = (report.tasks ?? []).filter((task) => task.success === false);
  for (const task of failed) {
    const blob = taskBlob(task);
    const name = task.task ?? '';
    if (
      (name === 'wait_for' || name === 'click' || name === 'wait_for_and_click') &&
      blob.includes('reviewTab')
    ) {
      throw new ReviewTabNotFoundError();
    }
    if (name === 'wait_for' && blob.includes('product-review-wrapper')) {
      throw new UnhydratedReviewPageError(SCRAPINGBEE_PAGER_WAIT_MS);
    }
  }
  throw new ScrapingBeeJsScenarioError(
    `ScrapingBee js_scenario failed (${String(report.task_failure)} task_failure)`,
  );
}

function taskBlob(task: { task?: string; params?: unknown }): string {
  const params = task.params;
  const paramsText =
    typeof params === 'string'
      ? params
      : params === undefined
        ? ''
        : JSON.stringify(params);
  return `${task.task ?? ''} ${paramsText}`;
}

function wrapScrapingBeeFetchError(err: unknown): ScrapingBeeHttpError {
  if (err instanceof ScrapingBeeHttpError) {
    return err;
  }
  const name = err instanceof Error ? err.name : '';
  const detail = err instanceof Error ? err.message : String(err);
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new ScrapingBeeHttpError(`ScrapingBee HTML API request aborted: ${detail}`);
  }
  return new ScrapingBeeHttpError(`ScrapingBee HTML API request failed: ${detail}`);
}
