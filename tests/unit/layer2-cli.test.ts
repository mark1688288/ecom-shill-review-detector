// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BigQuery } from '@google-cloud/bigquery';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatCreateModelFailure,
  renderRemoteModelSql,
  runLayer2,
} from '../../src/cli/commands/layer2.js';
import { buildProgram } from '../../src/cli/main.js';
import { RunIdError, writeLatestRun } from '../../src/shared/run-id.js';

const SALT = '0123456789abcdef0123456789abcdef';
const BATCH = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

const REQUIRED_TABLES = [
  'pipeline_runs',
  'stage1_filtered',
  'pr_seed_phrases',
  'review_embeddings',
  'seed_embeddings',
  'stage2_suspicious_for_gemini',
];

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-layer2-'));
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
    BQ_CONNECTION_ID: 'ecom_shill_vertex',
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
  modelExists?: boolean;
  failCreateModel?: boolean;
  failEmbed?: boolean;
  seedCount?: number;
  nStage1?: number;
  nEmbeddedOk?: number;
  nEmbeddedErr?: number;
  nSuspicious?: number;
  dim?: number;
}): { bq: BigQuery; calls: QueryCall[]; statuses: unknown[] } {
  const calls: QueryCall[] = [];
  const statuses: unknown[] = [];
  const tables = opts.tables ?? REQUIRED_TABLES;
  const exists = opts.existingRun === true;
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
        throw new Error('layer2 must not INSERT pipeline_runs');
      }
      if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
        return [tables.map((table_name) => ({ table_name }))];
      }
      if (sql.includes('INFORMATION_SCHEMA.MODELS')) {
        return [opts.modelExists === true ? [{ model_name: 'text_embedding' }] : []];
      }
      if (/\bCREATE\b/.test(sql) && /\bMODEL\b/.test(sql)) {
        if (opts.failCreateModel === true) {
          throw Object.assign(new Error('Not found: Endpoint text-multilingual-embedding-002'), {
            code: 404,
          });
        }
        return [[]];
      }
      if (sql.includes('SELECT pipeline_run_id FROM') && sql.includes('LIMIT 1')) {
        return [exists ? [{ pipeline_run_id: RUN }] : []];
      }
      if (sql.includes('UPDATE') && sql.includes('pipeline_runs')) {
        statuses.push(options.params?.['status']);
        return [[]];
      }
      if (sql.includes('is_active = TRUE') && sql.includes('COUNT(*)')) {
        return [[{ n: opts.seedCount ?? 7 }]];
      }
      if (opts.failEmbed === true && sql.includes('LEFT(s.comment_text')) {
        throw new Error('embed failed');
      }
      if (sql.includes('n_embedded_ok')) {
        return [
          [
            {
              n_stage1: opts.nStage1 ?? 10,
              n_embedded_ok: opts.nEmbeddedOk ?? 8,
              n_embedded_err: opts.nEmbeddedErr ?? 2,
              n_suspicious: opts.nSuspicious ?? 3,
            },
          ],
        ];
      }
      if (sql.includes('ARRAY_LENGTH')) {
        const dim = opts.dim ?? 768;
        if ((opts.nEmbeddedOk ?? 8) === 0) {
          return [[]];
        }
        return [[{ dim }]];
      }
      if (sql.includes('min_cosine_distance')) {
        return [
          [
            {
              review_id: 'r1',
              matched_seed_id: 'seed_personal_trial',
              matched_seed_category: 'personal_trial',
              min_cosine_distance: 0.12,
              min_cosine_similarity: 0.88,
            },
          ],
        ];
      }
      return [[]];
    },
  };
  return { bq: bq as unknown as BigQuery, calls, statuses };
}

describe('layer2 CLI flags', () => {
  it('lists --pipeline-run-id / --continue-latest / --seed-version and not dry-run', () => {
    const layer2 = buildProgram().commands.find((cmd) => cmd.name() === 'layer2');
    expect(layer2).toBeDefined();
    const help = layer2?.helpInformation() ?? '';
    expect(help).toContain('--pipeline-run-id');
    expect(help).toContain('--continue-latest');
    expect(help).toContain('--seed-version');
    expect(help).not.toMatch(/dry-run/i);
  });

  it('is no longer not implemented', async () => {
    const src = await readFile(path.join(process.cwd(), 'src/cli/main.ts'), 'utf8');
    expect(src).not.toMatch(/notImplemented\('layer2'\)/);
    expect(src).toContain('layer2Action');
  });
});

