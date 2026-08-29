// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BigQuery } from '@google-cloud/bigquery';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DISCLAIMER_EN,
  DISCLAIMER_ZH,
  renderDot,
  renderJson,
  renderMarkdown,
  resolveReportOutputPaths,
  type ReportData,
} from '../../src/analysis/report.js';
import { runReport } from '../../src/cli/commands/report.js';
import { buildProgram } from '../../src/cli/main.js';
import { RunIdError, writeLatestRun } from '../../src/shared/run-id.js';

const SALT = '0123456789abcdef0123456789abcdef';
const RUN = '22222222-2222-4222-8222-222222222222';

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

function mockBigQuery(opts: { existingRun?: boolean; funnel?: boolean }): {
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

    const json = renderJson(sample);
    expect(json).toContain(DISCLAIMER_ZH);
    expect(json).toContain('"pct_shill_75": 1');
    const parsed = JSON.parse(json) as { bursts: unknown[] };
    expect(parsed.bursts).toHaveLength(1);

    const dot = renderDot(sample);
    expect(dot).toContain('"store-a" -- "store-b" [label=1]');
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
});
