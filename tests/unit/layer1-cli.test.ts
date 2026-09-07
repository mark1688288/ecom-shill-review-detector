// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BigQuery } from '@google-cloud/bigquery';
import { afterEach, describe, expect, it } from 'vitest';
import { runLayer1 } from '../../src/cli/commands/layer1.js';
import { buildProgram } from '../../src/cli/main.js';
import { RunIdError, writeLatestRun } from '../../src/shared/run-id.js';

const SALT = '0123456789abcdef0123456789abcdef';
const BATCH = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

const REQUIRED_TABLES = [
  'raw_reviews',
  'stage1_filtered',
  'layer1_exclusion_audit',
  'logistics_canned_phrases',
  'pipeline_runs',
];

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-layer1-'));
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
}): { bq: BigQuery; calls: QueryCall[]; statuses: unknown[] } {
  const calls: QueryCall[] = [];
  const statuses: unknown[] = [];
  const tables = opts.tables ?? REQUIRED_TABLES;
  let exists = opts.existingRun === true;
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
      if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
        return [tables.map((table_name) => ({ table_name }))];
      }
      if (sql.includes('SELECT pipeline_run_id FROM') && sql.includes('LIMIT 1')) {
        return [exists ? [{ pipeline_run_id: RUN }] : []];
      }
      if (sql.includes('INSERT INTO') && sql.includes('pipeline_runs')) {
        exists = true;
        statuses.push(options.params?.['status']);
        return [[]];
      }
      if (sql.includes('UPDATE') && sql.includes('pipeline_runs')) {
        statuses.push(options.params?.['status']);
        return [[]];
      }
      if (sql.includes('n_pure_logistics')) {
        return [
          [
            {
              n_in: 10,
              n_out: 4,
              n_non_five_star: 2,
              n_too_short: 3,
              n_pure_logistics: 1,
            },
          ],
        ];
      }
      if (opts.failScript === true && sql.includes('CREATE TEMP TABLE _phrases')) {
        throw new Error('script failed');
      }
      return [[]];
    },
  };
  return { bq: bq as unknown as BigQuery, calls, statuses };
}

describe('layer1 CLI flags', () => {
  it('lists --pipeline-run-id / --continue-latest and not dry-run', () => {
    const layer1 = buildProgram().commands.find((cmd) => cmd.name() === 'layer1');
    expect(layer1).toBeDefined();
    const help = layer1?.helpInformation() ?? '';
    expect(help).toContain('--pipeline-run-id');
    expect(help).toContain('--continue-latest');
    expect(help).not.toMatch(/dry-run/i);
  });

  it('is no longer not implemented', async () => {
    const src = await readFile(path.join(process.cwd(), 'src/cli/main.ts'), 'utf8');
    expect(src).not.toMatch(/notImplemented\('layer1'\)/);
    expect(src).toContain('layer1Action');
  });
});

