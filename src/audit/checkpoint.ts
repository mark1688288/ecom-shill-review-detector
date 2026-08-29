// SPDX-License-Identifier: GPL-3.0-only
import type { BigQuery } from '@google-cloud/bigquery';
import { quotedInformationSchemaTables, quotedTable, runQuery, type BqConfig } from '../shared/bq.js';
import type { GeminiAssessment } from './schema.js';

export const AUDIT_TABLES = [
  'pipeline_runs',
  'raw_reviews',
  'stage2_suspicious_for_gemini',
  'gemini_review_assessments',
  'gemini_assessment_errors',
] as const;

export type PendingReview = {
  review_id: string;
  comment_text: string;
  store_id: string;
  product_id: string;
  matched_seed_id: string;
  matched_seed_category: string;
  content_hash: string;
};

export type AssessmentRecord = {
  review_id: string;
  pipeline_run_id: string;
  store_id: string;
  product_id: string;
  content_hash: string;
  shill_score: number;
  template_detected: boolean;
  template_id: string | null;
  template_name: string | null;
  linguistic_style: string;
  detected_signals: GeminiAssessment['detected_signals'];
  rationale_short: string | null;
  model_id: string;
  prompt_version: string;
  score_source: 'gemini' | 'copied';
  input_tokens: number | null;
  output_tokens: number | null;
  assessed_at: Date;
  signal_span_mismatch_count: number;
};

export type ErrorRecord = {
  review_id: string;
  pipeline_run_id: string;
  attempt_count: number;
  http_status: number | null;
  error_class: string;
  error_message: string | null;
  retryable: boolean;
  failed_at: Date;
};

export type CopyForwardInput = {
  pipelineRunId: string;
  geminiModel: string;
  promptVersion: string;
};

export type SelectPendingInput = CopyForwardInput & {
  forceRescore: boolean;
};

export type AuditCheckpoint = {
  copyForward: (input: CopyForwardInput) => Promise<{ n_copied: number }>;
  countCopySkippedModelMismatch: (input: CopyForwardInput) => Promise<number>;
  selectPending: (input: SelectPendingInput) => Promise<PendingReview[]>;
  mergeAssessment: (row: AssessmentRecord) => Promise<void>;
  insertError: (row: ErrorRecord) => Promise<void>;
};

export type PipelineRunRow = {
  pipeline_run_id: string;
  status: string;
  heartbeat_at: Date | null;
  phase: string;
};

export type PipelineRunUpdate = {
  pipelineRunId: string;
  status: 'running' | 'succeeded' | 'failed' | 'aborted';
  heartbeatAt: Date;
  finishedAt?: Date | null;
  rowsIn?: number | null;
  rowsOut?: number | null;
  errorMessage?: string | null;
};

export type PipelineRunPort = {
  get: (pipelineRunId: string) => Promise<PipelineRunRow | null>;
  update: (patch: PipelineRunUpdate) => Promise<void>;
};

export function buildCopyForwardSql(config: BqConfig): string {
  const assessments = quotedTable(config, 'gemini_review_assessments');
  const stage2 = quotedTable(config, 'stage2_suspicious_for_gemini');
  const raw = quotedTable(config, 'raw_reviews');
  return `MERGE ${assessments} T
USING (
  SELECT
    s.review_id AS review_id,
    @pipeline_run_id AS pipeline_run_id,
    s.store_id AS store_id,
    s.product_id AS product_id,
    raw.content_hash AS content_hash,
    prev.shill_score AS shill_score,
    prev.template_detected AS template_detected,
    prev.template_id AS template_id,
    prev.template_name AS template_name,
    prev.linguistic_style AS linguistic_style,
    prev.detected_signals AS detected_signals,
    prev.rationale_short AS rationale_short,
    prev.model_id AS model_id,
    prev.prompt_version AS prompt_version,
    'copied' AS score_source,
    prev.input_tokens AS input_tokens,
    prev.output_tokens AS output_tokens,
    CURRENT_TIMESTAMP() AS assessed_at,
    prev.signal_span_mismatch_count AS signal_span_mismatch_count
  FROM ${stage2} s
  JOIN ${raw} raw ON raw.review_id = s.review_id
  JOIN ${assessments} prev
    ON prev.review_id = s.review_id
   AND prev.content_hash = raw.content_hash
   AND prev.model_id = @gemini_model
   AND prev.prompt_version = @prompt_version
   AND prev.pipeline_run_id != @pipeline_run_id
  WHERE s.pipeline_run_id = @pipeline_run_id
  QUALIFY ROW_NUMBER() OVER (PARTITION BY s.review_id ORDER BY prev.assessed_at DESC) = 1
) S
ON T.pipeline_run_id = S.pipeline_run_id AND T.review_id = S.review_id
WHEN NOT MATCHED THEN INSERT (
  review_id, pipeline_run_id, store_id, product_id, content_hash,
  shill_score, template_detected, template_id, template_name,
  linguistic_style, detected_signals, rationale_short,
  model_id, prompt_version, score_source, input_tokens, output_tokens,
  assessed_at, signal_span_mismatch_count
) VALUES (
  S.review_id, S.pipeline_run_id, S.store_id, S.product_id, S.content_hash,
  S.shill_score, S.template_detected, S.template_id, S.template_name,
  S.linguistic_style, S.detected_signals, S.rationale_short,
  S.model_id, S.prompt_version, S.score_source, S.input_tokens, S.output_tokens,
  S.assessed_at, S.signal_span_mismatch_count
)`;
}

