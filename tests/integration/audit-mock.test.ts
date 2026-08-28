// SPDX-License-Identifier: GPL-3.0-only
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GeminiClient, GenerateReviewResult } from '../../src/audit/gemini-client.js';
import {
  createMemoryAuditDb,
  createMemoryCheckpoint,
  createMemoryPipelineRuns,
  type MemoryAuditDb,
} from '../../src/audit/memory-store.js';
import { runAudit } from '../../src/cli/commands/audit.js';
import { buildProgram } from '../../src/cli/main.js';
import { RunIdError } from '../../src/shared/run-id.js';

const SALT = '0123456789abcdef0123456789abcdef';
const RUN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMMENT =
  '今次係我親身試用過先敢講，真係同廣告講嘅一樣，用落好舒服，效果好明顯。';

const VALID_PAYLOAD = {
  shill_score: 82,
  template_detected: true,
  template_id: 'seed_personal_trial',
  template_name: 'personal_trial',
  linguistic_style: 'canned_pr',
  detected_signals: [{ code: 'TEMPLATE_OPENER', span: '親身試用', start_char: 4, end_char: 8 }],
  rationale_short: '模版開場而無使用細節。',
};

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ecom-shill-audit-'));
  tmpDirs.push(dir);
  return dir;
}

function gcpEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    REVIEWER_ID_SALT: SALT,
    APP_ENV: 'test',
    LOG_LEVEL: 'silent',
    GCP_PROJECT: 'demo-project',
    GCP_LOCATION: 'asia-east1',
    BQ_DATASET: 'ecom_shill',
    ...overrides,
  };
}

function seedRun(db: MemoryAuditDb, pipelineRunId: string, n = 20): void {
  db.pipelineRuns.set(pipelineRunId, {
    pipeline_run_id: pipelineRunId,
    status: 'succeeded',
    heartbeat_at: new Date('2026-03-01T00:00:00.000Z'),
    phase: 'layer1',
  });
  for (let i = 0; i < n; i += 1) {
    const review_id = `rev-${String(i).padStart(2, '0')}`;
    if (db.raw.every((row) => row.review_id !== review_id)) {
      db.raw.push({ review_id, content_hash: `hash-${review_id}` });
    }
    db.stage2.push({
      pipeline_run_id: pipelineRunId,
      review_id,
      comment_text: COMMENT,
      store_id: 'store_a',
      product_id: 'prod_a',
      matched_seed_id: 'seed_personal_trial',
      matched_seed_category: 'personal_trial',
      content_hash: `hash-${review_id}`,
    });
  }
}

function countingGemini(opts?: {
  fail429OnceFor?: Set<string>;
  payload?: unknown;
  trackInflight?: { max: number; current: number };
}): { client: GeminiClient; calls: number; byReview: Map<string, number> } {
  const byReview = new Map<string, number>();
  const state = { calls: 0 };
  const fail429 = opts?.fail429OnceFor ?? new Set<string>();
  const payload = opts?.payload ?? VALID_PAYLOAD;
  const track = opts?.trackInflight;
  const client: GeminiClient = {
    modelId: 'mock',
    async generate(input) {
      state.calls += 1;
      const match = /評論正文：\n([\s\S]*?)\n\n最接近種子/.exec(input.userPrompt);
      const comment = match?.[1] ?? '';
      const reviewKey = comment;
      byReview.set(reviewKey, (byReview.get(reviewKey) ?? 0) + 1);
      if (track !== undefined) {
        track.current += 1;
        track.max = Math.max(track.max, track.current);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 15);
        });
        track.current -= 1;
      }
      const result: GenerateReviewResult = {
        text: JSON.stringify(payload),
        thoughtsTokenCount: 0,
        promptTokenCount: 12,
        candidatesTokenCount: 24,
      };
      // 429 once per marked review: first generate for that comment throws.
      if (fail429.has(comment) && (byReview.get(reviewKey) ?? 0) === 1) {
        throw { status: 429, message: 'rate limited' };
      }
      return result;
    },
  };
  return {
    get calls() {
      return state.calls;
    },
    client,
    byReview,
  };
}