describe('runLayer1 validation', () => {
  it('requires GCP_PROJECT', async () => {
    const dir = await tmp();
    await expect(
      runLayer1({
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
      runLayer1({
        pipelineRunId: RUN,
        continueLatest: true,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toBeInstanceOf(RunIdError);
  });
});

describe('runLayer1 with mock BigQuery', () => {
  it('continues latest when the file exists and no flags are passed', async () => {
    const dir = await tmp();
    const latestPath = path.join(dir, 'data', 'runs', 'latest');
    writeLatestRun(
      {
        pipeline_run_id: RUN,
        crawl_batch_id: BATCH,
        phase: 'load',
        started_at: '2026-03-01T00:00:00.000Z',
      },
      latestPath,
    );
    const { bq } = mockBigQuery({ existingRun: true });
    const chunks: string[] = [];
    const result = await runLayer1({
      cwd: dir,
      latestPath,
      env: gcpEnv(),
      stdout: { write: (c: string) => chunks.push(c) },
      bigquery: bq,
    });
    expect(result.pipeline_run_id).toBe(RUN);
    expect(result.fromLatest).toBe(true);
    expect(result.createdRun).toBe(false);
    expect(chunks.join('')).toContain(`pipeline_run_id=${RUN}`);
    const latest = JSON.parse(await readFile(latestPath, 'utf8')) as { phase: string; crawl_batch_id?: string };
    expect(latest.phase).toBe('layer1');
    expect(latest.crawl_batch_id).toBe(BATCH);
  });

  it('creates a UUID when latest is missing and no flags are passed', async () => {
    const dir = await tmp();
    const { bq } = mockBigQuery({});
    const result = await runLayer1({
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: gcpEnv(),
      stdout: { write: () => undefined },
      bigquery: bq,
    });
    expect(result.createdRun).toBe(true);
    expect(result.fromLatest).toBe(false);
    expect(result.pipeline_run_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('INSERTs pipeline_runs when missing, runs the script job, and marks succeeded', async () => {
    const dir = await tmp();
    const { bq, calls, statuses } = mockBigQuery({});
    const result = await runLayer1({
      pipelineRunId: RUN,
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: gcpEnv(),
      stdout: { write: () => undefined },
      bigquery: bq,
    });
    expect(result.exitCode).toBe(0);
    expect(result.n_in).toBe(10);
    expect(result.n_out).toBe(4);
    expect(result.n_non_five_star).toBe(2);
    expect(result.n_too_short).toBe(3);
    expect(result.n_pure_logistics).toBe(1);
    expect(calls.some((c) => c.query.includes('INSERT INTO') && c.query.includes('pipeline_runs'))).toBe(
      true,
    );
    expect(calls.some((c) => c.query.includes('CREATE TEMP TABLE _phrases'))).toBe(true);
    expect(calls.some((c) => c.query.includes('CREATE TEMP TABLE _phrases') && c.query.includes('_stripped'))).toBe(
      true,
    );
    expect(
      calls.some(
        (c) =>
          c.query.includes('CREATE TEMP TABLE _phrases') && c.query.includes('layer1_exclusion_audit'),
      ),
    ).toBe(true);
    expect(calls.some((c) => c.query.includes("phrase_version = 'v0'") || c.query.includes('log_01'))).toBe(
      true,
    );
    const script = calls.find((c) => c.query.includes('CREATE TEMP TABLE _phrases'));
    expect(script?.params?.['pipeline_run_id']).toBe(RUN);
    const insert = calls.find((c) => c.query.includes('INSERT INTO') && c.query.includes('pipeline_runs'));
    expect(insert?.query).toContain('CAST(NULL AS TIMESTAMP)');
    expect(insert?.query).toContain('CAST(NULL AS INT64)');
    expect(insert?.query).toContain('CAST(NULL AS STRING)');
    expect(insert?.params).not.toHaveProperty('finished_at');
    expect(insert?.params).not.toHaveProperty('rows_in');
    expect(insert?.params).not.toHaveProperty('rows_out');
    expect(insert?.params).not.toHaveProperty('error_message');
    const updates = calls.filter((c) => c.query.includes('UPDATE') && c.query.includes('pipeline_runs'));
    for (const update of updates) {
      expect(update.params).not.toHaveProperty('seed_version');
      expect(update.params).not.toHaveProperty('started_at');
    }
    assertNoNullParams(calls);
    expect(statuses).toEqual(['running', 'succeeded']);
    expect(statuses).not.toContain('failed');
  });

  it('does not mark failed after a successful BQ write if latest cannot be written', async () => {
    const dir = await tmp();
    const blocker = path.join(dir, 'latest-blocker');
    await writeFile(blocker, 'not-a-dir', 'utf8');
    const { bq, statuses } = mockBigQuery({ existingRun: true });
    const result = await runLayer1({
      pipelineRunId: RUN,
      cwd: dir,
      latestPath: path.join(blocker, 'latest'),
      env: gcpEnv(),
      stdout: { write: () => undefined },
      bigquery: bq,
    });
    expect(result.exitCode).toBe(0);
    expect(statuses).toEqual(['running', 'succeeded']);
    expect(statuses).not.toContain('failed');
  });

  it('UPDATEs an existing pipeline_runs row instead of inserting a second one', async () => {
    const dir = await tmp();
    const { bq, calls, statuses } = mockBigQuery({ existingRun: true });
    await runLayer1({
      pipelineRunId: RUN,
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: gcpEnv(),
      stdout: { write: () => undefined },
      bigquery: bq,
    });
    expect(calls.some((c) => c.query.includes('INSERT INTO') && c.query.includes('pipeline_runs'))).toBe(
      false,
    );
    expect(calls.filter((c) => c.query.includes('UPDATE') && c.query.includes('pipeline_runs')).length).toBe(
      2,
    );
    assertNoNullParams(calls);
    expect(statuses).toEqual(['running', 'succeeded']);
  });

  it('marks failed when the Layer 1 script job throws', async () => {
    const dir = await tmp();
    const { bq, calls, statuses } = mockBigQuery({ failScript: true });
    await expect(
      runLayer1({
        pipelineRunId: RUN,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
        bigquery: bq,
      }),
    ).rejects.toThrow(/script failed/);
    expect(statuses).toEqual(['running', 'failed']);
    expect(statuses).not.toContain('succeeded');
    assertNoNullParams(calls);
  });

  it('fails clearly when DDL tables are missing', async () => {
    const dir = await tmp();
    const { bq } = mockBigQuery({ tables: ['raw_reviews'] });
    await expect(
      runLayer1({
        pipelineRunId: RUN,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
        bigquery: bq,
      }),
    ).rejects.toThrow(/bq-apply\.sh/);
  });
});

describe('layer1 SQL and scripts', () => {
  const root = process.cwd();

  it('filter_stage1 deletes then inserts and does not replace the table', async () => {
    const filter = await readFile(path.join(root, 'sql/layer1/filter_stage1.sql'), 'utf8');
    const debug = await readFile(path.join(root, 'sql/layer1/debug_exclusions.sql'), 'utf8');
    expect(filter).toContain('ORDER BY LENGTH(phrase) DESC');
    expect(filter).toContain('CHAR_LENGTH');
    expect(filter.indexOf('DELETE FROM')).toBeLessThan(filter.indexOf('INSERT INTO'));
    expect(filter).not.toMatch(/CREATE OR REPLACE TABLE/i);
    expect(filter).toContain("filter_reason");
    expect(filter).toContain("'pass'");
    const strippedFrom = filter.indexOf('CREATE TEMP TABLE _stripped');
    const strippedScan = filter.indexOf('FROM `ecom_shill.raw_reviews` AS r', strippedFrom);
    expect(strippedFrom).toBeGreaterThanOrEqual(0);
    expect(strippedScan).toBeGreaterThan(strippedFrom);
    const strippedPredicate = filter.indexOf('r.pipeline_run_id = @pipeline_run_id', strippedScan);
    expect(strippedPredicate).toBeGreaterThan(strippedScan);
    expect(strippedPredicate).toBeGreaterThan(filter.indexOf('DELETE FROM'));
    expect(debug).not.toContain('logistics_canned_phrases');
    expect(debug).not.toContain('ARRAY_AGG');
    expect(debug).toContain('FROM _stripped');
    expect(debug).not.toContain('raw_reviews');
  });

  it('bq-apply.sh appends 03, 04, 05, 05b after 02', async () => {
    const script = await readFile(path.join(root, 'scripts/bq-apply.sh'), 'utf8');
    expect(script).toContain('00_dataset.sql');
    expect(script).toContain('02_raw_reviews.sql');
    expect(script).toContain('03_logistics_canned_phrases.sql');
    expect(script).toContain('04_pr_seed_phrases.sql');
    expect(script).toContain('05_stage1_filtered.sql');
    expect(script).toContain('05b_layer1_exclusion_audit.sql');
    expect(script.indexOf('02_raw_reviews.sql')).toBeLessThan(script.indexOf('03_logistics_canned_phrases.sql'));
    expect(script.indexOf('03_logistics_canned_phrases.sql')).toBeLessThan(
      script.indexOf('04_pr_seed_phrases.sql'),
    );
    expect(script.indexOf('04_pr_seed_phrases.sql')).toBeLessThan(
      script.indexOf('05_stage1_filtered.sql'),
    );
    expect(script.indexOf('05_stage1_filtered.sql')).toBeLessThan(
      script.indexOf('05b_layer1_exclusion_audit.sql'),
    );
  });

  it('bq-run-layer1.sh pipes SQL on stdin and passes pipeline_run_id as a query parameter', async () => {
    const script = await readFile(path.join(root, 'scripts/bq-run-layer1.sh'), 'utf8');
    expect(script).toContain('GCP_PROJECT');
    expect(script).toContain('GCP_LOCATION');
    expect(script).toContain('PIPELINE_RUN_ID');
    expect(script).toContain('logistics_canned_phrases.sql');
    expect(script).toContain('filter_stage1.sql');
    expect(script).toContain('debug_exclusions.sql');
    expect(script).toContain('--parameter="pipeline_run_id:STRING:${PIPELINE_RUN_ID}"');
    expect(script).toContain('--nouse_cache');
    expect(script).toContain('--use_legacy_sql=false');
    expect(script).toContain("printf '%s\\n' \"$sql\"");
    expect(script).not.toMatch(/nouse_cache \\\n\s+"\$\{sql\}"/);
  });
});
