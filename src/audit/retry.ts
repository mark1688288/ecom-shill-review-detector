// SPDX-License-Identifier: GPL-3.0-only

export const MAX_GEMINI_ATTEMPTS = 6;

export type GeminiErrorClass = 'rate_limit' | 'server' | 'schema' | 'timeout' | 'unknown';

export type ClassifiedGeminiError = {
  retryable: boolean;
  errorClass: GeminiErrorClass;
  httpStatus?: number;
  retryAfterMs?: number;
  message: string;
};

export class GeminiCallError extends Error {
  readonly classified: ClassifiedGeminiError;

  constructor(classified: ClassifiedGeminiError) {
    super(classified.message);
    this.name = 'GeminiCallError';
    this.classified = classified;
  }
}

function headerMap(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') {
    return {};
  }
  if (typeof (value as { get?: unknown }).get === 'function') {
    const get = (value as { get: (name: string) => string | null }).get;
    const retryAfter = get.call(value, 'retry-after') ?? get.call(value, 'Retry-After');
    return retryAfter === null ? {} : { 'retry-after': retryAfter };
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') {
      out[key.toLowerCase()] = item;
    } else if (typeof item === 'number') {
      out[key.toLowerCase()] = String(item);
    } else if (Array.isArray(item) && typeof item[0] === 'string') {
      out[key.toLowerCase()] = item[0];
    }
  }
  return out;
}

function readHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const rec = err as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'httpStatus', 'code']) {
    const value = rec[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      return Number(value);
    }
  }
  if (typeof rec['cause'] !== 'undefined') {
    return readHttpStatus(rec['cause']);
  }
  return undefined;
}

function readRetryAfterMs(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const rec = err as Record<string, unknown>;
  const headers = headerMap(rec['headers']);
  const raw = headers['retry-after'];
  if (raw === undefined) {
    return undefined;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return seconds * 1000;
}

function isTimeout(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const rec = err as { name?: unknown; message?: unknown; code?: unknown };
  const name = typeof rec.name === 'string' ? rec.name : '';
  const message = typeof rec.message === 'string' ? rec.message : '';
  const code = typeof rec.code === 'string' ? rec.code : '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    return true;
  }
  return /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed/i.test(`${message} ${code}`);
}

export function classifyGeminiError(err: unknown): ClassifiedGeminiError {
  if (err instanceof GeminiCallError) {
    return err.classified;
  }
  const message = err instanceof Error ? err.message : String(err);
  const httpStatus = readHttpStatus(err);
  const retryAfterMs = readRetryAfterMs(err);
  if (httpStatus === 429) {
    const classified: ClassifiedGeminiError = {
      retryable: true,
      errorClass: 'rate_limit',
      httpStatus,
      message,
    };
    if (retryAfterMs !== undefined) {
      classified.retryAfterMs = retryAfterMs;
    }
    return classified;
  }
  if (httpStatus !== undefined && httpStatus >= 500 && httpStatus <= 504) {
    return { retryable: true, errorClass: 'server', httpStatus, message };
  }
  if (httpStatus === 400) {
    return { retryable: false, errorClass: 'unknown', httpStatus, message };
  }
  if (isTimeout(err)) {
    return { retryable: true, errorClass: 'timeout', message };
  }
  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
    return { retryable: false, errorClass: 'unknown', httpStatus, message };
  }
  return { retryable: true, errorClass: 'unknown', message };
}

export function retryDelayMs(
  attemptIndex: number,
  random: () => number = Math.random,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }
  const exp = Math.min(30_000, 500 * 2 ** attemptIndex);
  const jitter = Math.floor(random() * 251);
  return exp + jitter;
}

export type WithRetryOptions = {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxAttempts?: number;
};

const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
};

export async function withRetry<T>(fn: () => Promise<T>, opts: WithRetryOptions = {}): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const maxAttempts = opts.maxAttempts ?? MAX_GEMINI_ATTEMPTS;
  let last: ClassifiedGeminiError | undefined;
  for (let k = 0; k < maxAttempts; k += 1) {
    try {
      return await fn();
    } catch (err) {
      last = classifyGeminiError(err);
      if (!last.retryable || k === maxAttempts - 1) {
        throw new GeminiCallError(last);
      }
      await sleep(retryDelayMs(k, random, last.retryAfterMs));
    }
  }
  throw new GeminiCallError(
    last ?? { retryable: false, errorClass: 'unknown', message: 'retry exhausted' },
  );
}
