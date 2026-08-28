// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  GeminiCallError,
  classifyGeminiError,
  retryDelayMs,
  withRetry,
} from '../../src/audit/retry.js';

describe('retryDelayMs', () => {
  it('uses min(30000, 500 * 2^k) plus jitter for k=0..5', () => {
    const random = (): number => 0;
    expect(retryDelayMs(0, random)).toBe(500);
    expect(retryDelayMs(1, random)).toBe(1000);
    expect(retryDelayMs(2, random)).toBe(2000);
    expect(retryDelayMs(5, random)).toBe(16000);
    expect(retryDelayMs(10, random)).toBe(30000);
    expect(retryDelayMs(0, () => 0.999)).toBe(500 + 250);
  });

  it('honors Retry-After seconds over exponential backoff', () => {
    expect(retryDelayMs(0, () => 0, 12_000)).toBe(12_000);
  });
});

describe('classifyGeminiError', () => {
  it('retries 429, 500-504, and timeouts; does not retry 400', () => {
    expect(classifyGeminiError({ status: 429, message: 'slow down' })).toMatchObject({
      retryable: true,
      errorClass: 'rate_limit',
      httpStatus: 429,
    });
    expect(classifyGeminiError({ status: 503, message: 'unavailable' })).toMatchObject({
      retryable: true,
      errorClass: 'server',
    });
    expect(classifyGeminiError(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))).toMatchObject({
      retryable: true,
      errorClass: 'timeout',
    });
    expect(classifyGeminiError({ status: 400, message: 'safety' })).toMatchObject({
      retryable: false,
      errorClass: 'unknown',
      httpStatus: 400,
    });
  });

  it('reads Retry-After from headers', () => {
    const classified = classifyGeminiError({
      status: 429,
      message: 'rate',
      headers: { 'Retry-After': '3' },
    });
    expect(classified.retryAfterMs).toBe(3000);
  });
});

describe('withRetry', () => {
  it('retries a 429 then succeeds', async () => {
    const delays: number[] = [];
    let n = 0;
    const value = await withRetry(
      async () => {
        n += 1;
        if (n === 1) {
          throw { status: 429, message: 'rate' };
        }
        return 'ok';
      },
      {
        sleep: async (ms) => {
          delays.push(ms);
        },
        random: () => 0,
      },
    );
    expect(value).toBe('ok');
    expect(n).toBe(2);
    expect(delays).toEqual([500]);
  });

  it('does not retry HTTP 400', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw { status: 400, message: 'bad schema' };
        },
        { sleep: async () => undefined, random: () => 0 },
      ),
    ).rejects.toBeInstanceOf(GeminiCallError);
    expect(n).toBe(1);
  });

  it('stops after 6 attempts', async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n += 1;
          throw { status: 503, message: 'down' };
        },
        { sleep: async () => undefined, random: () => 0 },
      ),
    ).rejects.toBeInstanceOf(GeminiCallError);
    expect(n).toBe(6);
  });
});
