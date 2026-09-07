// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BigQuery } from '@google-cloud/bigquery';
import { afterEach, describe, expect, it } from 'vitest';
import { SHILL_SCORE_THRESHOLD } from '../../src/analysis/collisions.js';
import {
  ASCII_BAR_WIDTH,
  DISCLAIMER_EN,
  DISCLAIMER_ZH,
  L1_HIST_BUCKETS,
  L3_HIST_BUCKETS,
  binL2Distances,
  binL3Scores,
  fillL1HistogramBuckets,
  formatHistogramPct,
  l2BinEdges,
  renderAsciiBar,
  renderDot,
  renderJson,
  renderMarkdown,
  resolveReportOutputPaths,
  type ReportData,
  type ScoreHistograms,
} from '../../src/analysis/report.js';
import { runReport } from '../../src/cli/commands/report.js';
import { buildProgram } from '../../src/cli/main.js';
import { RunIdError, writeLatestRun } from '../../src/shared/run-id.js';

const SALT = '0123456789abcdef0123456789abcdef';
const RUN = '22222222-2222-4222-8222-222222222222';

function sampleHistograms(): ScoreHistograms {
  const l1 = fillL1HistogramBuckets([
    { bucket: 'non_five_star', n: 8 },
    { bucket: 'too_short', n: 3 },
    { bucket: 'pure_logistics', n: 2 },
    { bucket: 'pass', n: 7 },
  ]);
  const l2 = binL2Distances([0.07, 0.28, 0.2800000001, 1.0, 1.0000001, 2.0], 0.28);
  const l3 = binL3Scores([45, 80]);
  return {
    n_in_scope: 20,
    layer1: {
      metric: 'exclusion_reason',
      buckets: l1.buckets,
      n_rows: 20,
      unknown_n: l1.unknown_n,
      coverage_ok: true,
    },
    layer2: {
      metric: 'min_cosine_distance',
      threshold: 0.28,
      threshold_source: 'pipeline_runs',
      buckets: [...l2.buckets, { bucket: 'no_distance', n: 1 }],
      n_with_distance: 6,
      n_no_distance: 1,
      n_le_threshold: 2,
      n_gt_threshold: 4,
    },
    layer3: {
      metric: 'shill_score',
      threshold: SHILL_SCORE_THRESHOLD,
      buckets: l3.buckets,
      n_assessed: 2,
      n_gemini: 1,
      n_copied: 1,
      n_shill_75: 1,
    },
  };
}

function zeroHistograms(threshold = 0.28): ScoreHistograms {
  const l1 = fillL1HistogramBuckets([]);
  return {
    n_in_scope: 0,
    layer1: {
      metric: 'exclusion_reason',
      buckets: l1.buckets,
      n_rows: 0,
      unknown_n: 0,
      coverage_ok: true,
    },
    layer2: {
      metric: 'min_cosine_distance',
      threshold,
      threshold_source: 'config_fallback',
      buckets: [...binL2Distances([], threshold).buckets, { bucket: 'no_distance', n: 0 }],
      n_with_distance: 0,
      n_no_distance: 0,
      n_le_threshold: 0,
      n_gt_threshold: 0,
    },
    layer3: {
      metric: 'shill_score',
      threshold: SHILL_SCORE_THRESHOLD,
      buckets: binL3Scores([]).buckets,
      n_assessed: 0,
      n_gemini: 0,
      n_copied: 0,
      n_shill_75: 0,
    },
  };
}

