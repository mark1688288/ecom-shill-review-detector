// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BigQuery } from '@google-cloud/bigquery';
import { z } from 'zod';
import { estimateGeminiCostUsd } from '../../audit/gemini-client.js';
import { SHILL_SCORE_THRESHOLD } from '../../analysis/collisions.js';
import {
  assertBqConfig,
  bqConfigFromGcp,
  getBigQuery,
  quotedInformationSchemaTables,
  quotedTable,
  runQuery,
  sqlParamOrNull,
  type BqConfig,
} from '../../shared/bq.js';
import { loadEnv, type GcpEnv } from '../../shared/env.js';
import { createLogger } from '../../shared/logger.js';
import { parseBqNumber, runQueryLogged } from '../../shared/metrics.js';
import {
  printPipelineRunId,
  resolvePipelineRunId,
  RunIdError,
} from '../../shared/run-id.js';

const DEFAULT_REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

export const HYPOTHESIS_SEED_VERSION = 'v0_hypothesis';

export const SEED_CATEGORIES = [
  'personal_trial',
  'skin_result',
  'repurchase',
  'social_proof',
  'value_for_money',
  'brand_comparison',
  'packaging_care',
] as const;

export type SeedCategory = (typeof SEED_CATEGORIES)[number];

export const HUMAN_LABELS = ['shill', 'not_shill', 'unsure'] as const;
export type HumanLabel = (typeof HUMAN_LABELS)[number];

export const LABEL_STRATA = [
  'near_seed',
  'far_seed',
  'genuine_long',
  'logistics_edge',
] as const;

export type LabelStratum = (typeof LABEL_STRATA)[number];

export const CALIBRATION_DISTANCE_THRESHOLDS = [0.18, 0.22, 0.25, 0.28, 0.32, 0.38] as const;

/** Prompt/output token stand-ins when a run has no observed Gemini usage yet. */
export const CALIBRATION_PROMPT_TOKENS = 900;
export const CALIBRATION_OUTPUT_TOKENS = 250;

const UPSERT_TABLES = ['pr_seed_phrases'] as const;

const CALIBRATE_TABLES = [
  'pipeline_runs',
  'human_labels',
  'calibration_sweep',
  'layer2_distance_audit',
  'gemini_review_assessments',
  'stage2_suspicious_for_gemini',
] as const;

const seedRowSchema = z.object({
  seed_id: z.string().min(1),
  category: z.enum(SEED_CATEGORIES),
  seed_text: z.string().min(1),
});

const labelRowSchema = z.object({
  review_id: z.string().min(1),
  label: z.enum(HUMAN_LABELS),
  stratum: z.enum(LABEL_STRATA).optional(),
  notes: z.string().optional(),
});

export type SeedPhraseRow = z.infer<typeof seedRowSchema>;
export type HumanLabelRow = z.infer<typeof labelRowSchema>;

export class SeedsUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = 'SeedsUsageError';
  }
}

export type SeedsUpsertCliOptions = {
  input?: string;
  seedVersion?: string;
  activate?: boolean;
  dryRun?: boolean;
};

export type SeedsCalibrateCliOptions = {
  pipelineRunId?: string;
  continueLatest?: boolean;
  labelFile?: string;
  dryRun?: boolean;
};

export type RunSeedsUpsertOptions = SeedsUpsertCliOptions & {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: { write(chunk: string): unknown };
  bigquery?: BigQuery;
  repoRoot?: string;
};

export type RunSeedsCalibrateOptions = SeedsCalibrateCliOptions & {
  cwd?: string;
  latestPath?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: { write(chunk: string): unknown };
  bigquery?: BigQuery;
  repoRoot?: string;
};

export type LabelSummary = {
  n_labeled: number;
  n_shill: number;
  n_not_shill: number;
  n_unsure: number;
};

export type SeedsUpsertResult = {
  exitCode: number;
  dryRun: boolean;
  seed_version: string;
  n_upserted: number;
  activate: boolean;
};

export type CalibrationSweepRow = {
  metric_kind: string;
  cosine_distance_threshold: number;
  shill_score_threshold: number | null;
  n_labeled: number;
  n_shill: number;
  n_not_shill: number;
  n_unsure: number;
  n_predicted_positive: number;
  n_true_positive: number;
  n_false_positive: number;
  n_false_negative: number;
  precision: number | null;
  recall: number | null;
  n_predicted_stage2: number;
  estimated_gemini_usd: number | null;
};

