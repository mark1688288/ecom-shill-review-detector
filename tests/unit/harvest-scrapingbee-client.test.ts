// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  HarvestUsageError,
  ReviewTabNotFoundError,
  ScrapingBeeHttpError,
  ScrapingBeeJsScenarioError,
  UnhydratedReviewPageError,
} from '../../src/crawler/harvest/errors.js';
import {
  buildScrapingBeeHtmlApiHref,
  fetchScrapingBeeHtmlPage,
  parseScrapingBeeHtmlEnvelope,
  type ScrapingBeeHttpGet,
} from '../../src/crawler/harvest/scrapingbee-client.js';
import {
  buildHktvmallReviewJsScenario,
  SCRAPINGBEE_MAX_HREF_CHARS,
} from '../../src/crawler/harvest/scrapingbee-js-scenario.js';
import { ScrapingBeeCredentialsError } from '../../src/shared/env.js';

const PRODUCT_URL =
  'https://www.hktvmall.com/hktv/zh/main/Store-Name-With-Several-Category-Words/s/S2090001/supermarket/long-category-path/p/S2090001_S_4000412';

const FORBIDDEN_PARAMS = [
  'api_key',
  'mode',
  'screenshot',
  'screenshot_full_page',
  'extract_rules',
  'ai_query',
  'ai_extract_rules',
  'stealth_proxy',
  'return_page_source',
  'return_page_markdown',
] as const;

function typicalHref(): string {
  return buildScrapingBeeHtmlApiHref({
    targetUrl: PRODUCT_URL,
    countryCode: 'HK',
    timeoutMs: 120_000,
    sessionId: 7,
    jsScenario: buildHktvmallReviewJsScenario(0),
  });
}

function envelope(body: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    body,
    type: 'html',
    cost: 25,
    ...extra,
  });
}

describe('buildScrapingBeeHtmlApiHref', () => {
  it('sends frozen HTML API params without api_key and with timeout=120000', () => {
    const href = typicalHref();
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe('https://app.scrapingbee.com/api/v1');
    expect(url.searchParams.get('url')).toBe(PRODUCT_URL);
    expect(url.searchParams.get('render_js')).toBe('true');
    expect(url.searchParams.get('premium_proxy')).toBe('true');
    expect(url.searchParams.get('country_code')).toBe('hk');
    expect(url.searchParams.get('block_resources')).toBe('false');
    expect(url.searchParams.get('json_response')).toBe('true');
    expect(url.searchParams.get('window_width')).toBe('1280');
    expect(url.searchParams.get('window_height')).toBe('720');
    expect(url.searchParams.get('timeout')).toBe('120000');
    expect(url.searchParams.get('wait_browser')).toBe('domcontentloaded');
    expect(url.searchParams.get('session_id')).toBe('7');
    expect(url.searchParams.get('js_scenario')).toBeTruthy();
    for (const key of FORBIDDEN_PARAMS) {
      expect(url.searchParams.has(key)).toBe(false);
    }
    expect(href.length).toBeLessThan(SCRAPINGBEE_MAX_HREF_CHARS);
  });

  it('rejects timeouts outside 1000–140000 and over-budget hrefs', () => {
    const scenario = buildHktvmallReviewJsScenario(0);
    expect(() =>
      buildScrapingBeeHtmlApiHref({
        targetUrl: PRODUCT_URL,
        countryCode: 'hk',
        timeoutMs: 999,
        sessionId: 1,
        jsScenario: scenario,
      }),
    ).toThrow(HarvestUsageError);
    const huge = `https://www.hktvmall.com/hktv/zh/main/${'A'.repeat(7000)}/s/S2090001/cat/p/S2090001_S_4000412`;
    expect(() =>
      buildScrapingBeeHtmlApiHref({
        targetUrl: huge,
        countryCode: 'hk',
        timeoutMs: 120_000,
        sessionId: 1,
        jsScenario: scenario,
      }),
    ).toThrow(/6144/);
  });
});

describe('parseScrapingBeeHtmlEnvelope', () => {
  it('reads body HTML, prefers numeric cost, and drops xhr', () => {
    const xhrUrl = 'https://example.invalid/private-review-path';
    const parsed = parseScrapingBeeHtmlEnvelope(
      envelope('<html>ok</html>', {
        xhr: [{ url: xhrUrl, body: '{"secret":1}' }],
        cookies: [{ name: 'sid', value: 'abc' }],
        metadata: { 'json-ld': { numberOfReviews: 0 } },
        evaluate_results: ['<div data-user="hidden">'],
      }),
      new Headers({ 'Spb-cost': '99' }),
    );
    expect(parsed.html).toBe('<html>ok</html>');
    expect(parsed.credits).toBe(25);
    expect(parsed).not.toHaveProperty('xhr');
    expect(JSON.stringify(parsed)).not.toContain(xhrUrl);
    expect(JSON.stringify(parsed)).not.toContain('hidden');
  });

  it('falls back to Spb-cost when envelope cost is absent', () => {
    const parsed = parseScrapingBeeHtmlEnvelope(
      JSON.stringify({ body: '<html/>', type: 'html' }),
      new Headers({ 'spb-cost': '30' }),
    );
    expect(parsed.credits).toBe(30);
  });

  it('throws when the envelope is not JSON or body is not HTML', () => {
    expect(() => parseScrapingBeeHtmlEnvelope('not-json', new Headers())).toThrow(
      ScrapingBeeHttpError,
    );
    expect(() =>
      parseScrapingBeeHtmlEnvelope(
        JSON.stringify({ body: { nested: true }, type: 'json' }),
        new Headers(),
      ),
    ).toThrow(ScrapingBeeHttpError);
  });
});