const sample: ReportData = {
  pipeline_run_id: RUN,
  funnel: {
    pipeline_run_id: RUN,
    n_raw: 20,
    n_stage1: 7,
    n_stage2: 2,
    n_assessed: 2,
    n_assess_errors: 0,
    pct_stage1: 0.35,
    pct_stage2_of_raw: 0.1,
    pct_stage2_of_stage1: 2 / 7,
  },
  stores: [
    {
      store_id: 'store-a',
      marketplace: 'fixture',
      n_raw: 10,
      n_stage1: 4,
      n_stage2: 1,
      n_assessed: 1,
      n_shill_75: 1,
      pct_shill_75: 1,
      n_template_hit: 1,
      template_hit_rate: 1,
      avg_min_seed_distance: 0.12,
      p50_shill_score: 95,
    },
    {
      store_id: 'store-b',
      marketplace: 'fixture',
      n_raw: 10,
      n_stage1: 3,
      n_stage2: 1,
      n_assessed: 1,
      n_shill_75: 0,
      pct_shill_75: 0,
      n_template_hit: 0,
      template_hit_rate: 0,
      avg_min_seed_distance: 0.25,
      p50_shill_score: 45,
    },
  ],
  bursts: [
    {
      store_id: 'store-a',
      product_id: null,
      bucket_ts: '2026-03-01T00:00:00.000Z',
      granularity: 'day',
      n_reviews: 12,
      n_five_star: 12,
      z_score: 3.2,
      is_burst: true,
    },
    {
      store_id: 'store-b',
      product_id: null,
      bucket_ts: '2026-03-01T00:00:00.000Z',
      granularity: 'day',
      n_reviews: 2,
      n_five_star: 1,
      z_score: null,
      is_burst: false,
    },
  ],
  edges: [
    {
      src_store_id: 'store-a',
      dst_store_id: 'store-b',
      weight: 1,
      template_ids: ['seed_personal_trial'],
    },
  ],
  score_histograms: sampleHistograms(),
};

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-report-'));
  tmpDirs.push(dir);
  return dir;
}

function hmacEnv(): NodeJS.ProcessEnv {
  return { REVIEWER_ID_SALT: SALT, APP_ENV: 'test', LOG_LEVEL: 'silent' };
}

function gcpEnv(): NodeJS.ProcessEnv {
  return {
    ...hmacEnv(),
    GCP_PROJECT: 'demo-project',
    GCP_LOCATION: 'asia-east1',
    BQ_DATASET: 'ecom_shill',
  };
}

type QueryCall = {
  query: string;
  params?: Record<string, unknown>;
};

function mockBigQuery(opts: {
  existingRun?: boolean;
  funnel?: boolean;
  cosineDistanceThreshold?: number | null;
  l1?: { exclusion_reason: string; n: number }[];
  l2Distances?: { min_cosine_distance: number }[];
  nNoDistance?: number;
  l3?: { shill_score: number; score_source: string }[];
  nInScope?: number;
}): {
  bq: BigQuery;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const exists = opts.existingRun === true;
  const bq = {
    query: async (options: { query: string; params?: Record<string, unknown> }) => {
      const call: QueryCall = { query: options.query };
      if (options.params !== undefined) {
        call.params = options.params;
      }
      calls.push(call);
      const sql = options.query;
      if (sql.includes('INSERT INTO') && sql.includes('pipeline_runs')) {
        throw new Error('report must not INSERT pipeline_runs');
      }
      if (sql.includes('UPDATE') && sql.includes('pipeline_runs')) {
        throw new Error('report must not UPDATE pipeline_runs');
      }
      if (sql.includes('SELECT pipeline_run_id FROM') && sql.includes('LIMIT 1')) {
        return [exists ? [{ pipeline_run_id: RUN }] : []];
      }
      if (sql.includes('FROM') && sql.includes('funnel_stats')) {
        if (opts.funnel === false) {
          return [[]];
        }
        return [[sample.funnel]];
      }
      if (sql.includes('store_shill_stats')) {
        return [sample.stores];
      }
      if (sql.includes('burst_events')) {
        return [sample.bursts.filter((row) => row.is_burst)];
      }
      if (sql.includes('shill_network_edges')) {
        return [sample.edges];
      }
      if (sql.includes('n_no_distance') || sql.includes('NOT EXISTS')) {
        return [[{ n_no_distance: opts.nNoDistance ?? 0 }]];
      }
      if (sql.includes('layer1_exclusion_audit')) {
        return [opts.l1 ?? []];
      }
      if (sql.includes('layer2_distance_audit')) {
        return [opts.l2Distances ?? []];
      }
      if (sql.includes('gemini_review_assessments')) {
        return [opts.l3 ?? []];
      }
      if (sql.includes('n_in_scope')) {
        return [[{ n_in_scope: opts.nInScope ?? 0 }]];
      }
      if (sql.includes('cosine_distance_threshold')) {
        return [[{ cosine_distance_threshold: opts.cosineDistanceThreshold ?? null }]];
      }
      return [[]];
    },
  };
  return { bq: bq as unknown as BigQuery, calls };
}