describe('renderRemoteModelSql', () => {
  const raw = `CREATE OR REPLACE MODEL \`__DATASET__.text_embedding\`
REMOTE WITH CONNECTION \`__GCP_PROJECT__.__GCP_LOCATION__.__BQ_CONNECTION_ID__\`
OPTIONS (ENDPOINT = '__EMBEDDING_MODEL__');`;

  it('substitutes placeholders without rewriting the connection id prefix', () => {
    const sql = renderRemoteModelSql(raw, {
      project: 'demo-project',
      location: 'asia-east1',
      dataset: 'other_ds',
      connectionId: 'ecom_shill_vertex',
      embeddingModel: 'text-multilingual-embedding-002',
    });
    expect(sql).toContain('`other_ds.text_embedding`');
    expect(sql).toContain('`demo-project.asia-east1.ecom_shill_vertex`');
    expect(sql).toContain("ENDPOINT = 'text-multilingual-embedding-002'");
    expect(sql).not.toContain('__');
    expect(sql).not.toContain('other_ds_vertex');
  });

  it('rejects an invalid connection id', () => {
    expect(() =>
      renderRemoteModelSql(raw, {
        project: 'demo-project',
        location: 'asia-east1',
        dataset: 'ecom_shill',
        connectionId: 'bad-id;drop',
        embeddingModel: 'text-multilingual-embedding-002',
      }),
    ).toThrow(/BQ_CONNECTION_ID/);
  });
});

describe('formatCreateModelFailure', () => {
  it('tells the operator not to switch to 004 on a multilingual-002 404', () => {
    const err = Object.assign(new Error('Not found: Endpoint text-multilingual-embedding-002'), {
      code: 404,
    });
    const message = formatCreateModelFailure(err, 'text-multilingual-embedding-002');
    expect(message).toMatch(/404/);
    expect(message).toMatch(/Do not silently switch to text-embedding-004/);
  });
});

