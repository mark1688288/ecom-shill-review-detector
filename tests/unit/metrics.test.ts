// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BigQuery } from '@google-cloud/bigquery';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { extractJobId, quotedJobsByProject, type BqConfig } from '../../src/shared/bq.js';
import {
  FUNNEL_STAGE2_OF_RAW_LOOSE,
  FUNNEL_STAGE2_OF_RAW_TIGHT,
  buildJobBytesSql,
  classifyFunnelTightness,
  geminiErrorRate,
  isJobsByProjectQuery,
  logFunnelTightness,
  logJobBytes,
  logPipelineCounters,
  parseBqBoolean,
  parseBqNumber,
  runQueryLogged,
  summarizeGeminiCostUsd,
} from '../../src/shared/metrics.js';

const CONFIG: BqConfig = {
  project: 'demo-project',
  location: 'europe-west1',
  dataset: 'ecom_shill',
};

type LogEvent = Record<string, unknown>;

function memoryLogger(): { logger: Logger; events: LogEvent[] } {
  const events: LogEvent[] = [];
  const push = (obj: object) => {
    events.push(obj as LogEvent);
  };
  const logger = {
    info: push,
    warn: push,
    error: push,
    debug: push,
  } as unknown as Logger;
  return { logger, events };
}

describe('parseBqNumber / parseBqBoolean', () => {
  it('unwraps BigQuery integer wrappers and strings', () => {
    expect(parseBqNumber(12)).toBe(12);
    expect(parseBqNumber('34')).toBe(34);
    expect(parseBqNumber({ value: '56' })).toBe(56);
    expect(parseBqNumber(null)).toBeNull();
    expect(parseBqNumber(undefined)).toBeNull();
    expect(parseBqNumber(true)).toBeNull();
  });

  it('parses booleans including wrappers', () => {
    expect(parseBqBoolean(true)).toBe(true);
    expect(parseBqBoolean('FALSE')).toBe(false);
    expect(parseBqBoolean({ value: false })).toBe(false);
    expect(parseBqBoolean(1)).toBeNull();
  });
});

describe('funnel tightness (informational, not CI SLA)', () => {
  it('classifies >0.15 as loose, <0.01 as tight, and the edges as ok', () => {
    expect(FUNNEL_STAGE2_OF_RAW_LOOSE).toBe(0.15);
    expect(FUNNEL_STAGE2_OF_RAW_TIGHT).toBe(0.01);
    expect(classifyFunnelTightness(0.16)).toBe('loose');
    expect(classifyFunnelTightness(0.15)).toBe('ok');
    expect(classifyFunnelTightness(0.05)).toBe('ok');
    expect(classifyFunnelTightness(0.01)).toBe('ok');
    expect(classifyFunnelTightness(0.009)).toBe('tight');
    expect(classifyFunnelTightness(null)).toBe('unknown');
  });

  it('warns on loose/tight and is silent on ok/unknown', () => {
    const loose = memoryLogger();
    expect(
      logFunnelTightness(loose.logger, {
        pipeline_run_id: 'run-1',
        pct_stage2_of_raw: 0.2,
        n_raw: 100,
        n_stage2: 20,
      }),
    ).toBe('loose');
    expect(loose.events).toEqual([
      expect.objectContaining({
        event: 'funnel_stage2_loose',
        pipeline_run_id: 'run-1',
        pct_stage2_of_raw: 0.2,
        n_raw: 100,
        n_stage2: 20,
      }),
    ]);

    const ok = memoryLogger();
    expect(
      logFunnelTightness(ok.logger, { pipeline_run_id: 'run-1', pct_stage2_of_raw: 0.05 }),
    ).toBe('ok');
    expect(ok.events).toEqual([]);

    const unknown = memoryLogger();
    expect(
      logFunnelTightness(unknown.logger, { pipeline_run_id: 'run-1', pct_stage2_of_raw: null }),
    ).toBe('unknown');
    expect(unknown.events).toEqual([]);
  });
});

describe('process counters', () => {
  it('computes error rate and refuses cost when thinking is on or any estimate is missing', () => {
    expect(geminiErrorRate(0, 0)).toBe(0);
    expect(geminiErrorRate(2, 8)).toBe(0.25);
    expect(summarizeGeminiCostUsd({ thinkingNotOff: true, estimates: [0.1] })).toBeNull();
    expect(summarizeGeminiCostUsd({ thinkingNotOff: false, estimates: [] })).toBeNull();
    expect(summarizeGeminiCostUsd({ thinkingNotOff: false, estimates: [0.1, null] })).toBeNull();
    expect(summarizeGeminiCostUsd({ thinkingNotOff: false, estimates: [0.1, 0.2] })).toBeCloseTo(0.3);
  });

  it('logs pipeline_counters once', () => {
    const { logger, events } = memoryLogger();
    logPipelineCounters(logger, 'run-1', {
      gemini_cost_usd_est: 0.00468,
      gemini_error_rate: 0,
      signal_span_mismatch_total: 3,
    });
    expect(events).toEqual([
      {
        event: 'pipeline_counters',
        pipeline_run_id: 'run-1',
        gemini_cost_usd_est: 0.00468,
        gemini_error_rate: 0,
        signal_span_mismatch_total: 3,
      },
    ]);
  });
});