async function runWithDb(
  db: MemoryAuditDb,
  opts: {
    pipelineRunId: string;
    env?: NodeJS.ProcessEnv;
    forceRescore?: boolean;
    skipExisting?: boolean;
    concurrency?: number;
    limit?: number;
    gemini?: GeminiClient;
    sleep?: (ms: number) => Promise<void>;
    abortSignal?: AbortSignal;
  },
) {
  const dir = await tmp();
  const gemini = opts.gemini ?? countingGemini().client;
  return runAudit({
    pipelineRunId: opts.pipelineRunId,
    cwd: dir,
    latestPath: path.join(dir, 'data', 'runs', 'latest'),
    env: opts.env ?? gcpEnv(),
    stdout: { write: () => undefined },
    checkpoint: createMemoryCheckpoint(db),
    pipelineRuns: createMemoryPipelineRuns(db),
    gemini,
    heartbeatMs: 0,
    sleep: opts.sleep ?? (async () => undefined),
    random: () => 0,
    ...(opts.forceRescore === undefined ? {} : { forceRescore: opts.forceRescore }),
    ...(opts.skipExisting === undefined ? {} : { skipExisting: opts.skipExisting }),
    ...(opts.concurrency === undefined ? {} : { concurrency: opts.concurrency }),
    ...(opts.limit === undefined ? {} : { limit: opts.limit }),
    ...(opts.abortSignal === undefined ? {} : { abortSignal: opts.abortSignal }),
  });
}

describe('audit CLI flags', () => {
  it('lists run id flags and is no longer not implemented', async () => {
    const audit = buildProgram().commands.find((cmd) => cmd.name() === 'audit');
    expect(audit?.helpInformation()).toContain('--pipeline-run-id');
    expect(audit?.helpInformation()).toContain('--force-rescore');
    const src = await readFile(path.join(process.cwd(), 'src/cli/main.ts'), 'utf8');
    expect(src).not.toMatch(/notImplemented\('audit'\)/);
    expect(src).toContain('auditAction');
  });
});

describe('runAudit validation', () => {
  it('exits 2 when pipeline run id flags are missing', async () => {
    const dir = await tmp();
    const db = createMemoryAuditDb();
    await expect(
      runAudit({
        cwd: dir,
        latestPath: path.join(dir, 'data', 'runs', 'latest'),
        env: gcpEnv(),
        stdout: { write: () => undefined },
        checkpoint: createMemoryCheckpoint(db),
        pipelineRuns: createMemoryPipelineRuns(db),
        gemini: countingGemini().client,
        heartbeatMs: 0,
      }),
    ).rejects.toBeInstanceOf(RunIdError);
  });

  it('exits 2 when the pipeline run does not exist (never inserts pipeline_runs)', async () => {
    const db = createMemoryAuditDb();
    await expect(runWithDb(db, { pipelineRunId: RUN_A })).rejects.toBeInstanceOf(RunIdError);
    expect(db.pipelineRuns.size).toBe(0);
  });

  it('rejects concurrency outside 5-10', async () => {
    const db = createMemoryAuditDb();
    seedRun(db, RUN_A, 1);
    await expect(runWithDb(db, { pipelineRunId: RUN_A, concurrency: 4 })).rejects.toThrow(
      /concurrency/,
    );
    await expect(runWithDb(db, { pipelineRunId: RUN_A, concurrency: 11 })).rejects.toThrow(
      /concurrency/,
    );
  });
});

