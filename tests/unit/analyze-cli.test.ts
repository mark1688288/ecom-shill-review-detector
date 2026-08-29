// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BigQuery } from '@google-cloud/bigquery';
import { afterEach, describe, expect, it } from 'vitest';
import { ANALYZE_TABLES, runAnalyze } from '../../src/cli/commands/analyze.js';
import { buildProgram } from '../../src/cli/main.js';
import { RunIdError, writeLatestRun } from '../../src/shared/run-id.js';

const SALT = '0123456789abcdef0123456789abcdef';
const BATCH = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-analyze-'));
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

function assertNoNullParams(calls: QueryCall[]): void {
  for (const call of calls) {
    if (call.params === undefined) {
      continue;
    }
    for (const [key, value] of Object.entries(call.params)) {
      expect(value, key).not.toBeNull();
    }
  }
}

function mockBigQuery(opts: {
  existingRun?: boolean;
  tables?: string[];
  failScript?: boolean;
  counts?: Partial<{
    n_store_stats: number;
    n_burst_events: number;
    n_burst_flagged: number;
    n_collisions: number;
    n_edges: number;
    n_funnel: number;
    n_assessed: number;
  }>;
}): { bq: BigQuery; calls: QueryCall[]; statuses: unknown[] } {
  const calls: QueryCall[] = [];
  const statuses: unknown[] = [];
  const tables = opts.tables ?? [...ANALYZE_TABLES];
  const exists = opts.existingRun === true;
  const counts = {
    n_store_stats: 2,
    n_burst_events: 4,
    n_burst_flagged: 0,
    n_collisions: 1,
    n_edges: 1,
    n_funnel: 1,
    n_assessed: 2,
    ...opts.counts,
  };
  const bq = {
    query: async (options: { query: string; params?: Record<string, unknown> }) => {
      const call: QueryCall = { query: options.query };
      if (options.params !== undefined) {
        for (const [key, value] of Object.entries(options.params)) {
          if (value === null) {
            throw new Error(`null query param ${key} is not encodable without types`);
          }
        }
        call.params = options.params;
      }
      calls.push(call);
      const sql = options.query;
      if (sql.includes('INSERT INTO') && sql.includes('pipeline_runs')) {
        throw new Error('analyze must not INSERT pipeline_runs');
      }
      if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
        return [tables.map((table_name) => ({ table_name }))];
      }
      if (sql.includes('SELECT pipeline_run_id FROM') && sql.includes('LIMIT 1')) {
        return [exists ? [{ pipeline_run_id: RUN }] : []];
      }
      if (sql.includes('UPDATE') && sql.includes('pipeline_runs')) {
        statuses.push(options.params?.['status']);
        return [[]];
      }
      if (sql.includes('n_store_stats')) {
        return [[counts]];
      }
      if (opts.failScript === true && sql.includes('store_shill_stats')) {
        throw new Error('script failed');
      }
      return [[]];
    },
  };
  return { bq: bq as unknown as BigQuery, calls, statuses };
}

describe('analyze CLI flags', () => {
  it('lists --pipeline-run-id / --continue-latest and not dry-run', () => {
    const analyze = buildProgram().commands.find((cmd) => cmd.name() === 'analyze');
    expect(analyze).toBeDefined();
    const help = analyze?.helpInformation() ?? '';
    expect(help).toContain('--pipeline-run-id');
    expect(help).toContain('--continue-latest');
    expect(help).not.toMatch(/dry-run/i);
  });

  it('is no longer not implemented', async () => {
    const src = await readFile(path.join(process.cwd(), 'src/cli/main.ts'), 'utf8');
    expect(src).not.toMatch(/notImplemented\('analyze'\)/);
    expect(src).toContain('analyzeAction');
  });
});

