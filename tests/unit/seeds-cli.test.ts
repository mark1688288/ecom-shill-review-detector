// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BigQuery } from '@google-cloud/bigquery';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/main.js';
import {
  parseLabelDocument,
  parseSeedDocument,
  runSeedsCalibrate,
  runSeedsUpsert,
  SeedsUsageError,
  summarizeLabels,
} from '../../src/cli/commands/seeds.js';
import { RunIdError, writeLatestRun } from '../../src/shared/run-id.js';

const SALT = '0123456789abcdef0123456789abcdef';
const BATCH = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-seeds-'));
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

function collectStdout(): { stdout: { write(chunk: string): unknown }; text: () => string } {
  let buf = '';
  return {
    stdout: {
      write: (chunk: string) => {
        buf += chunk;
        return true;
      },
    },
    text: () => buf,
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

const SEED_FIXTURE = path.join(process.cwd(), 'fixtures/seeds/v1_example.jsonl');
const LABEL_FIXTURE = path.join(process.cwd(), 'fixtures/expected/human-labels.example.jsonl');

const UPSERT_TABLES = ['pr_seed_phrases'];
const CALIBRATE_TABLES = [
  'pipeline_runs',
  'human_labels',
  'calibration_sweep',
  'layer2_distance_audit',
  'gemini_review_assessments',
  'stage2_suspicious_for_gemini',
];

function mockBigQuery(opts: {
  existingRun?: boolean;
  tables?: string[];
  nLabeled?: number;
  sweep?: Record<string, unknown>[];
}): { bq: BigQuery; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const tables = opts.tables ?? [...UPSERT_TABLES, ...CALIBRATE_TABLES];
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
        throw new Error('seeds must not INSERT pipeline_runs');
      }
      if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
        return [tables.map((table_name) => ({ table_name }))];
      }
      if (sql.includes('SELECT pipeline_run_id FROM') && sql.includes('LIMIT 1')) {
        return [exists ? [{ pipeline_run_id: RUN }] : []];
      }
      if (sql.includes('COUNT(*) AS n_labeled')) {
        const n = opts.nLabeled ?? 4;
        return [
          [
            {
              n_labeled: n,
              n_shill: 2,
              n_not_shill: 1,
              n_unsure: 1,
            },
          ],
        ];
      }
      if (sql.includes('FROM') && sql.includes('calibration_sweep') && sql.includes('SELECT')) {
        return [
          opts.sweep ?? [
            {
              metric_kind: 'layer2_distance',
              cosine_distance_threshold: 0.28,
              shill_score_threshold: null,
              n_labeled: 4,
              n_shill: 2,
              n_not_shill: 1,
              n_unsure: 1,
              n_predicted_positive: 2,
              n_true_positive: 1,
              n_false_positive: 1,
              n_false_negative: 1,
              precision: 0.5,
              recall: 0.5,
              n_predicted_stage2: 10,
              estimated_gemini_usd: 0.036,
            },
            {
              metric_kind: 'layer3_score',
              cosine_distance_threshold: 0.28,
              shill_score_threshold: 75,
              n_labeled: 4,
              n_shill: 2,
              n_not_shill: 1,
              n_unsure: 1,
              n_predicted_positive: 1,
              n_true_positive: 1,
              n_false_positive: 0,
              n_false_negative: 1,
              precision: 1,
              recall: 0.5,
              n_predicted_stage2: 2,
              estimated_gemini_usd: 0.007,
            },
          ],
        ];
      }
      return [[]];
    },
  };
  return { bq: bq as unknown as BigQuery, calls };
}

describe('seeds CLI flags', () => {
  it('lists upsert and calibrate subcommands', () => {
    const seeds = buildProgram().commands.find((cmd) => cmd.name() === 'seeds');
    expect(seeds).toBeDefined();
    const names = (seeds?.commands ?? []).map((cmd) => cmd.name());
    expect(names).toContain('upsert');
    expect(names).toContain('calibrate');
    const upsertHelp = seeds?.commands.find((cmd) => cmd.name() === 'upsert')?.helpInformation() ?? '';
    expect(upsertHelp).toContain('--input');
    expect(upsertHelp).toContain('--seed-version');
    expect(upsertHelp).toContain('--dry-run');
    expect(upsertHelp).toMatch(/no-activate/i);
    const calibrateHelp =
      seeds?.commands.find((cmd) => cmd.name() === 'calibrate')?.helpInformation() ?? '';
    expect(calibrateHelp).toContain('--pipeline-run-id');
    expect(calibrateHelp).toContain('--continue-latest');
    expect(calibrateHelp).toContain('--label-file');
    expect(calibrateHelp).toContain('--dry-run');
  });

  it('is no longer not implemented', async () => {
    const src = await readFile(path.join(process.cwd(), 'src/cli/main.ts'), 'utf8');
    expect(src).not.toMatch(/notImplemented\('seeds'\)/);
    expect(src).toContain('seedsUpsertAction');
    expect(src).toContain('seedsCalibrateAction');
  });
});