export function buildSelectPendingSql(config: BqConfig, forceRescore: boolean): string {
  const assessments = quotedTable(config, 'gemini_review_assessments');
  const stage2 = quotedTable(config, 'stage2_suspicious_for_gemini');
  const raw = quotedTable(config, 'raw_reviews');
  const errors = quotedTable(config, 'gemini_assessment_errors');
  const alreadyScored = forceRescore
    ? ''
    : `
  AND a.review_id IS NULL`;
  return `SELECT s.review_id, s.comment_text, s.store_id, s.product_id,
       s.matched_seed_id, s.matched_seed_category, raw.content_hash
FROM ${stage2} s
JOIN ${raw} raw ON raw.review_id = s.review_id
LEFT JOIN ${assessments} a
  ON a.review_id = s.review_id
 AND a.pipeline_run_id = s.pipeline_run_id
WHERE s.pipeline_run_id = @pipeline_run_id${alreadyScored}
  AND s.review_id NOT IN (
    SELECT review_id FROM ${errors}
    WHERE retryable = FALSE
      AND pipeline_run_id = @pipeline_run_id
  )`;
}

export function buildMergeAssessmentSql(config: BqConfig): string {
  const assessments = quotedTable(config, 'gemini_review_assessments');
  return `MERGE ${assessments} T
USING (
  SELECT
    @review_id AS review_id,
    @pipeline_run_id AS pipeline_run_id,
    @store_id AS store_id,
    @product_id AS product_id,
    @content_hash AS content_hash,
    @shill_score AS shill_score,
    @template_detected AS template_detected,
    @template_id AS template_id,
    @template_name AS template_name,
    @linguistic_style AS linguistic_style,
    PARSE_JSON(@detected_signals) AS detected_signals,
    @rationale_short AS rationale_short,
    @model_id AS model_id,
    @prompt_version AS prompt_version,
    @score_source AS score_source,
    @input_tokens AS input_tokens,
    @output_tokens AS output_tokens,
    TIMESTAMP(@assessed_at) AS assessed_at,
    @signal_span_mismatch_count AS signal_span_mismatch_count
) S
ON T.pipeline_run_id = S.pipeline_run_id AND T.review_id = S.review_id
WHEN NOT MATCHED THEN INSERT (
  review_id, pipeline_run_id, store_id, product_id, content_hash,
  shill_score, template_detected, template_id, template_name,
  linguistic_style, detected_signals, rationale_short,
  model_id, prompt_version, score_source, input_tokens, output_tokens,
  assessed_at, signal_span_mismatch_count
) VALUES (
  S.review_id, S.pipeline_run_id, S.store_id, S.product_id, S.content_hash,
  S.shill_score, S.template_detected, S.template_id, S.template_name,
  S.linguistic_style, S.detected_signals, S.rationale_short,
  S.model_id, S.prompt_version, S.score_source, S.input_tokens, S.output_tokens,
  S.assessed_at, S.signal_span_mismatch_count
)
WHEN MATCHED THEN UPDATE SET
  store_id = S.store_id,
  product_id = S.product_id,
  content_hash = S.content_hash,
  shill_score = S.shill_score,
  template_detected = S.template_detected,
  template_id = S.template_id,
  template_name = S.template_name,
  linguistic_style = S.linguistic_style,
  detected_signals = S.detected_signals,
  rationale_short = S.rationale_short,
  model_id = S.model_id,
  prompt_version = S.prompt_version,
  score_source = S.score_source,
  input_tokens = S.input_tokens,
  output_tokens = S.output_tokens,
  assessed_at = S.assessed_at,
  signal_span_mismatch_count = S.signal_span_mismatch_count`;
}