describe('report CLI flags', () => {
  it('lists format, dot, out, and run id flags', () => {
    const report = buildProgram().commands.find((cmd) => cmd.name() === 'report');
    expect(report).toBeDefined();
    const help = report?.helpInformation() ?? '';
    expect(help).toContain('--pipeline-run-id');
    expect(help).toContain('--continue-latest');
    expect(help).toContain('--format');
    expect(help).toContain('--dot');
    expect(help).toContain('--out');
  });

  it('is no longer not implemented', async () => {
    const src = await readFile(path.join(process.cwd(), 'src/cli/main.ts'), 'utf8');
    expect(src).not.toMatch(/notImplemented\('report'\)/);
    expect(src).toContain('reportAction');
    expect(src).toMatch(/notImplemented\('seeds'\)/);
  });
});

describe('renderMarkdown / renderJson / renderDot', () => {
  it('puts the disclaimer and pct_shill_75 in markdown and json', () => {
    const md = renderMarkdown(sample);
    expect(md).toContain(DISCLAIMER_ZH);
    expect(md).toContain(DISCLAIMER_EN);
    expect(md).toContain('pct_shill_75');
    expect(md).toContain('100.0%');
    expect(md).toContain('store-a');
    expect(md).not.toContain('No burst events');
    expect(md).toContain('## Score distributions');
    expect(md).toContain('non_five_star');
    expect(md).toContain('too_short');
    expect(md).toContain('pure_logistics');
    expect(md).toContain('pass');
    expect(md).toContain('0.28-1.00');
    expect(md).toContain('1.00-2.00');
    expect(md).toContain('no_distance');
    expect(md).toContain('75-100');
    expect(md).toContain('n_copied');
    expect(md).toContain('**Denominator:** `pct_shill_75 = n_shill_75 / n_assessed`');
    expect(md).not.toContain('not_stage2');
    expect((md.match(/### Layer 1/g) ?? []).length).toBe(1);

    const json = renderJson(sample);
    expect(json).toContain(DISCLAIMER_ZH);
    expect(json).toContain('"pct_shill_75": 1');
    const parsed = JSON.parse(json) as {
      bursts: unknown[];
      score_histograms: ScoreHistograms;
    };
    expect(parsed.bursts).toHaveLength(1);
    expect(parsed.score_histograms.layer3.n_copied).toBe(1);
    expect(parsed.score_histograms.layer2.buckets.some((row) => row.bucket === 'no_distance')).toBe(
      true,
    );

    const dot = renderDot(sample);
    expect(dot).toContain('"store-a" -- "store-b" [label=1]');
    expect(dot).not.toContain('Score distributions');
  });

  it('lists zero-count histogram buckets with n/a percentages', () => {
    const md = renderMarkdown({ ...sample, score_histograms: zeroHistograms() });
    for (const bucket of L1_HIST_BUCKETS) {
      expect(md).toContain(bucket);
    }
    expect(md).toContain('0.00-0.07');
    expect(md).toContain('0.07-0.14');
    expect(md).toContain('0.14-0.21');
    expect(md).toContain('0.21-0.28');
    expect(md).toContain('0.28-1.00');
    expect(md).toContain('1.00-2.00');
    expect(md).toContain('no_distance');
    for (const bucket of L3_HIST_BUCKETS) {
      expect(md).toContain(bucket);
    }
    expect(md).toMatch(/\| non_five_star \| 0 \| n\/a \|/);
    expect(md).toMatch(/\| no_distance \| 0 \| n\/a \|/);
    expect(md).toMatch(/\| 0-24 \| 0 \| n\/a \|/);
  });
});

describe('resolveReportOutputPaths', () => {
  it('defaults to reports/<id>.md', () => {
    const paths = resolveReportOutputPaths({
      pipelineRunId: RUN,
      format: 'markdown',
      dot: false,
      cwd: '/tmp/proj',
    });
    expect(paths.primary).toBe(path.join('/tmp/proj', 'reports', `${RUN}.md`));
    expect(paths.dotPath).toBeUndefined();
  });

  it('treats a directory --out as a folder and writes sibling .dot', () => {
    const paths = resolveReportOutputPaths({
      pipelineRunId: RUN,
      format: 'json',
      out: 'out/',
      dot: true,
      cwd: '/tmp/proj',
    });
    expect(paths.primary).toBe(path.join('/tmp/proj', 'out', `${RUN}.json`));
    expect(paths.dotPath).toBe(path.join('/tmp/proj', 'out', `${RUN}.dot`));
  });
});

describe('runReport with mock BigQuery', () => {
  it('writes markdown and does not mutate pipeline_runs', async () => {
    const dir = await tmp();
    const { bq, calls } = mockBigQuery({ existingRun: true });
    const result = await runReport({
      pipelineRunId: RUN,
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: gcpEnv(),
      stdout: { write: () => undefined },
      bigquery: bq,
    });
    expect(result.exitCode).toBe(0);
    expect(result.primaryPath).toBe(path.join(dir, 'reports', `${RUN}.md`));
    const md = await readFile(result.primaryPath, 'utf8');
    expect(md).toContain(DISCLAIMER_ZH);
    expect(md).toContain('pct_shill_75');
    expect(calls.some((call) => call.query.includes('INSERT INTO'))).toBe(false);
    expect(calls.some((call) => call.query.includes('UPDATE'))).toBe(false);
  });

  it('writes json and a .dot file when --dot is set', async () => {
    const dir = await tmp();
    const { bq } = mockBigQuery({ existingRun: true });
    const result = await runReport({
      pipelineRunId: RUN,
      format: 'json',
      dot: true,
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: gcpEnv(),
      stdout: { write: () => undefined },
      bigquery: bq,
    });
    expect(result.dotPath).toBeDefined();
    const json = await readFile(result.primaryPath, 'utf8');
    expect(json).toContain('"pct_shill_75": 1');
    const dot = await readFile(result.dotPath ?? '', 'utf8');
    expect(dot).toContain('store-a');
  });

  it('errors when analyze has not materialized funnel_stats', async () => {
    const dir = await tmp();
    const { bq } = mockBigQuery({ existingRun: true, funnel: false });
    await expect(
      runReport({
        pipelineRunId: RUN,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
        bigquery: bq,
      }),
    ).rejects.toThrow(/analyze first/);
  });

  it('requires a run id flag', async () => {
    const dir = await tmp();
    await expect(
      runReport({
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toBeInstanceOf(RunIdError);
  });

  it('continues latest', async () => {
    const dir = await tmp();
    const latestPath = path.join(dir, 'data', 'runs', 'latest');
    writeLatestRun(
      {
        pipeline_run_id: RUN,
        phase: 'analyze',
        started_at: '2026-03-01T00:00:00.000Z',
      },
      latestPath,
    );
    const { bq } = mockBigQuery({ existingRun: true });
    const result = await runReport({
      continueLatest: true,
      cwd: dir,
      latestPath,
      env: gcpEnv(),
      stdout: { write: () => undefined },
      bigquery: bq,
    });
    expect(result.fromLatest).toBe(true);
  });

  it('scopes histogram SELECTs to this run and does not use ML or stage2 as L2 mass', async () => {
    const dir = await tmp();
    const { bq, calls } = mockBigQuery({ existingRun: true });
    await runReport({
      pipelineRunId: RUN,
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: gcpEnv(),
      stdout: { write: () => undefined },
      bigquery: bq,
    });

    const l1 = calls.find((call) => call.query.includes('layer1_exclusion_audit'))?.query ?? '';
    const l2NoDistance = calls.find((call) => call.query.includes('n_no_distance'))?.query ?? '';
    const l2Distances =
      calls.find(
        (call) =>
          call.query.includes('layer2_distance_audit') &&
          call.query.includes('min_cosine_distance'),
      )?.query ?? '';
    const l3 =
      calls.find((call) => call.query.includes('gemini_review_assessments'))?.query ?? '';
    const nInScope = calls.find((call) => call.query.includes('n_in_scope'))?.query ?? '';

    for (const sql of [l1, l2Distances, l2NoDistance, l3]) {
      expect(sql).toContain('raw_reviews');
      expect(sql).toContain('review_id IN');
      expect(sql).toContain('pipeline_run_id = @');
    }
    expect(l2Distances).toContain('layer2_distance_audit');
    expect(l2Distances).not.toContain('stage2_suspicious_for_gemini');
    expect(l2Distances).not.toContain('ML.');
    expect(l2Distances).not.toContain('@t1');
    expect(l2Distances).not.toContain('0.28');
    expect(l2Distances).not.toContain('CASE');
    expect(nInScope).toContain('raw_reviews');
    expect(nInScope).not.toContain('review_id IN');
    expect(calls.some((call) => call.query.includes('INSERT INTO'))).toBe(false);
    expect(calls.some((call) => call.query.includes('UPDATE'))).toBe(false);
  });

  it('fill-zeros omitted Layer 1 exclusion reasons', async () => {
    const dir = await tmp();
    const { bq } = mockBigQuery({
      existingRun: true,
      l1: [{ exclusion_reason: 'pass', n: 5 }],
      nInScope: 5,
    });
    const result = await runReport({
      pipelineRunId: RUN,
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: gcpEnv(),
      stdout: { write: () => undefined },
      bigquery: bq,
    });
    const md = await readFile(result.primaryPath, 'utf8');
    for (const bucket of L1_HIST_BUCKETS) {
      expect(md).toContain(bucket);
    }
    expect(md).toMatch(/\| non_five_star \| 0 \|/);
    expect(md).toMatch(/\| pass \| 5 \|/);
  });
});

describe('histogram helpers', () => {
  it('renderAsciiBar uses width 20 spaces for empty mass and does not right-pad bars', () => {
    const empty = ' '.repeat(ASCII_BAR_WIDTH);
    expect(renderAsciiBar(0, 10)).toBe(empty);
    expect(renderAsciiBar(-1, 10)).toBe(empty);
    expect(renderAsciiBar(4, 0)).toBe(empty);
    expect(renderAsciiBar(1, 2)).toBe('█'.repeat(Math.round((1 / 2) * ASCII_BAR_WIDTH)));
    expect(renderAsciiBar(1, 1)).toBe('█'.repeat(ASCII_BAR_WIDTH));
    expect(renderAsciiBar(1, 20)).toBe('█');
  });

  it('formatHistogramPct is n/a when total is 0', () => {
    expect(formatHistogramPct(1, 0)).toBe('n/a');
    expect(formatHistogramPct(1, 2)).toBe('50.0%');
  });

  it('binL3Scores covers 0, 24, 25, 74, 75, 100', () => {
    const { buckets } = binL3Scores([0, 24, 25, 74, 75, 100]);
    expect(buckets.map((row) => row.bucket)).toEqual([...L3_HIST_BUCKETS]);
    expect(buckets.map((row) => row.n)).toEqual([2, 1, 1, 2]);
  });

  it('binL2Distances uses T=0.28 half-open quartiles and keeps length 6', () => {
    expect(l2BinEdges(0.28)).toHaveLength(6);

    const bucketOf = (value: number): string => {
      const hit = binL2Distances([value], 0.28).buckets.find((row) => row.n === 1);
      return hit?.bucket ?? '';
    };
    expect(bucketOf(0.07)).toBe('0.07-0.14');
    expect(bucketOf(0.28)).toBe('0.21-0.28');
    expect(bucketOf(0.2800000001)).toBe('0.28-1.00');
    expect(bucketOf(1.0)).toBe('0.28-1.00');
    expect(bucketOf(1.0000001)).toBe('1.00-2.00');
    expect(bucketOf(2.0)).toBe('1.00-2.00');

    const inRange = binL2Distances(
      [0.07, 0.28, 0.2800000001, 1.0, 1.0000001, 2.0],
      0.28,
    );
    expect(inRange.buckets).toHaveLength(6);
    expect(inRange.buckets.map((row) => row.bucket)).toEqual([
      '0.00-0.07',
      '0.07-0.14',
      '0.14-0.21',
      '0.21-0.28',
      '0.28-1.00',
      '1.00-2.00',
    ]);

    const oob = binL2Distances([-0.01, 2.01], 0.28);
    expect(oob.buckets).toHaveLength(7);
    expect(oob.buckets[6]).toEqual({ bucket: 'out_of_range', n: 2 });
  });

  it('fillL1HistogramBuckets always emits the four Layer 1 ids', () => {
    const filled = fillL1HistogramBuckets([{ bucket: 'pass', n: 4 }]);
    expect(filled.buckets.map((row) => row.bucket)).toEqual([...L1_HIST_BUCKETS]);
    expect(filled.buckets.find((row) => row.bucket === 'pass')?.n).toBe(4);
    expect(filled.buckets.find((row) => row.bucket === 'too_short')?.n).toBe(0);
    expect(filled.unknown_n).toBe(0);
  });
});
