// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { adaptPlaywrightPage, buildBrowserWsEndpoint } from '../../src/crawler/browser/brightdata-cdp.js';
import { HarvestSessionDroppedError } from '../../src/crawler/harvest/errors.js';
import { BrightDataCredentialsError } from '../../src/shared/env.js';

describe('buildBrowserWsEndpoint', () => {
  it('appends -country-hk and encodes user/pass', () => {
    const ws = buildBrowserWsEndpoint({
      username: 'brd-customer-x-zone-y',
      password: 'p@ss:word',
      country: 'HK',
    });
    expect(ws.startsWith('wss://')).toBe(true);
    expect(ws.endsWith('@brd.superproxy.io:9222')).toBe(true);
    expect(ws).toContain(encodeURIComponent('brd-customer-x-zone-y-country-hk'));
    expect(ws).toContain(encodeURIComponent('p@ss:word'));
    expect(ws).not.toContain('p@ss:word@');
  });

  it('rejects a username that already has a country suffix', () => {
    expect(() =>
      buildBrowserWsEndpoint({
        username: 'user-country-us',
        password: 'secret',
        country: 'HK',
      }),
    ).toThrow(BrightDataCredentialsError);
  });
});

describe('adaptPlaywrightPage.click', () => {
  it('passes force through to Playwright locator.click', async () => {
    const calls: unknown[] = [];
    const page = adaptPlaywrightPage({
      locator: () => ({
        click: async (opts?: unknown) => {
          calls.push(opts);
        },
      }),
    } as never);
    await page.locator('[data-tab="reviewTab"]').click({ timeout: 30_000, force: true });
    expect(calls).toEqual([{ timeout: 30_000, force: true }]);
  });

  it('falls back to dispatchEvent click when the element is outside the viewport', async () => {
    const events: string[] = [];
    const page = adaptPlaywrightPage({
      locator: () => ({
        click: async () => {
          throw new Error(
            'locator.click: Element is outside of the viewport\nCall log:\n  - scrolling into view if needed',
          );
        },
        dispatchEvent: async (type: string) => {
          events.push(type);
        },
      }),
    } as never);
    await expect(
      page.locator('a').click({ timeout: 30_000, force: true }),
    ).resolves.toBeUndefined();
    expect(events).toEqual(['click']);
  });

  it('does not wrap outside-of-viewport as HarvestSessionDroppedError after a successful DOM click', async () => {
    const page = adaptPlaywrightPage({
      locator: () => ({
        click: async () => {
          throw new Error('Element is outside of the viewport');
        },
        dispatchEvent: async () => undefined,
      }),
    } as never);
    await expect(page.locator('a').click({ force: true })).resolves.toBeUndefined();
  });

  it('still throws HarvestSessionDroppedError on target closed', async () => {
    const page = adaptPlaywrightPage({
      locator: () => ({
        click: async () => {
          throw new Error('Target closed');
        },
        dispatchEvent: async () => {
          throw new Error('dispatchEvent should not run');
        },
      }),
    } as never);
    await expect(page.locator('a').click({ force: true })).rejects.toBeInstanceOf(
      HarvestSessionDroppedError,
    );
  });

  it('wraps a failed DOM-click fallback as HarvestSessionDroppedError', async () => {
    const page = adaptPlaywrightPage({
      locator: () => ({
        click: async () => {
          throw new Error('Element is outside of the viewport');
        },
        dispatchEvent: async () => {
          throw new Error('Target closed');
        },
      }),
    } as never);
    await expect(page.locator('a').click({ force: true })).rejects.toBeInstanceOf(
      HarvestSessionDroppedError,
    );
  });
});

describe('adaptPlaywrightPage.waitForNewReviewIds', () => {
  it('returns false on Playwright TimeoutError only', async () => {
    const page = adaptPlaywrightPage({
      waitForFunction: async () => {
        const err = new Error('Timeout 15000ms exceeded');
        err.name = 'TimeoutError';
        throw err;
      },
    } as never);
    await expect(page.waitForNewReviewIds(['a'], 15_000)).resolves.toBe(false);
  });

  it('throws HarvestSessionDroppedError on target closed (must not become unchanged_ids)', async () => {
    const page = adaptPlaywrightPage({
      waitForFunction: async () => {
        throw new Error('Target closed');
      },
    } as never);
    await expect(page.waitForNewReviewIds(['a'], 15_000)).rejects.toBeInstanceOf(
      HarvestSessionDroppedError,
    );
  });
});