export function buildInsertErrorSql(config: BqConfig): string {
  const errors = quotedTable(config, 'gemini_assessment_errors');
  return `INSERT INTO ${errors} (
  review_id, pipeline_run_id, attempt_count, http_status,
  error_class, error_message, retryable, failed_at
) VALUES (
  @review_id, @pipeline_run_id, @attempt_count, @http_status,
  @error_class, @error_message, @retryable, TIMESTAMP(@failed_at)
)`;
}

export function buildCopySkippedMismatchSql(config: BqConfig): string {
  const assessments = quotedTable(config, 'gemini_review_assessments');
  const stage2 = quotedTable(config, 'stage2_suspicious_for_gemini');
  const raw = quotedTable(config, 'raw_reviews');
  return `SELECT COUNT(*) AS n
FROM ${stage2} s
JOIN ${raw} raw ON raw.review_id = s.review_id
WHERE s.pipeline_run_id = @pipeline_run_id
  AND EXISTS (
    SELECT 1 FROM ${assessments} prev
    WHERE prev.review_id = s.review_id
      AND prev.content_hash = raw.content_hash
      AND prev.pipeline_run_id != @pipeline_run_id
      AND (prev.model_id != @gemini_model OR prev.prompt_version != @prompt_version)
  )
  AND NOT EXISTS (
    SELECT 1 FROM ${assessments} prev
    WHERE prev.review_id = s.review_id
      AND prev.content_hash = raw.content_hash
      AND prev.pipeline_run_id != @pipeline_run_id
      AND prev.model_id = @gemini_model
      AND prev.prompt_version = @prompt_version
  )`;
}

function asInt(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  throw new Error(`expected integer ${field}, got ${String(value)}`);
}

function asString(value: unknown, field: string): string {
  if (typeof value === 'string') {
    return value;
  }
  throw new Error(`expected string ${field}, got ${String(value)}`);
}