describe('job-bytes INFORMATION_SCHEMA', () => {
  it('uses region-${GCP_LOCATION} and does not hardcode asia-east1', () => {
    const sql = buildJobBytesSql(CONFIG);
    expect(quotedJobsByProject(CONFIG)).toBe(
      '`demo-project.region-europe-west1.INFORMATION_SCHEMA.JOBS_BY_PROJECT`',
    );
    expect(sql).toContain('total_bytes_processed');
    expect(sql).toContain('total_slot_ms');
    expect(sql).toContain('cache_hit');
    expect(sql).toContain('region-europe-west1');
    expect(sql).not.toContain('asia-east1');
    expect(isJobsByProjectQuery(sql)).toBe(true);
  });

  it('logs bq_job_bytes from JOBS_BY_PROJECT and does not recurse', async () => {
    const { logger, events } = memoryLogger();
    const calls: string[] = [];
    const bq = {
      query: async (options: { query: string; params?: Record<string, unknown> }) => {
        calls.push(options.query);
        expect(options.params?.['job_id']).toBe('job-abc');
        expect(options.query).toContain('region-europe-west1');
        return [
          [
            {
              total_bytes_processed: 4096,
              total_slot_ms: 12,
              cache_hit: false,
            },
          ],
        ];
      },
    } as unknown as BigQuery;

    const logged = await logJobBytes(bq, CONFIG, 'job-abc', logger);
    expect(logged).toEqual({
      total_bytes_processed: 4096,
      total_slot_ms: 12,
      cache_hit: false,
    });
    expect(calls).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'bq_job_bytes',
      job_id: 'job-abc',
      bq_job_bytes: 4096,
      total_slot_ms: 12,
      cache_hit: false,
    });
  });

  it('logs bytes after a query when the job id is present, and skips JOBS_BY_PROJECT queries', async () => {
    const { logger, events } = memoryLogger();
    const calls: string[] = [];
    const bq = {
      query: async (options: { query: string }) => {
        calls.push(options.query);
        if (options.query.includes('INFORMATION_SCHEMA.JOBS_BY_PROJECT')) {
          return [[{ total_bytes_processed: 99, total_slot_ms: 1, cache_hit: true }]];
        }
        return [[{ n: 1 }], { id: 'job-xyz' }];
      },
    } as unknown as BigQuery;

    const rows = await runQueryLogged(bq, CONFIG, 'SELECT 1 AS n', undefined, logger);
    expect(rows).toEqual([{ n: 1 }]);
    expect(calls).toHaveLength(2);
    expect(events).toEqual([
      expect.objectContaining({ event: 'bq_job_bytes', job_id: 'job-xyz', bq_job_bytes: 99 }),
    ]);

    const before = calls.length;
    await runQueryLogged(bq, CONFIG, buildJobBytesSql(CONFIG), { job_id: 'job-xyz' }, logger);
    expect(calls.length).toBe(before + 1);
  });

  it('skips logging when the client does not return a job id', async () => {
    const { logger, events } = memoryLogger();
    const bq = {
      query: async () => [[{ n: 1 }]],
    } as unknown as BigQuery;
    await runQueryLogged(bq, CONFIG, 'SELECT 1', undefined, logger);
    expect(events).toEqual([]);
  });

  it('extracts job ids from Job objects and jobReference', () => {
    expect(extractJobId(undefined)).toBeUndefined();
    expect(extractJobId({ id: 'job-1' })).toBe('job-1');
    expect(extractJobId({ jobReference: { jobId: 'job-2' } })).toBe('job-2');
    expect(extractJobId({ metadata: { jobReference: { jobId: 'job-3' } } })).toBe('job-3');
  });
});

describe('CI fixture regression contracts', () => {
  it('README walkthrough is fixture-first and does not claim CI verifies SQL or 35%/5%', () => {
    const readme = readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    expect(readme).toContain('pnpm cli -- crawl --adapter fixture');
    expect(readme).toContain('--dry-run');
    expect(readme).toContain('pnpm cli -- load --ndjson');
    expect(readme).toContain('pnpm cli -- layer1 --continue-latest');
    expect(readme).toContain('pnpm cli -- layer2 --continue-latest');
    expect(readme).toContain('pnpm cli -- audit --continue-latest');
    expect(readme).toContain('pnpm cli -- analyze --continue-latest');
    expect(readme).toContain('pnpm cli -- report --continue-latest');
    expect(readme).toContain('region-${GCP_LOCATION}');
    expect(readme).toMatch(/不.*驗證 SQL 語意/);
    expect(readme).toMatch(/不斷言.*35%\/5%/);
    expect(readme).not.toMatch(/CI 驗證了 SQL/);
  });

  it('CI runs fixture crawl dry-run and does not set GCP_PROJECT', () => {
    const ci = readFileSync(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    expect(ci).toContain(
      'pnpm cli -- crawl --adapter fixture --input fixtures/reviews/cantonese-mix.jsonl --dry-run',
    );
    expect(ci).not.toMatch(/GCP_PROJECT/);
    expect(ci).not.toMatch(/ML\.GENERATE_EMBEDDING/);
  });
});
