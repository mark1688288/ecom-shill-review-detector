// SPDX-License-Identifier: GPL-3.0-only

export class HarvestUsageError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'HarvestUsageError';
    this.exitCode = exitCode;
  }
}

export class HarvestTosRequiredError extends Error {
  readonly exitCode = 1;

  constructor() {
    super(
      'harvest requires --i-accept-tos (operator must evaluate target ToS / robots / local law). Live harvest uses a third-party browser or HTML API against a public product page.',
    );
    this.name = 'HarvestTosRequiredError';
  }
}

export class PlaywrightModuleMissingError extends Error {
  readonly exitCode = 1;

  constructor() {
    super(
      'playwright-core is missing; run pnpm install (optionalDependency). --no-optional is unsupported for typecheck and live harvest.',
    );
    this.name = 'PlaywrightModuleMissingError';
  }
}

export class HktvmallUrlParseError extends Error {
  readonly exitCode = 1;
  readonly url: string;

  constructor(url: string) {
    super(
      `Not a public HKTVmall zh product URL (exact host www.hktvmall.com|hktvmall.com, pathname must contain /hktv/zh/ and /s/{store}/…/p/{sku}/): ${url}`,
    );
    this.name = 'HktvmallUrlParseError';
    this.url = url;
  }
}

export class BrightDataConnectError extends Error {
  readonly exitCode = 1;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Bright Data Browser API connectOverCDP failed: ${detail}`);
    this.name = 'BrightDataConnectError';
  }
}

export class GotoTimeoutError extends Error {
  readonly exitCode = 1;

  constructor(url: string, timeoutMs: number) {
    super(
      `Navigation timed out after ${String(timeoutMs)}ms (waitUntil=domcontentloaded): ${url}`,
    );
    this.name = 'GotoTimeoutError';
  }
}

export class ReviewTabNotFoundError extends Error {
  readonly exitCode = 1;

  constructor() {
    super(
      'Could not click the HKTVmall review tab ([data-tab="reviewTab"] / heading 評論). Cookie overlay and locator timeout map to this error.',
    );
    this.name = 'ReviewTabNotFoundError';
  }
}

export class UnhydratedReviewPageError extends Error {
  readonly exitCode = 1;
  readonly wait_ms: number;

  constructor(waitMs: number) {
    super(
      `No div.product-review-wrapper after clicking the review tab (waited ${String(waitMs)}ms)`,
    );
    this.name = 'UnhydratedReviewPageError';
    this.wait_ms = waitMs;
  }
}

export class HarvestEmptyAcceptedError extends Error {
  readonly exitCode = 1;

  constructor() {
    super('Harvest parsed wrappers but accepted 0 reviews');
    this.name = 'HarvestEmptyAcceptedError';
  }
}

export class HarvestSessionDroppedError extends Error {
  readonly exitCode = 1;

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Bright Data Browser API session dropped (CDP target closed or disconnected): ${detail}`);
    this.name = 'HarvestSessionDroppedError';
  }
}

export class ScrapingBeeHttpError extends Error {
  readonly exitCode = 1;
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ScrapingBeeHttpError';
    if (status !== undefined) {
      this.status = status;
    }
  }
}

export class ScrapingBeeJsScenarioError extends Error {
  readonly exitCode = 1;

  constructor(message = 'ScrapingBee js_scenario failed') {
    super(message);
    this.name = 'ScrapingBeeJsScenarioError';
  }
}

export function isTimeoutError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'TimeoutError';
}

export function harvestErrorExitCode(err: unknown): number {
  if (typeof err === 'object' && err !== null && 'exitCode' in err) {
    const code = (err as { exitCode: unknown }).exitCode;
    if (typeof code === 'number' && Number.isInteger(code)) {
      return code;
    }
  }
  return 1;
}
