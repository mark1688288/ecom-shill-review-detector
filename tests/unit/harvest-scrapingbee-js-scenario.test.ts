// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { HarvestUsageError } from '../../src/crawler/harvest/errors.js';
import {
  buildHktvmallReviewJsScenario,
  HKTVMALL_SB_REVIEW_TAB_CSS,
  HKTVMALL_SB_WRAPPER_CSS,
  SCRAPINGBEE_MAX_HREF_CHARS,
  SCRAPINGBEE_PAGER_WAIT_MS,
} from '../../src/crawler/harvest/scrapingbee-js-scenario.js';
import { buildScrapingBeeHtmlApiHref } from '../../src/crawler/harvest/scrapingbee-client.js';

const PRODUCT_URL =
  'https://www.hktvmall.com/hktv/zh/main/Store-Name-With-Several-Category-Words/s/S2090001/supermarket/long-category-path/p/S2090001_S_4000412';

function evaluateOf(scenario: { instructions: unknown[] }): string {
  for (const step of scenario.instructions) {
    if (typeof step === 'object' && step !== null && 'evaluate' in step) {
      const value = (step as { evaluate: unknown }).evaluate;
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  throw new Error('missing evaluate instruction');
}

function clickTargets(scenario: { instructions: unknown[] }): string[] {
  const targets: string[] = [];
  for (const step of scenario.instructions) {
    if (typeof step !== 'object' || step === null) {
      continue;
    }
    const rec = step as Record<string, unknown>;
    for (const key of ['click', 'wait_for_and_click'] as const) {
      const value = rec[key];
      if (typeof value === 'string') {
        targets.push(value);
      }
    }
  }
  return targets;
}

describe('buildHktvmallReviewJsScenario', () => {
  it('round-trips through JSON.stringify as legal JSON', () => {
    const scenario = buildHktvmallReviewJsScenario(0);
    expect(() => JSON.parse(JSON.stringify(scenario)) as unknown).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(scenario)) as {
      strict: boolean;
      instructions: unknown[];
    };
    expect(parsed.strict).toBe(true);
    expect(parsed.instructions).toHaveLength(6);
  });

  it('evaluate source has no backslash and locates pager via span.total', () => {
    const evaluate = evaluateOf(buildHktvmallReviewJsScenario(1));
    expect(evaluate.includes('\\')).toBe(false);
    expect(evaluate).toContain("getElementsByClassName('total')");
    expect(evaluate).not.toContain("document.querySelector('select')");
    expect(evaluate).toContain("s.value='1'");
    expect(evaluate).not.toContain("s.value='2'");
    expect(evaluate).not.toContain('\\d');
  });

  it('does not click next-btn and does not include extract_rules or screenshot', () => {
    const scenario = buildHktvmallReviewJsScenario(0);
    expect(clickTargets(scenario).some((sel) => sel.includes('next-btn'))).toBe(false);
    const json = JSON.stringify(scenario);
    expect(json).not.toContain('extract_rules');
    expect(json).not.toContain('screenshot');
    expect(json).not.toContain('\\d');
    expect(json).toContain(HKTVMALL_SB_REVIEW_TAB_CSS);
    expect(json).toContain(HKTVMALL_SB_WRAPPER_CSS);
    expect(json).toContain(String(SCRAPINGBEE_PAGER_WAIT_MS));
  });

  it('rejects non-integer pageIndex', () => {
    expect(() => buildHktvmallReviewJsScenario(-1)).toThrow(HarvestUsageError);
    expect(() => buildHktvmallReviewJsScenario(1.5)).toThrow(HarvestUsageError);
  });

  it('keeps a typical product URL plus scenario well under the GET href budget', () => {
    const href = buildScrapingBeeHtmlApiHref({
      targetUrl: PRODUCT_URL,
      countryCode: 'hk',
      timeoutMs: 120_000,
      sessionId: 42,
      jsScenario: buildHktvmallReviewJsScenario(0),
    });
    expect(href.length).toBeLessThan(SCRAPINGBEE_MAX_HREF_CHARS);
  });
});