describe('parseSeedDocument / parseLabelDocument', () => {
  it('parses the 7-slot fixture JSONL', async () => {
    const text = await readFile(SEED_FIXTURE, 'utf8');
    const rows = parseSeedDocument(text);
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((row) => row.category)).size).toBe(7);
  });

  it('parses a JSON array', () => {
    const rows = parseSeedDocument(seedJsonArray());
    expect(rows).toHaveLength(7);
  });

  it('rejects v0-sized input missing a category', () => {
    expect(() => parseSeedDocument(seedJsonArray().replace('personal_trial', 'skin_result'))).toThrow(
      SeedsUsageError,
    );
  });

  it('summarizes label fixture strata', async () => {
    const text = await readFile(LABEL_FIXTURE, 'utf8');
    const rows = parseLabelDocument(text);
    expect(summarizeLabels(rows)).toEqual({
      n_labeled: 4,
      n_shill: 2,
      n_not_shill: 1,
      n_unsure: 1,
    });
  });

  it('rejects duplicate review_id', () => {
    expect(() =>
      parseLabelDocument(
        '{"review_id":"a","label":"shill"}\n{"review_id":"a","label":"not_shill"}\n',
      ),
    ).toThrow(/duplicate review_id/);
  });
});

function seedJsonArray(): string {
  return JSON.stringify([
    {
      seed_id: 'seed_personal_trial',
      category: 'personal_trial',
      seed_text: '今次係我親身試用過先敢講，真係同廣告講嘅一樣，用落好舒服，效果好明顯。',
    },
    {
      seed_id: 'seed_skin_result',
      category: 'skin_result',
      seed_text: '用咗幾個禮拜，皮膚真係變好咗，暗瘡少咗，個 toning 都均淨晒，成個人都有光澤。',
    },
    {
      seed_id: 'seed_repurchase',
      category: 'repurchase',
      seed_text: '用完一枝已經決定回購，自己用完仲介紹俾屋企人，以後都會繼續支持呢個品牌。',
    },
    {
      seed_id: 'seed_social_proof',
      category: 'social_proof',
      seed_text: '朋友極力推薦我先買，佢用完話效果好好，我試過之後都覺得冇令我失望。',
    },
    {
      seed_id: 'seed_cp_value',
      category: 'value_for_money',
      seed_text: 'CP 值真係好高，呢個價已經買到咁好嘅質素，性價比超高，好抵用。',
    },
    {
      seed_id: 'seed_brand_compare',
      category: 'brand_comparison',
      seed_text: '對比之前用開嗰個品牌，呢隻明顯好好多，唔會再換返去舊嗰隻。',
    },
    {
      seed_id: 'seed_packaging',
      category: 'packaging_care',
      seed_text: '包裝好用心，一打開已經覺得好有質感，連細節都處理得好專業，賣家好有誠意。',
    },
  ]);
}