describe('audit mock call-count', () => {
  it('scores 20 reviews with 20 Gemini calls, then 0 on rerun of the same run', async () => {
    const db = createMemoryAuditDb();
    seedRun(db, RUN_A, 20);
    const first = countingGemini();
    const result1 = await runWithDb(db, { pipelineRunId: RUN_A, gemini: first.client, concurrency: 8 });
    expect(result1.n_gemini_http_calls).toBe(20);
    expect(result1.n_scored).toBe(20);
    expect(result1.n_copied).toBe(0);
    expect(result1.status).toBe('succeeded');
    expect(db.assessments).toHaveLength(20);
    expect(db.assessments.every((row) => row.score_source === 'gemini')).toBe(true);
    expect(db.pipelineRuns.get(RUN_A)?.status).toBe('succeeded');

    const second = countingGemini();
    const result2 = await runWithDb(db, { pipelineRunId: RUN_A, gemini: second.client });
    expect(result2.n_gemini_http_calls).toBe(0);
    expect(result2.n_scored).toBe(0);
    expect(result2.n_pending).toBe(0);
  });

  it('copy-forwards 20 rows to a new run with 0 Gemini calls when model and prompt match', async () => {
    const db = createMemoryAuditDb();
    seedRun(db, RUN_A, 20);
    await runWithDb(db, {
      pipelineRunId: RUN_A,
      gemini: countingGemini().client,
      env: gcpEnv({ GEMINI_MODEL: 'model-a' }),
    });

    seedRun(db, RUN_B, 20);
    const copyGemini = countingGemini();
    const result = await runWithDb(db, {
      pipelineRunId: RUN_B,
      gemini: copyGemini.client,
      env: gcpEnv({ GEMINI_MODEL: 'model-a' }),
    });
    expect(result.n_gemini_http_calls).toBe(0);
    expect(result.n_copied).toBe(20);
    const copied = db.assessments.filter((row) => row.pipeline_run_id === RUN_B);
    expect(copied).toHaveLength(20);
    expect(copied.every((row) => row.score_source === 'copied')).toBe(true);
  });

  it('does not copy-forward when GEMINI_MODEL changes; 20 new calls', async () => {
    const db = createMemoryAuditDb();
    seedRun(db, RUN_A, 20);
    await runWithDb(db, {
      pipelineRunId: RUN_A,
      gemini: countingGemini().client,
      env: gcpEnv({ GEMINI_MODEL: 'model-a' }),
    });

    seedRun(db, RUN_B, 20);
    const next = countingGemini();
    const result = await runWithDb(db, {
      pipelineRunId: RUN_B,
      gemini: next.client,
      env: gcpEnv({ GEMINI_MODEL: 'model-b' }),
    });
    expect(result.n_copied).toBe(0);
    expect(result.n_gemini_http_calls).toBe(20);
    expect(result.n_copy_skipped_model_mismatch).toBe(20);
    expect(db.assessments.filter((row) => row.pipeline_run_id === RUN_B).every((row) => row.score_source === 'gemini')).toBe(
      true,
    );
  });

  it('retries two 429s with concurrency 8', async () => {
    const db = createMemoryAuditDb();
    seedRun(db, RUN_A, 20);
    const inner = countingGemini();
    let http = 0;
    const gemini: GeminiClient = {
      modelId: 'mock',
      async generate(input) {
        http += 1;
        if (http <= 2) {
          throw { status: 429, message: 'rate limited' };
        }
        return inner.client.generate(input);
      },
    };
    const result = await runWithDb(db, {
      pipelineRunId: RUN_A,
      gemini,
      concurrency: 8,
      sleep: async () => undefined,
    });
    expect(result.n_scored).toBe(20);
    expect(result.n_gemini_http_calls).toBe(22);
    expect(result.n_errors).toBe(0);
  });

  it('honors --limit on new Gemini calls and --force-rescore reruns them', async () => {
    const db = createMemoryAuditDb();
    seedRun(db, RUN_A, 20);
    const limited = countingGemini();
    const first = await runWithDb(db, {
      pipelineRunId: RUN_A,
      gemini: limited.client,
      limit: 3,
    });
    expect(first.n_gemini_http_calls).toBe(3);
    expect(first.n_scored).toBe(3);
    expect(first.n_pending).toBe(20);

    const again = countingGemini();
    const second = await runWithDb(db, { pipelineRunId: RUN_A, gemini: again.client });
    expect(second.n_gemini_http_calls).toBe(17);

    const rescore = countingGemini();
    const third = await runWithDb(db, {
      pipelineRunId: RUN_A,
      gemini: rescore.client,
      forceRescore: true,
    });
    expect(third.n_copied).toBe(0);
    expect(third.n_gemini_http_calls).toBe(20);
    expect(db.assessments.filter((row) => row.pipeline_run_id === RUN_A)).toHaveLength(20);
  });

  it('keeps in-flight concurrency at most 8', async () => {
    const db = createMemoryAuditDb();
    seedRun(db, RUN_A, 20);
    const track = { max: 0, current: 0 };
    const gemini = countingGemini({ trackInflight: track });
    await runWithDb(db, { pipelineRunId: RUN_A, gemini: gemini.client, concurrency: 8 });
    expect(track.max).toBeGreaterThan(1);
    expect(track.max).toBeLessThanOrEqual(8);
  });

  it('DLQ schema failures without retrying', async () => {
    const db = createMemoryAuditDb();
    seedRun(db, RUN_A, 1);
    const gemini: GeminiClient = {
      modelId: 'mock',
      generate: async () => ({ text: '{not-json' }),
    };
    const result = await runWithDb(db, { pipelineRunId: RUN_A, gemini });
    expect(result.n_errors).toBe(1);
    expect(result.n_scored).toBe(0);
    expect(db.errors).toHaveLength(1);
    expect(db.errors[0]?.error_class).toBe('schema');
    expect(db.errors[0]?.retryable).toBe(false);
  });
});

describe.skipIf(process.env['GEMINI_LIVE'] !== '1')('live Vertex generateContent', () => {
  it('is opt-in via GEMINI_LIVE=1 (CI never sets this)', () => {
    expect(process.env['GEMINI_LIVE']).toBe('1');
  });
});