describe('runAnalyze validation', () => {
  it('requires GCP_PROJECT', async () => {
    const dir = await tmp();
    await expect(
      runAnalyze({
        pipelineRunId: RUN,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: hmacEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toThrow(/GCP_PROJECT/);
  });

  it('rejects --pipeline-run-id together with --continue-latest', async () => {
    const dir = await tmp();
    await expect(
      runAnalyze({
        pipelineRunId: RUN,
        continueLatest: true,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toBeInstanceOf(RunIdError);
  });

  it('exits 2 when pipeline run id flags are missing (never creates a run)', async () => {
    const dir = await tmp();
    await expect(
      runAnalyze({
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toBeInstanceOf(RunIdError);
  });
});

describe('runAnalyze with mock BigQuery', () => {
  it('continues latest, rebuilds analysis tables, and does not INSERT pipeline_runs', async () => {
    const dir = await tmp();
    const latestPath = path.join(dir, 'data', 'runs', 'latest');
    writeLatestRun(
      {
        pipeline_run_id: RUN,
        crawl_batch_id: BATCH,
        phase: 'audit',
        started_at: '2026-03-01T00:00:00.000Z',
      },
      latestPath,
    );
    const { bq, calls, statuses } = mockBigQuery({ existingRun: true });
    const chunks: string[] = [];
    const result = await runAnalyze({
      continueLatest: true,
      cwd: dir,
      latestPath,
      env: gcpEnv(),
      stdout: { write: (c: string) => chunks.push(c) },
      bigquery: bq,
    });
    expect(result.exitCode).toBe(0);
    expect(result.pipeline_run_id).toBe(RUN);
    expect(result.fromLatest).toBe(true);
    expect(result.n_collisions).toBe(1);
    expect(result.n_edges).toBe(1);
    expect(result.n_store_stats).toBe(2);
    expect(chunks.join('')).toContain(`pipeline_run_id=${RUN}`);
    expect(statuses).toEqual(['running', 'succeeded']);
    assertNoNullParams(calls);
    expect(calls.some((call) => call.query.includes('INSERT INTO') && call.query.includes('pipeline_runs'))).toBe(
      false,
    );

    const sqlCalls = calls.filter(
      (call) => call.query.includes('DELETE FROM') || call.query.includes('INSERT INTO `ecom_shill.cross_store'),
    );
    const joined = sqlCalls.map((call) => call.query).join('\n---\n');
    expect(joined.indexOf('store_shill_stats')).toBeGreaterThanOrEqual(0);
    expect(joined.indexOf('store_shill_stats')).toBeLessThan(joined.indexOf('burst_events'));
    expect(joined.indexOf('cross_store_template_collisions')).toBeGreaterThan(joined.indexOf('burst_events'));
    expect(joined.indexOf("'embedding'")).toBeGreaterThan(joined.indexOf("'template'"));
    expect(joined.indexOf('shill_network_edges')).toBeGreaterThan(joined.indexOf("'embedding'"));
    expect(joined.indexOf('funnel_stats')).toBeGreaterThan(joined.indexOf('shill_network_edges'));

    const latest = JSON.parse(await readFile(latestPath, 'utf8')) as {
      phase: string;
      crawl_batch_id?: string;
    };
    expect(latest.phase).toBe('analyze');
    expect(latest.crawl_batch_id).toBe(BATCH);
  });

  it('re-running the same pipeline_run_id DELETEs analysis rows before INSERT (idempotent)', async () => {
    const dir = await tmp();
    const { bq, calls } = mockBigQuery({ existingRun: true });
    const common = {
      pipelineRunId: RUN,
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: gcpEnv(),
      stdout: { write: () => undefined },
      bigquery: bq,
    };
    await runAnalyze(common);
    await runAnalyze(common);
    const deletes = calls.filter((call) => call.query.includes('DELETE FROM `ecom_shill.store_shill_stats`'));
    const collisionDeletes = calls.filter((call) =>
      call.query.includes('DELETE FROM `ecom_shill.cross_store_template_collisions`'),
    );
    const edgeDeletes = calls.filter((call) =>
      call.query.includes('DELETE FROM `ecom_shill.shill_network_edges`'),
    );
    expect(deletes).toHaveLength(2);
    expect(collisionDeletes).toHaveLength(2);
    expect(edgeDeletes).toHaveLength(2);
    for (const call of [...deletes, ...collisionDeletes, ...edgeDeletes]) {
      expect(call.query.indexOf('DELETE FROM')).toBeLessThan(call.query.indexOf('INSERT INTO'));
    }
  });

  it('fails when the pipeline run is missing', async () => {
    const dir = await tmp();
    const { bq } = mockBigQuery({ existingRun: false });
    await expect(
      runAnalyze({
        pipelineRunId: RUN,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
        bigquery: bq,
      }),
    ).rejects.toBeInstanceOf(RunIdError);
  });

  it('fails when analysis tables are missing', async () => {
    const dir = await tmp();
    const { bq } = mockBigQuery({ existingRun: true, tables: ['pipeline_runs'] });
    await expect(
      runAnalyze({
        pipelineRunId: RUN,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
        bigquery: bq,
      }),
    ).rejects.toThrow(/bq-apply/);
  });

  it('marks the run failed when a script errors', async () => {
    const dir = await tmp();
    const { bq, statuses } = mockBigQuery({ existingRun: true, failScript: true });
    await expect(
      runAnalyze({
        pipelineRunId: RUN,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
        bigquery: bq,
      }),
    ).rejects.toThrow(/script failed/);
    expect(statuses).toEqual(['running', 'failed']);
  });
});
