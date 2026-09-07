// SPDX-License-Identifier: GPL-3.0-only
import type { Browser, Locator, Page } from 'playwright-core';
import { BrightDataCredentialsError } from '../../shared/env.js';
import {
  BrightDataConnectError,
  GotoTimeoutError,
  HarvestSessionDroppedError,
  PlaywrightModuleMissingError,
  isTimeoutError,
} from '../harvest/errors.js';
import type { HarvestLocator, HarvestPage } from '../harvest/harvest-page.js';

const COUNTRY_SUFFIX_RE = /-country-[a-z]{2}$/i;
const CONNECT_TIMEOUT_MS = 120_000;

/** String page function so tsc (lib ES2022 / types node) never sees `document`. */
const WAIT_NEW_REVIEW_IDS = `(prev) => {
  const nodes = document.querySelectorAll('div.product-review-wrapper[data-reviewid]');
  const ids = [];
  for (const el of nodes) {
    const id = el.getAttribute('data-reviewid');
    if (id) ids.push(id);
  }
  return ids.some((id) => !prev.includes(id));
}`;

export function buildBrowserWsEndpoint(opts: {
  username: string;
  password: string;
  country: string;
}): string {
  if (COUNTRY_SUFFIX_RE.test(opts.username)) {
    throw new BrightDataCredentialsError(
      'BRIGHTDATA_BROWSERAPI_USERNAME must not already end in -country-xx; remove the country suffix from the env username; harvest appends -country-<iso>',
    );
  }
  const iso = opts.country.trim().toLowerCase();
  const user = `${opts.username}-country-${iso}`;
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(opts.password)}`;
  return `wss://${auth}@brd.superproxy.io:9222`;
}

class PlaywrightLocatorAdapter implements HarvestLocator {
  constructor(private readonly loc: Locator) {}

  first(): HarvestLocator {
    return new PlaywrightLocatorAdapter(this.loc.first());
  }

  visible(): HarvestLocator {
    return new PlaywrightLocatorAdapter(this.loc.filter({ visible: true }));
  }

  async click(opts?: { timeout?: number; force?: boolean }): Promise<void> {
    try {
      const pwOpts: { timeout?: number; force?: boolean } = {};
      if (opts?.timeout !== undefined) {
        pwOpts.timeout = opts.timeout;
      }
      if (opts?.force !== undefined) {
        pwOpts.force = opts.force;
      }
      if (Object.keys(pwOpts).length === 0) {
        await this.loc.click();
      } else {
        await this.loc.click(pwOpts);
      }
    } catch (err) {
      if (isTimeoutError(err)) {
        throw err;
      }
      throw new HarvestSessionDroppedError(err);
    }
  }

  async count(): Promise<number> {
    try {
      return await this.loc.count();
    } catch (err) {
      if (isTimeoutError(err)) {
        throw err;
      }
      throw new HarvestSessionDroppedError(err);
    }
  }

  async getAttribute(name: string): Promise<string | null> {
    try {
      return await this.loc.getAttribute(name);
    } catch (err) {
      if (isTimeoutError(err)) {
        throw err;
      }
      throw new HarvestSessionDroppedError(err);
    }
  }
}

class PlaywrightPageAdapter implements HarvestPage {
  constructor(private readonly pwPage: Page) {}

  async goto(
    url: string,
    opts: { timeout: number; waitUntil: 'domcontentloaded' },
  ): Promise<unknown> {
    try {
      return await this.pwPage.goto(url, { timeout: opts.timeout, waitUntil: opts.waitUntil });
    } catch (err) {
      if (isTimeoutError(err)) {
        throw new GotoTimeoutError(url, opts.timeout);
      }
      throw new HarvestSessionDroppedError(err);
    }
  }

  locator(selector: string): HarvestLocator {
    return new PlaywrightLocatorAdapter(this.pwPage.locator(selector));
  }

  getByRole(
    role: 'link' | 'button' | 'heading',
    opts?: { name?: string | RegExp },
  ): HarvestLocator {
    if (opts?.name === undefined) {
      return new PlaywrightLocatorAdapter(this.pwPage.getByRole(role));
    }
    return new PlaywrightLocatorAdapter(this.pwPage.getByRole(role, { name: opts.name }));
  }

  getByText(text: string | RegExp, opts?: { exact?: boolean }): HarvestLocator {
    if (opts?.exact === undefined) {
      return new PlaywrightLocatorAdapter(this.pwPage.getByText(text));
    }
    return new PlaywrightLocatorAdapter(this.pwPage.getByText(text, { exact: opts.exact }));
  }

  async waitForSelector(selector: string, opts?: { timeout?: number }): Promise<unknown> {
    try {
      if (opts?.timeout === undefined) {
        return await this.pwPage.waitForSelector(selector);
      }
      return await this.pwPage.waitForSelector(selector, { timeout: opts.timeout });
    } catch (err) {
      if (isTimeoutError(err)) {
        throw err;
      }
      throw new HarvestSessionDroppedError(err);
    }
  }

  async waitForNewReviewIds(prevIds: string[], timeoutMs: number): Promise<boolean> {
    try {
      await this.pwPage.waitForFunction(WAIT_NEW_REVIEW_IDS as never, prevIds, {
        timeout: timeoutMs,
      });
      return true;
    } catch (err) {
      if (isTimeoutError(err)) {
        return false;
      }
      throw new HarvestSessionDroppedError(err);
    }
  }

  async content(): Promise<string> {
    try {
      return await this.pwPage.content();
    } catch (err) {
      if (isTimeoutError(err)) {
        throw err;
      }
      throw new HarvestSessionDroppedError(err);
    }
  }

  async innerText(selector: string): Promise<string> {
    try {
      return await this.pwPage.locator(selector).innerText();
    } catch (err) {
      if (isTimeoutError(err)) {
        throw err;
      }
      throw new HarvestSessionDroppedError(err);
    }
  }

  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    try {
      await this.pwPage.setViewportSize(size);
    } catch (err) {
      if (isTimeoutError(err)) {
        throw err;
      }
      throw new HarvestSessionDroppedError(err);
    }
  }
}

export function adaptPlaywrightPage(pwPage: Page): HarvestPage {
  return new PlaywrightPageAdapter(pwPage);
}

export async function connectHktvmallBrowser(opts: {
  username: string;
  password: string;
  country: string;
}): Promise<{
  browser: Browser;
  page: HarvestPage;
  close: () => Promise<void>;
}> {
  const ws = buildBrowserWsEndpoint(opts);
  const playwright = await import('playwright-core').catch(() => {
    throw new PlaywrightModuleMissingError();
  });
  let browser: Browser;
  try {
    browser = await playwright.chromium.connectOverCDP(ws, { timeout: CONNECT_TIMEOUT_MS });
  } catch (err) {
    throw new BrightDataConnectError(err);
  }
  try {
    const existingContext = browser.contexts()[0];
    const context = existingContext ?? (await browser.newContext());
    const existingPage = context.pages()[0];
    const pwPage = existingPage ?? (await context.newPage());
    return {
      browser,
      page: adaptPlaywrightPage(pwPage),
      close: async () => {
        await browser.close();
      },
    };
  } catch (err) {
    try {
      await browser.close();
    } catch {
      // Session must not leak if default-page setup fails.
    }
    if (err instanceof HarvestSessionDroppedError || err instanceof BrightDataConnectError) {
      throw err;
    }
    throw new BrightDataConnectError(err);
  }
}