describe('runSeedsUpsert', () => {
  it('dry-run prints plan_* without BigQuery or GCP', async () => {
    const dir = await tmp();
    const { stdout, text } = collectStdout();
    const result = await runSeedsUpsert({
      input: SEED_FIXTURE,
      seedVersion: 'v1_example',
      dryRun: true,
      cwd: dir,
      env: hmacEnv(),
      stdout,
    });
    expect(result.exitCode).toBe(0);
    expect(result.n_upserted).toBe(0);
    expect(text()).toContain('plan_n_seeds=7');
    expect(text()).toContain('plan_seed_version=v1_example');
    expect(text()).toContain('plan_activate=true');
  });

  it('refuses to upsert v0_hypothesis', async () => {
    await expect(
      runSeedsUpsert({
        input: SEED_FIXTURE,
        seedVersion: 'v0_hypothesis',
        dryRun: true,
        env: hmacEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toBeInstanceOf(SeedsUsageError);
  });

  it('requires GCP_PROJECT when not dry-run', async () => {
    await expect(
      runSeedsUpsert({
        input: SEED_FIXTURE,
        seedVersion: 'v1_example',
        env: hmacEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toThrow(/GCP_PROJECT/);
  });

  it('inserts a new version, deactivates others, and does not write pipeline_runs', async () => {
    const dir = await tmp();
    const { bq, calls } = mockBigQuery({});
    const { stdout, text } = collectStdout();
    const result = await runSeedsUpsert({
      input: SEED_FIXTURE,
      seedVersion: 'v1_example',
      cwd: dir,
      env: gcpEnv(),
      stdout,
      bigquery: bq,
    });
    expect(result.exitCode).toBe(0);
    expect(result.n_upserted).toBe(7);
    expect(text()).toContain('seed_version=v1_example n_upserted=7 activate=true');
    expect(text()).toContain('layer2 --seed-version v1_example');
    const joined = calls.map((call) => call.query).join('\n');
    expect(joined).toMatch(/DELETE FROM[\s\S]+seed_version = @seed_version/);
    expect(calls.filter((call) => call.query.includes('INSERT INTO')).length).toBe(7);
    expect(joined).toMatch(/SET is_active = FALSE/);
    expect(joined).not.toMatch(/pipeline_runs/);
    assertNoNullParams(calls);
  });

  it('skips deactivating other versions with --no-activate', async () => {
    const { bq, calls } = mockBigQuery({});
    await runSeedsUpsert({
      input: SEED_FIXTURE,
      seedVersion: 'v1_example',
      activate: false,
      env: gcpEnv(),
      stdout: { write: () => undefined },
      bigquery: bq,
    });
    expect(calls.some((call) => call.query.includes('SET is_active = FALSE'))).toBe(false);
  });
});

describe('runSeedsCalibrate', () => {
  it('dry-run requires --label-file and does not need GCP', async () => {
    await expect(
      runSeedsCalibrate({
        dryRun: true,
        env: hmacEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toBeInstanceOf(SeedsUsageError);

    const { stdout, text } = collectStdout();
    const result = await runSeedsCalibrate({
      dryRun: true,
      labelFile: LABEL_FIXTURE,
      env: hmacEnv(),
      stdout,
    });
    expect(result.exitCode).toBe(0);
    expect(text()).toContain('plan_n_labeled=4');
    expect(text()).toContain('plan_n_shill=2');
    expect(text()).toContain('plan_thresholds=0.18,0.22,0.25,0.28,0.32,0.38');
    expect(text()).toContain('plan_shill_score_threshold=75');
  });

  it('exits 2 when live calibrate has no run id', async () => {
    const dir = await tmp();
    await expect(
      runSeedsCalibrate({
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
      }),
    ).rejects.toBeInstanceOf(RunIdError);
  });

  it('loads labels, runs the sweep SQL, and does not INSERT pipeline_runs', async () => {
    const dir = await tmp();
    const latestPath = path.join(dir, 'data', 'runs', 'latest');
    writeLatestRun(
      {
        pipeline_run_id: RUN,
        crawl_batch_id: BATCH,
        phase: 'analyze',
        started_at: '2026-03-01T00:00:00.000Z',
      },
      latestPath,
    );
    const { bq, calls } = mockBigQuery({ existingRun: true });
    const { stdout, text } = collectStdout();
    const result = await runSeedsCalibrate({
      continueLatest: true,
      labelFile: LABEL_FIXTURE,
      cwd: dir,
      latestPath,
      env: gcpEnv(),
      stdout,
      bigquery: bq,
      repoRoot: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.pipeline_run_id).toBe(RUN);
    expect(result.rows).toHaveLength(2);
    expect(text()).toContain(`pipeline_run_id=${RUN}`);
    expect(text()).toContain('metric_kind=layer2_distance');
    expect(text()).toContain('metric_kind=layer3_score');
    expect(text()).toContain('COSINE_DISTANCE_THRESHOLD');
    const joined = calls.map((call) => call.query).join('\n');
    expect(joined).toContain('human_labels');
    expect(joined).toContain('calibration_sweep');
    expect(joined).toContain('UNNEST([0.18, 0.22, 0.25, 0.28, 0.32, 0.38])');
    expect(joined).not.toMatch(/INSERT INTO[\s\S]+pipeline_runs/);
    assertNoNullParams(calls);
  });

  it('fails when the run has no labels and no --label-file', async () => {
    const dir = await tmp();
    const { bq } = mockBigQuery({ existingRun: true, nLabeled: 0 });
    await expect(
      runSeedsCalibrate({
        pipelineRunId: RUN,
        cwd: dir,
        env: gcpEnv(),
        stdout: { write: () => undefined },
        bigquery: bq,
        repoRoot: process.cwd(),
      }),
    ).rejects.toBeInstanceOf(SeedsUsageError);
  });
});