export type SeedsCalibrateResult = {
  exitCode: number;
  dryRun: boolean;
  pipeline_run_id?: string;
  n_labeled: number;
  n_shill: number;
  n_not_shill: number;
  n_unsure: number;
  rows: CalibrationSweepRow[];
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isBqNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const rec = err as { code?: unknown; status?: unknown; message?: unknown };
  if (
    rec.code === 404 ||
    rec.code === '404' ||
    rec.status === 404 ||
    rec.status === 'NOT_FOUND'
  ) {
    return true;
  }
  const message = typeof rec.message === 'string' ? rec.message : errorMessage(err);
  return /404|not found/i.test(message);
}

function substituteDataset(sql: string, dataset: string): string {
  return sql.replaceAll('ecom_shill', dataset);
}

function readRepoSql(repoRoot: string, relativePath: string, dataset: string): string {
  const sql = readFileSync(path.join(repoRoot, relativePath), 'utf8');
  return substituteDataset(sql, dataset);
}

function asNumber(value: unknown, field: string): number {
  const n = parseBqNumber(value);
  if (n === null || !Number.isFinite(n)) {
    throw new Error(`seeds expected number ${field}, got ${String(value)}`);
  }
  return n;
}

function parseJsonDocuments(text: string, label: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new SeedsUsageError(`${label} is empty`);
  }
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (err) {
      throw new SeedsUsageError(`${label} is not valid JSON: ${errorMessage(err)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new SeedsUsageError(`${label} JSON must be an array of objects`);
    }
    return parsed;
  }
  const rows: unknown[] = [];
  for (const [index, line] of trimmed.split('\n').entries()) {
    const item = line.trim();
    if (item.length === 0) {
      continue;
    }
    try {
      rows.push(JSON.parse(item) as unknown);
    } catch (err) {
      throw new SeedsUsageError(
        `${label} line ${String(index + 1)} is not valid JSON: ${errorMessage(err)}`,
      );
    }
  }
  if (rows.length === 0) {
    throw new SeedsUsageError(`${label} is empty`);
  }
  return rows;
}

export function parseSeedDocument(text: string): SeedPhraseRow[] {
  const raw = parseJsonDocuments(text, 'seed input');
  const rows: SeedPhraseRow[] = [];
  for (const [index, item] of raw.entries()) {
    const parsed = seedRowSchema.safeParse(item);
    if (!parsed.success) {
      throw new SeedsUsageError(`seed input row ${String(index + 1)}: ${parsed.error.message}`);
    }
    rows.push({
      seed_id: parsed.data.seed_id,
      category: parsed.data.category,
      seed_text: parsed.data.seed_text.normalize('NFC').trim(),
    });
  }
  return validateSeedSet(rows);
}

export function parseLabelDocument(text: string): HumanLabelRow[] {
  const raw = parseJsonDocuments(text, 'label file');
  const rows: HumanLabelRow[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    const parsed = labelRowSchema.safeParse(item);
    if (!parsed.success) {
      throw new SeedsUsageError(`label file row ${String(index + 1)}: ${parsed.error.message}`);
    }
    if (seen.has(parsed.data.review_id)) {
      throw new SeedsUsageError(`label file has duplicate review_id ${parsed.data.review_id}`);
    }
    seen.add(parsed.data.review_id);
    const row: HumanLabelRow = {
      review_id: parsed.data.review_id,
      label: parsed.data.label,
    };
    if (parsed.data.stratum !== undefined) {
      row.stratum = parsed.data.stratum;
    }
    if (parsed.data.notes !== undefined) {
      row.notes = parsed.data.notes;
    }
    rows.push(row);
  }
  return rows;
}

export function validateSeedSet(rows: SeedPhraseRow[]): SeedPhraseRow[] {
  if (rows.length !== SEED_CATEGORIES.length) {
    throw new SeedsUsageError(
      `seed input must have exactly ${String(SEED_CATEGORIES.length)} rows (one per category slot), got ${String(rows.length)}`,
    );
  }
  const ids = new Set<string>();
  const categories = new Set<SeedCategory>();
  for (const row of rows) {
    if (row.seed_text.length === 0) {
      throw new SeedsUsageError(`seed_id ${row.seed_id} has empty seed_text`);
    }
    if (ids.has(row.seed_id)) {
      throw new SeedsUsageError(`duplicate seed_id ${row.seed_id}`);
    }
    ids.add(row.seed_id);
    if (categories.has(row.category)) {
      throw new SeedsUsageError(`duplicate category ${row.category}`);
    }
    categories.add(row.category);
  }
  for (const category of SEED_CATEGORIES) {
    if (!categories.has(category)) {
      throw new SeedsUsageError(`seed input missing category ${category}`);
    }
  }
  return rows;
}

export function summarizeLabels(rows: readonly HumanLabelRow[]): LabelSummary {
  let n_shill = 0;
  let n_not_shill = 0;
  let n_unsure = 0;
  for (const row of rows) {
    if (row.label === 'shill') {
      n_shill += 1;
    } else if (row.label === 'not_shill') {
      n_not_shill += 1;
    } else {
      n_unsure += 1;
    }
  }
  return {
    n_labeled: rows.length,
    n_shill,
    n_not_shill,
    n_unsure,
  };
}

function assertSeedVersion(value: string | undefined): string {
  const version = value?.trim() ?? '';
  if (version.length === 0) {
    throw new SeedsUsageError('--seed-version is required');
  }
  if (version === HYPOTHESIS_SEED_VERSION) {
    throw new SeedsUsageError(
      `refusing to upsert ${HYPOTHESIS_SEED_VERSION}; insert a new seed_version (v0 is owned by sql/seeds/pr_seed_phrases_v0.sql)`,
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(version)) {
    throw new SeedsUsageError('--seed-version must match [A-Za-z0-9._-]+');
  }
  return version;
}

function readInputFile(cwd: string, input: string | undefined, what: string): string {
  if (input === undefined || input.trim() === '') {
    throw new SeedsUsageError(`${what} is required`);
  }
  const resolved = path.resolve(cwd, input);
  try {
    return readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new SeedsUsageError(`cannot read ${what} ${input}: ${errorMessage(err)}`);
  }
}

async function assertTablesExist(
  bq: BigQuery,
  config: BqConfig,
  tables: readonly string[],
  command: string,
): Promise<void> {
  let rows: Record<string, unknown>[];
  try {
    const names = tables.map((name) => `'${name}'`).join(', ');
    rows = await runQuery(
      bq,
      config,
      `SELECT table_name FROM ${quotedInformationSchemaTables(config)}
WHERE table_name IN (${names})`,
    );
  } catch (err) {
    if (isBqNotFoundError(err)) {
      throw new Error(`${command} missing dataset ${config.dataset}; run scripts/bq-apply.sh`);
    }
    throw err;
  }
  const found = new Set(
    rows
      .map((row) => row['table_name'])
      .filter((name): name is string => typeof name === 'string'),
  );
  const missing = tables.filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new Error(
      `${command} missing table(s) ${missing.join(', ')}; run scripts/bq-apply.sh`,
    );
  }
}

async function requireExistingPipelineRun(
  bq: BigQuery,
  config: BqConfig,
  pipelineRunId: string,
): Promise<void> {
  const table = quotedTable(config, 'pipeline_runs');
  const rows = await runQuery(
    bq,
    config,
    `SELECT pipeline_run_id FROM ${table}
WHERE pipeline_run_id = @pipeline_run_id
LIMIT 1`,
    { pipeline_run_id: pipelineRunId },
  );
  if (rows.length === 0) {
    throw new Error(`pipeline run not found: ${pipelineRunId}`);
  }
}

function requireGcp(gcp: GcpEnv | undefined, command: string): GcpEnv {
  if (gcp === undefined) {
    throw new Error(`GCP_PROJECT, GCP_LOCATION, and BQ_DATASET are required for ${command}`);
  }
  return gcp;
}

function writePlanLine(stdout: { write(chunk: string): unknown }, key: string, value: string): void {
  stdout.write(`${key}=${value}\n`);
}

export async function runSeedsUpsert(opts: RunSeedsUpsertOptions): Promise<SeedsUpsertResult> {
  const dryRun = opts.dryRun === true;
  const activate = opts.activate !== false;
  const cwd = opts.cwd ?? process.cwd();
  const loaded = loadEnv({
    command: 'seeds',
    dryRun,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  const seedVersion = assertSeedVersion(opts.seedVersion);
  const seeds = parseSeedDocument(readInputFile(cwd, opts.input, '--input'));
  const stdout = opts.stdout ?? process.stdout;

  if (dryRun) {
    writePlanLine(stdout, 'plan_n_seeds', String(seeds.length));
    writePlanLine(stdout, 'plan_seed_version', seedVersion);
    writePlanLine(stdout, 'plan_activate', String(activate));
    seeds.forEach((row, i) => {
      writePlanLine(
        stdout,
        `plan_seed_${String(i + 1)}`,
        JSON.stringify({ seed_id: row.seed_id, category: row.category }),
      );
    });
    return {
      exitCode: 0,
      dryRun: true,
      seed_version: seedVersion,
      n_upserted: 0,
      activate,
    };
  }

  const gcp = requireGcp(loaded.gcp, 'seeds upsert');
  const config = bqConfigFromGcp(gcp);
  assertBqConfig(config);
  const logger = createLogger(loaded.hmac.LOG_LEVEL);
  const bq = opts.bigquery ?? getBigQuery(config);
  await assertTablesExist(bq, config, UPSERT_TABLES, 'seeds upsert');

  const table = quotedTable(config, 'pr_seed_phrases');
  await runQueryLogged(
    bq,
    config,
    `DELETE FROM ${table}
WHERE seed_version = @seed_version`,
    { seed_version: seedVersion },
    logger,
  );

  for (const row of seeds) {
    await runQueryLogged(
      bq,
      config,
      `INSERT INTO ${table} (
  seed_id, category, seed_text, seed_version, is_active, created_at
) VALUES (
  @seed_id, @category, @seed_text, @seed_version, TRUE, CURRENT_TIMESTAMP()
)`,
      {
        seed_id: row.seed_id,
        category: row.category,
        seed_text: row.seed_text,
        seed_version: seedVersion,
      },
      logger,
    );
  }

  if (activate) {
    await runQueryLogged(
      bq,
      config,
      `UPDATE ${table}
SET is_active = FALSE
WHERE seed_version != @seed_version AND is_active = TRUE`,
      { seed_version: seedVersion },
      logger,
    );
  }

  stdout.write(
    `seed_version=${seedVersion} n_upserted=${String(seeds.length)} activate=${String(activate)}\n`,
  );
  stdout.write(
    `hint=re-run layer2 --seed-version ${seedVersion} (review embeddings can stay); set SEED_VERSION if this should become the default\n`,
  );
  logger.info({
    event: 'seeds_upsert_done',
    seed_version: seedVersion,
    n_upserted: seeds.length,
    activate,
  });
  return {
    exitCode: 0,
    dryRun: false,
    seed_version: seedVersion,
    n_upserted: seeds.length,
    activate,
  };
}

async function upsertLabelRows(
  bq: BigQuery,
  config: BqConfig,
  pipelineRunId: string,
  rows: HumanLabelRow[],
): Promise<void> {
  const table = quotedTable(config, 'human_labels');
  const reviewIds = rows.map((row) => row.review_id);
  await runQuery(
    bq,
    config,
    `DELETE FROM ${table}
WHERE pipeline_run_id = @pipeline_run_id
  AND review_id IN UNNEST(@review_ids)`,
    { pipeline_run_id: pipelineRunId, review_ids: reviewIds },
  );

  const params: Record<string, unknown> = { pipeline_run_id: pipelineRunId };
  const values = rows.map((row, i) => {
    params[`review_id_${String(i)}`] = row.review_id;
    params[`label_${String(i)}`] = row.label;
    const stratumSql = sqlParamOrNull(
      params,
      `stratum_${String(i)}`,
      row.stratum === undefined ? null : row.stratum,
      'STRING',
    );
    const notesSql = sqlParamOrNull(
      params,
      `notes_${String(i)}`,
      row.notes === undefined ? null : row.notes,
      'STRING',
    );
    return `(@pipeline_run_id, @review_id_${String(i)}, @label_${String(i)}, ${stratumSql}, ${notesSql}, CURRENT_TIMESTAMP())`;
  });
  await runQuery(
    bq,
    config,
    `INSERT INTO ${table} (
  pipeline_run_id, review_id, label, stratum, notes, labeled_at
) VALUES ${values.join(',\n')}`,
    params,
  );
}

function parseSweepRow(row: Record<string, unknown>): CalibrationSweepRow {
  return {
    metric_kind: typeof row['metric_kind'] === 'string' ? row['metric_kind'] : '',
    cosine_distance_threshold: asNumber(
      row['cosine_distance_threshold'],
      'cosine_distance_threshold',
    ),
    shill_score_threshold: parseBqNumber(row['shill_score_threshold']),
    n_labeled: asNumber(row['n_labeled'], 'n_labeled'),
    n_shill: asNumber(row['n_shill'], 'n_shill'),
    n_not_shill: asNumber(row['n_not_shill'], 'n_not_shill'),
    n_unsure: asNumber(row['n_unsure'], 'n_unsure'),
    n_predicted_positive: asNumber(row['n_predicted_positive'], 'n_predicted_positive'),
    n_true_positive: asNumber(row['n_true_positive'], 'n_true_positive'),
    n_false_positive: asNumber(row['n_false_positive'], 'n_false_positive'),
    n_false_negative: asNumber(row['n_false_negative'], 'n_false_negative'),
    precision: parseBqNumber(row['precision']),
    recall: parseBqNumber(row['recall']),
    n_predicted_stage2: asNumber(row['n_predicted_stage2'], 'n_predicted_stage2'),
    estimated_gemini_usd: parseBqNumber(row['estimated_gemini_usd']),
  };
}

function formatMetric(value: number | null): string {
  if (value === null) {
    return 'null';
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export async function runSeedsCalibrate(
  opts: RunSeedsCalibrateOptions,
): Promise<SeedsCalibrateResult> {
  const dryRun = opts.dryRun === true;
  const cwd = opts.cwd ?? process.cwd();
  const loaded = loadEnv({
    command: 'seeds',
    dryRun,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  const stdout = opts.stdout ?? process.stdout;
  const labels =
    opts.labelFile === undefined || opts.labelFile.trim() === ''
      ? null
      : parseLabelDocument(readInputFile(cwd, opts.labelFile, '--label-file'));

  if (dryRun) {
    if (labels === null) {
      throw new SeedsUsageError('seeds calibrate --dry-run requires --label-file');
    }
    const summary = summarizeLabels(labels);
    writePlanLine(stdout, 'plan_n_labeled', String(summary.n_labeled));
    writePlanLine(stdout, 'plan_n_shill', String(summary.n_shill));
    writePlanLine(stdout, 'plan_n_not_shill', String(summary.n_not_shill));
    writePlanLine(stdout, 'plan_n_unsure', String(summary.n_unsure));
    writePlanLine(stdout, 'plan_thresholds', CALIBRATION_DISTANCE_THRESHOLDS.join(','));
    writePlanLine(stdout, 'plan_shill_score_threshold', String(SHILL_SCORE_THRESHOLD));
    return {
      exitCode: 0,
      dryRun: true,
      n_labeled: summary.n_labeled,
      n_shill: summary.n_shill,
      n_not_shill: summary.n_not_shill,
      n_unsure: summary.n_unsure,
      rows: [],
    };
  }

  const latestPath = opts.latestPath ?? path.join(cwd, 'data', 'runs', 'latest');
  const resolved = resolvePipelineRunId({
    allowCreate: false,
    latestPath,
    ...(opts.pipelineRunId === undefined ? {} : { pipelineRunId: opts.pipelineRunId }),
    ...(opts.continueLatest === undefined ? {} : { continueLatest: opts.continueLatest }),
  });
  const gcp = requireGcp(loaded.gcp, 'seeds calibrate');
  const config = bqConfigFromGcp(gcp);
  assertBqConfig(config);
  const logger = createLogger(loaded.hmac.LOG_LEVEL);
  const bq = opts.bigquery ?? getBigQuery(config);
  const repoRoot = opts.repoRoot ?? DEFAULT_REPO_ROOT;

  await assertTablesExist(bq, config, CALIBRATE_TABLES, 'seeds calibrate');
  await requireExistingPipelineRun(bq, config, resolved.pipeline_run_id);

  if (labels !== null) {
    await upsertLabelRows(bq, config, resolved.pipeline_run_id, labels);
  }

  const existing = await runQuery(
    bq,
    config,
    `SELECT
  COUNT(*) AS n_labeled,
  COUNTIF(label = 'shill') AS n_shill,
  COUNTIF(label = 'not_shill') AS n_not_shill,
  COUNTIF(label = 'unsure') AS n_unsure
FROM ${quotedTable(config, 'human_labels')}
WHERE pipeline_run_id = @pipeline_run_id`,
    { pipeline_run_id: resolved.pipeline_run_id },
  );
  const countsRow = existing[0];
  const nLabeled = countsRow === undefined ? 0 : asNumber(countsRow['n_labeled'], 'n_labeled');
  if (nLabeled === 0) {
    throw new SeedsUsageError(
      `no human_labels for pipeline_run_id=${resolved.pipeline_run_id}; pass --label-file`,
    );
  }
  const summary: LabelSummary = {
    n_labeled: nLabeled,
    n_shill: countsRow === undefined ? 0 : asNumber(countsRow['n_shill'], 'n_shill'),
    n_not_shill: countsRow === undefined ? 0 : asNumber(countsRow['n_not_shill'], 'n_not_shill'),
    n_unsure: countsRow === undefined ? 0 : asNumber(countsRow['n_unsure'], 'n_unsure'),
  };

  const usdPerReview = estimateGeminiCostUsd(
    loaded.config.gemini.model,
    CALIBRATION_PROMPT_TOKENS,
    CALIBRATION_OUTPUT_TOKENS,
  );
  const params: Record<string, unknown> = {
    pipeline_run_id: resolved.pipeline_run_id,
    shill_score_threshold: SHILL_SCORE_THRESHOLD,
    current_l2_threshold: loaded.config.layer2.cosine_distance_threshold,
  };
  const usdSql = sqlParamOrNull(params, 'usd_per_review', usdPerReview, 'FLOAT64');
  const calibrationSql = readRepoSql(
    repoRoot,
    'sql/analysis/calibration.sql',
    config.dataset,
  ).replaceAll('@usd_per_review', usdSql);

  await runQueryLogged(bq, config, calibrationSql, params, logger);

  const sweepRows = await runQuery(
    bq,
    config,
    `SELECT
  metric_kind,
  cosine_distance_threshold,
  shill_score_threshold,
  n_labeled,
  n_shill,
  n_not_shill,
  n_unsure,
  n_predicted_positive,
  n_true_positive,
  n_false_positive,
  n_false_negative,
  precision,
  recall,
  n_predicted_stage2,
  estimated_gemini_usd
FROM ${quotedTable(config, 'calibration_sweep')}
WHERE pipeline_run_id = @pipeline_run_id
ORDER BY metric_kind, cosine_distance_threshold`,
    { pipeline_run_id: resolved.pipeline_run_id },
  );
  const rows = sweepRows.map(parseSweepRow);

  printPipelineRunId(resolved.pipeline_run_id, stdout);
  writePlanLine(stdout, 'n_labeled', String(summary.n_labeled));
  for (const row of rows) {
    stdout.write(
      `metric_kind=${row.metric_kind} threshold=${formatMetric(row.cosine_distance_threshold)} precision=${formatMetric(row.precision)} recall=${formatMetric(row.recall)} n_predicted_stage2=${String(row.n_predicted_stage2)} estimated_gemini_usd=${formatMetric(row.estimated_gemini_usd)}\n`,
    );
  }
  stdout.write(
    'hint=0.28 remains the config default until you set COSINE_DISTANCE_THRESHOLD; this command does not write yaml\n',
  );
  logger.info({
    event: 'seeds_calibrate_done',
    pipeline_run_id: resolved.pipeline_run_id,
    n_labeled: summary.n_labeled,
    n_shill: summary.n_shill,
    n_not_shill: summary.n_not_shill,
    n_unsure: summary.n_unsure,
    n_sweep_rows: rows.length,
    shill_score_threshold: SHILL_SCORE_THRESHOLD,
    usd_per_review: usdPerReview,
  });
  return {
    exitCode: 0,
    dryRun: false,
    pipeline_run_id: resolved.pipeline_run_id,
    n_labeled: summary.n_labeled,
    n_shill: summary.n_shill,
    n_not_shill: summary.n_not_shill,
    n_unsure: summary.n_unsure,
    rows,
  };
}

export async function seedsUpsertAction(opts: SeedsUpsertCliOptions): Promise<void> {
  try {
    const result = await runSeedsUpsert(opts);
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
  } catch (err) {
    process.stderr.write(`${errorMessage(err)}\n`);
    if (err instanceof SeedsUsageError) {
      process.exitCode = err.exitCode;
      return;
    }
    process.exitCode = 1;
  }
}

export async function seedsCalibrateAction(opts: SeedsCalibrateCliOptions): Promise<void> {
  try {
    const result = await runSeedsCalibrate(opts);
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
  } catch (err) {
    process.stderr.write(`${errorMessage(err)}\n`);
    if (err instanceof SeedsUsageError || err instanceof RunIdError) {
      process.exitCode = err.exitCode;
      return;
    }
    process.exitCode = 1;
  }
}