describe('runLayer2 validation', () => {
  it('requires GCP_PROJECT', async () => {
    const dir = await tmp();
    await expect(
      runLayer2({
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
      runLayer2({
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
      runLayer2({
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toBeInstanceOf(RunIdError);
  });
});

describe('runLayer2 with mock BigQuery', () => {
  it('continues latest, creates the remote model, embeds, and marks succeeded', async () => {
    const dir = await tmp();
    const latestPath = path.join(dir, 'data', 'runs', 'latest');
    writeLatestRun(
      {
        pipeline_run_id: RUN,
        crawl_batch_id: BATCH,
        phase: 'layer1',
        started_at: '2026-03-01T00:00:00.000Z',
      },
      latestPath,
    );
    const { bq, calls, statuses } = mockBigQuery({ existingRun: true });
    const chunks: string[] = [];
    const result = await runLayer2({
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
    expect(result.model_created).toBe(true);
    expect(result.n_stage1).toBe(10);
    expect(result.n_embedded_ok).toBe(8);
    expect(result.n_embedded_err).toBe(2);
    expect(result.n_suspicious).toBe(3);
    expect(result.embedding_dim).toBe(768);
    expect(result.seed_version).toBe('v0_hypothesis');
    expect(result.threshold).toBe(0.28);
    expect(chunks.join('')).toContain(`pipeline_run_id=${RUN}`);
    const latest = JSON.parse(await readFile(latestPath, 'utf8')) as {
      phase: string;
      crawl_batch_id?: string;
    };
    expect(latest.phase).toBe('layer2');
    expect(latest.crawl_batch_id).toBe(BATCH);

    expect(calls.some((c) => c.query.includes('INSERT INTO') && c.query.includes('pipeline_runs'))).toBe(
      false,
    );
    expect(calls.some((c) => /\bCREATE\b/.test(c.query) && /\bMODEL\b/.test(c.query))).toBe(true);
    expect(
      calls.some(
        (c) =>
          /\bCREATE\b/.test(c.query) &&
          c.query.includes('demo-project.asia-east1.ecom_shill_vertex') &&
          c.query.includes('text-multilingual-embedding-002'),
      ),
    ).toBe(true);
    expect(calls.some((c) => c.query.includes('seed_text AS content'))).toBe(true);
    expect(calls.some((c) => c.query.includes('LEFT(s.comment_text'))).toBe(true);
    expect(calls.some((c) => c.query.includes('stage2_suspicious_for_gemini'))).toBe(true);
    const distance = calls.find((c) => c.query.includes('AND cosine_distance <= @threshold'));
    expect(distance?.params?.['pipeline_run_id']).toBe(RUN);
    expect(distance?.params?.['seed_version']).toBe('v0_hypothesis');
    expect(distance?.params?.['embedding_model']).toBe('text-multilingual-embedding-002');
    expect(distance?.params?.['threshold']).toBe(0.28);
    const updates = calls.filter((c) => c.query.includes('UPDATE') && c.query.includes('pipeline_runs'));
    expect(updates.length).toBe(2);
    for (const update of updates) {
      expect(update.params).not.toHaveProperty('started_at');
    }
    const running = updates[0];
    expect(running?.query).toContain('CAST(NULL AS TIMESTAMP)');
    expect(running?.query).toContain('CAST(NULL AS INT64)');
    expect(running?.params).not.toHaveProperty('finished_at');
    const succeeded = updates[1];
    expect(succeeded?.params?.['seed_version']).toBe('v0_hypothesis');
    expect(succeeded?.params?.['rows_in']).toBe(10);
    expect(succeeded?.params?.['rows_out']).toBe(3);
    assertNoNullParams(calls);
    expect(statuses).toEqual(['running', 'succeeded']);
  });

  it('skips CREATE MODEL when text_embedding already exists', async () => {
    const dir = await tmp();
    const { bq, calls } = mockBigQuery({ existingRun: true, modelExists: true });
    const result = await runLayer2({
      pipelineRunId: RUN,
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: gcpEnv(),
      stdout: { write: () => undefined },
      bigquery: bq,
    });
    expect(result.model_created).toBe(false);
    expect(calls.some((c) => /\bCREATE\b/.test(c.query) && /\bMODEL\b/.test(c.query))).toBe(false);
  });

  it('does not INSERT pipeline_runs when the id is missing', async () => {
    const dir = await tmp();
    const { bq, calls, statuses } = mockBigQuery({ existingRun: false });
    await expect(
      runLayer2({
        pipelineRunId: RUN,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
        bigquery: bq,
      }),
    ).rejects.toBeInstanceOf(RunIdError);
    expect(calls.some((c) => c.query.includes('INSERT INTO') && c.query.includes('pipeline_runs'))).toBe(
      false,
    );
    expect(statuses).toEqual([]);
  });

  it('does not mark failed after a successful BQ write if latest cannot be written', async () => {
    const dir = await tmp();
    const blocker = path.join(dir, 'latest-blocker');
    await writeFile(blocker, 'not-a-dir', 'utf8');
    const { bq, statuses } = mockBigQuery({ existingRun: true, modelExists: true });
    const result = await runLayer2({
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

  it('marks failed when embed throws', async () => {
    const dir = await tmp();
    const { bq, calls, statuses } = mockBigQuery({
      existingRun: true,
      modelExists: true,
      failEmbed: true,
    });
    await expect(
      runLayer2({
        pipelineRunId: RUN,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
        bigquery: bq,
      }),
    ).rejects.toThrow(/embed failed/);
    expect(statuses).toEqual(['running', 'failed']);
    expect(statuses).not.toContain('succeeded');
    assertNoNullParams(calls);
  });

  it('stops on CREATE MODEL 404 and does not fall back to 004', async () => {
    const dir = await tmp();
    const { bq, statuses } = mockBigQuery({ existingRun: true, failCreateModel: true });
    await expect(
      runLayer2({
        pipelineRunId: RUN,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
        bigquery: bq,
      }),
    ).rejects.toThrow(/Do not silently switch to text-embedding-004/);
    expect(statuses).toEqual(['running', 'failed']);
  });

  it('fails clearly when DDL tables are missing', async () => {
    const dir = await tmp();
    const { bq } = mockBigQuery({ existingRun: true, tables: ['pipeline_runs'] });
    await expect(
      runLayer2({
        pipelineRunId: RUN,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
        bigquery: bq,
      }),
    ).rejects.toThrow(/bq-apply\.sh/);
  });

  it('fails when there are no active seeds for the requested version', async () => {
    const dir = await tmp();
    const { bq } = mockBigQuery({ existingRun: true, modelExists: true, seedCount: 0 });
    await expect(
      runLayer2({
        pipelineRunId: RUN,
        seedVersion: 'missing_version',
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
        bigquery: bq,
      }),
    ).rejects.toThrow(/missing_version/);
  });

  it('fails when stage1 rows exist but none embed ok', async () => {
    const dir = await tmp();
    const { bq } = mockBigQuery({
      existingRun: true,
      modelExists: true,
      nStage1: 4,
      nEmbeddedOk: 0,
      nEmbeddedErr: 4,
    });
    await expect(
      runLayer2({
        pipelineRunId: RUN,
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
        bigquery: bq,
      }),
    ).rejects.toThrow(/embedded 0 ok rows/);
  });

  it('skips v0 seed upsert when --seed-version is not v0_hypothesis', async () => {
    const dir = await tmp();
    const { bq, calls } = mockBigQuery({ existingRun: true, modelExists: true });
    await runLayer2({
      pipelineRunId: RUN,
      seedVersion: 'v1_custom',
      cwd: dir,
      latestPath: path.join(dir, 'data', 'runs', 'latest'),
      env: gcpEnv(),
      stdout: { write: () => undefined },
      bigquery: bq,
    });
    expect(calls.some((c) => c.query.includes("seed_version = 'v0_hypothesis'"))).toBe(false);
    const distance = calls.find((c) => c.query.includes('AND cosine_distance <= @threshold'));
    expect(distance?.params?.['seed_version']).toBe('v1_custom');
  });
});

describe('layer2 scripts', () => {
  const root = process.cwd();

  it('bq-run-layer2.sh pipes SQL on stdin and passes query parameters', async () => {
    const script = await readFile(path.join(root, 'scripts/bq-run-layer2.sh'), 'utf8');
    expect(script).toContain('GCP_PROJECT');
    expect(script).toContain('GCP_LOCATION');
    expect(script).toContain('PIPELINE_RUN_ID');
    expect(script).toContain('06_remote_models.sql');
    expect(script).toContain('embed_seeds.sql');
    expect(script).toContain('embed_reviews.sql');
    expect(script).toContain('distance_filter.sql');
    expect(script).toContain('--parameter="pipeline_run_id:STRING:${PIPELINE_RUN_ID}"');
    expect(script).toContain('--parameter="seed_version:STRING:${SEED_VERSION}"');
    expect(script).toContain('--parameter="embedding_model:STRING:${EMBEDDING_MODEL}"');
    expect(script).toContain('--parameter="threshold:FLOAT64:${COSINE_DISTANCE_THRESHOLD}"');
    expect(script).toContain('--nouse_cache');
    expect(script).toContain('--use_legacy_sql=false');
    expect(script).toContain("printf '%s\\n' \"$sql\"");
    expect(script).toContain('ARRAY_LENGTH');
    expect(script).toContain('min_cosine_distance');
    expect(script).not.toMatch(/nouse_cache \\\n\s+"\$\{sql\}"/);
  });

  it('bootstrap-gcp.sh documents connection SA IAM, CREATE MODEL, and the 404 stop', async () => {
    const script = await readFile(path.join(root, 'scripts/bootstrap-gcp.sh'), 'utf8');
    expect(script).toContain('roles/aiplatform.user');
    expect(script).toContain('bq mk --connection');
    expect(script).toContain('CREATE OR REPLACE MODEL');
    expect(script).toContain('Do not silently switch to text-embedding-004');
    expect(script).toContain('pnpm cli layer2 --continue-latest');
    expect(script).toContain('echo-only');
  });
});