export async function assertAuditTablesExist(bq: BigQuery, config: BqConfig): Promise<void> {
  const names = AUDIT_TABLES.map((name) => `'${name}'`).join(', ');
  const rows = await runQuery(
    bq,
    config,
    `SELECT table_name FROM ${quotedInformationSchemaTables(config)}
WHERE table_name IN (${names})`,
  );
  const have = new Set(rows.map((row) => String(row['table_name'] ?? '')));
  const missing = AUDIT_TABLES.filter((name) => !have.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Audit BigQuery tables missing (${missing.join(', ')}); run scripts/bq-apply.sh`,
    );
  }
}

export function createBqCheckpoint(bq: BigQuery, config: BqConfig): AuditCheckpoint {
  return {
    async copyForward(input) {
      const before = await runQuery(
        bq,
        config,
        `SELECT COUNT(*) AS n FROM ${quotedTable(config, 'gemini_review_assessments')}
WHERE pipeline_run_id = @pipeline_run_id AND score_source = 'copied'`,
        { pipeline_run_id: input.pipelineRunId },
      );
      const nBefore = asInt(before[0]?.['n'] ?? 0, 'n_copied_before');
      await runQuery(bq, config, buildCopyForwardSql(config), {
        pipeline_run_id: input.pipelineRunId,
        gemini_model: input.geminiModel,
        prompt_version: input.promptVersion,
      });
      const after = await runQuery(
        bq,
        config,
        `SELECT COUNT(*) AS n FROM ${quotedTable(config, 'gemini_review_assessments')}
WHERE pipeline_run_id = @pipeline_run_id AND score_source = 'copied'`,
        { pipeline_run_id: input.pipelineRunId },
      );
      const nAfter = asInt(after[0]?.['n'] ?? 0, 'n_copied_after');
      return { n_copied: nAfter - nBefore };
    },
    async countCopySkippedModelMismatch(input) {
      const rows = await runQuery(bq, config, buildCopySkippedMismatchSql(config), {
        pipeline_run_id: input.pipelineRunId,
        gemini_model: input.geminiModel,
        prompt_version: input.promptVersion,
      });
      return asInt(rows[0]?.['n'] ?? 0, 'n_mismatch');
    },
    async selectPending(input) {
      const rows = await runQuery(bq, config, buildSelectPendingSql(config, input.forceRescore), {
        pipeline_run_id: input.pipelineRunId,
      });
      return rows.map((row) => ({
        review_id: asString(row['review_id'], 'review_id'),
        comment_text: asString(row['comment_text'], 'comment_text'),
        store_id: asString(row['store_id'], 'store_id'),
        product_id: asString(row['product_id'], 'product_id'),
        matched_seed_id: asString(row['matched_seed_id'], 'matched_seed_id'),
        matched_seed_category: asString(row['matched_seed_category'], 'matched_seed_category'),
        content_hash: asString(row['content_hash'], 'content_hash'),
      }));
    },
    async mergeAssessment(row) {
      const params: Record<string, unknown> = {
        review_id: row.review_id,
        pipeline_run_id: row.pipeline_run_id,
        store_id: row.store_id,
        product_id: row.product_id,
        content_hash: row.content_hash,
        shill_score: row.shill_score,
        template_detected: row.template_detected,
        linguistic_style: row.linguistic_style,
        detected_signals: JSON.stringify(row.detected_signals),
        model_id: row.model_id,
        prompt_version: row.prompt_version,
        score_source: row.score_source,
        assessed_at: row.assessed_at.toISOString(),
        signal_span_mismatch_count: row.signal_span_mismatch_count,
      };
      const sql = mergeSqlWithNullableParams(buildMergeAssessmentSql(config), params, {
        template_id: row.template_id,
        template_name: row.template_name,
        rationale_short: row.rationale_short,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
      });
      await runQuery(bq, config, sql, params);
    },
    async insertError(row) {
      const params: Record<string, unknown> = {
        review_id: row.review_id,
        pipeline_run_id: row.pipeline_run_id,
        attempt_count: row.attempt_count,
        error_class: row.error_class,
        retryable: row.retryable,
        failed_at: row.failed_at.toISOString(),
      };
      const sql = mergeSqlWithNullableParams(buildInsertErrorSql(config), params, {
        http_status: row.http_status,
        error_message: row.error_message,
      });
      await runQuery(bq, config, sql, params);
    },
  };
}

function mergeSqlWithNullableParams(
  sql: string,
  params: Record<string, unknown>,
  nullable: Record<string, string | number | null>,
): string {
  let out = sql;
  for (const [name, value] of Object.entries(nullable)) {
    if (value === null) {
      const sqlType = name === 'http_status' || name === 'input_tokens' || name === 'output_tokens' ? 'INT64' : 'STRING';
      out = out.replaceAll(`@${name}`, `CAST(NULL AS ${sqlType})`);
    } else {
      params[name] = value;
    }
  }
  return out;
}

export function createBqPipelineRuns(bq: BigQuery, config: BqConfig): PipelineRunPort {
  const table = quotedTable(config, 'pipeline_runs');
  return {
    async get(pipelineRunId) {
      const rows = await runQuery(
        bq,
        config,
        `SELECT pipeline_run_id, status, heartbeat_at, phase
FROM ${table}
WHERE pipeline_run_id = @pipeline_run_id
LIMIT 1`,
        { pipeline_run_id: pipelineRunId },
      );
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const heartbeatRaw = row['heartbeat_at'];
      return {
        pipeline_run_id: asString(row['pipeline_run_id'], 'pipeline_run_id'),
        status: asString(row['status'], 'status'),
        heartbeat_at: heartbeatRaw instanceof Date ? heartbeatRaw : heartbeatRaw === null || heartbeatRaw === undefined ? null : new Date(String(heartbeatRaw)),
        phase: asString(row['phase'], 'phase'),
      };
    },
    async update(patch) {
      const params: Record<string, unknown> = {
        pipeline_run_id: patch.pipelineRunId,
        status: patch.status,
        phase: 'audit',
        heartbeat_at: patch.heartbeatAt.toISOString(),
      };
      const finished =
        patch.finishedAt === undefined || patch.finishedAt === null
          ? 'CAST(NULL AS TIMESTAMP)'
          : (params['finished_at'] = patch.finishedAt.toISOString(), '@finished_at');
      const rowsIn =
        patch.rowsIn === undefined || patch.rowsIn === null
          ? 'CAST(NULL AS INT64)'
          : (params['rows_in'] = patch.rowsIn, '@rows_in');
      const rowsOut =
        patch.rowsOut === undefined || patch.rowsOut === null
          ? 'CAST(NULL AS INT64)'
          : (params['rows_out'] = patch.rowsOut, '@rows_out');
      const errorMessage =
        patch.errorMessage === undefined || patch.errorMessage === null
          ? 'CAST(NULL AS STRING)'
          : (params['error_message'] = patch.errorMessage, '@error_message');
      await runQuery(
        bq,
        config,
        `UPDATE ${table}
SET
  phase = @phase,
  status = @status,
  heartbeat_at = @heartbeat_at,
  finished_at = ${finished},
  rows_in = ${rowsIn},
  rows_out = ${rowsOut},
  error_message = ${errorMessage}
WHERE pipeline_run_id = @pipeline_run_id`,
        params,
      );
    },
  };
}