describe('fetchScrapingBeeHtmlPage', () => {
  it('sends Bearer auth, never puts the key in the href, and returns HTML', async () => {
    let seenHref = '';
    let seenHeaders: Record<string, string> = {};
    let seenTimeout = 0;
    const httpGet: ScrapingBeeHttpGet = async (req) => {
      seenHref = req.href;
      seenHeaders = req.headers;
      seenTimeout = req.timeoutMs;
      return {
        status: 200,
        headers: new Headers(),
        bodyText: envelope('<div class="product-review-wrapper"></div>'),
      };
    };
    const page = await fetchScrapingBeeHtmlPage({
      apiKey: 'secret-test-key',
      targetUrl: PRODUCT_URL,
      countryCode: 'hk',
      timeoutMs: 120_000,
      sessionId: 3,
      pageIndex: 0,
      httpGet,
    });
    expect(page.html).toContain('product-review-wrapper');
    expect(page.credits).toBe(25);
    expect(seenTimeout).toBe(120_000);
    expect(seenHeaders['Authorization']).toBe('Bearer secret-test-key');
    expect(seenHref).not.toContain('secret-test-key');
    expect(seenHref).not.toMatch(/api_key=/i);
    expect(new URL(seenHref).searchParams.get('timeout')).toBe('120000');
  });

  it('maps HTTP 401 to credentials and AbortError to ScrapingBeeHttpError', async () => {
    await expect(
      fetchScrapingBeeHtmlPage({
        apiKey: 'k',
        targetUrl: PRODUCT_URL,
        countryCode: 'hk',
        timeoutMs: 120_000,
        sessionId: 1,
        pageIndex: 0,
        httpGet: async () => ({
          status: 401,
          headers: new Headers(),
          bodyText: 'unauthorized',
        }),
      }),
    ).rejects.toBeInstanceOf(ScrapingBeeCredentialsError);

    const abort = new Error('aborted');
    abort.name = 'AbortError';
    await expect(
      fetchScrapingBeeHtmlPage({
        apiKey: 'k',
        targetUrl: PRODUCT_URL,
        countryCode: 'hk',
        timeoutMs: 120_000,
        sessionId: 1,
        pageIndex: 0,
        httpGet: async () => {
          throw abort;
        },
      }),
    ).rejects.toBeInstanceOf(ScrapingBeeHttpError);
  });

  it('maps js_scenario_report failures and pollinator timeouts', async () => {
    await expect(
      fetchScrapingBeeHtmlPage({
        apiKey: 'k',
        targetUrl: PRODUCT_URL,
        countryCode: 'hk',
        timeoutMs: 120_000,
        sessionId: 1,
        pageIndex: 0,
        httpGet: async () => ({
          status: 200,
          headers: new Headers(),
          bodyText: envelope('<html/>', {
            js_scenario_report: {
              task_failure: 1,
              task_success: 0,
              tasks: [
                {
                  success: false,
                  task: 'click',
                  params: '[data-tab=reviewTab]',
                },
              ],
            },
          }),
        }),
      }),
    ).rejects.toBeInstanceOf(ReviewTabNotFoundError);

    await expect(
      fetchScrapingBeeHtmlPage({
        apiKey: 'k',
        targetUrl: PRODUCT_URL,
        countryCode: 'hk',
        timeoutMs: 120_000,
        sessionId: 1,
        pageIndex: 0,
        httpGet: async () => ({
          status: 200,
          headers: new Headers(),
          bodyText: envelope('<html/>', {
            js_scenario_report: {
              task_failure: 1,
              tasks: [
                {
                  success: false,
                  task: 'wait_for',
                  params: 'div.product-review-wrapper',
                },
              ],
            },
          }),
        }),
      }),
    ).rejects.toBeInstanceOf(UnhydratedReviewPageError);

    await expect(
      fetchScrapingBeeHtmlPage({
        apiKey: 'k',
        targetUrl: PRODUCT_URL,
        countryCode: 'hk',
        timeoutMs: 120_000,
        sessionId: 1,
        pageIndex: 0,
        httpGet: async () => ({
          status: 500,
          headers: new Headers({ 'Spb-request-id': 'req-1' }),
          bodyText: 'pollinator function has timed-out',
        }),
      }),
    ).rejects.toBeInstanceOf(ScrapingBeeJsScenarioError);
  });
});
