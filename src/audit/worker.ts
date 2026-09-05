// SPDX-License-Identifier: GPL-3.0-only
import pLimit from 'p-limit';
import type { Logger } from 'pino';
import type { AuditCheckpoint, PendingReview } from './checkpoint.js';
import {
  geminiErrorRate,
  logPipelineCounters,
  summarizeGeminiCostUsd,
} from '../shared/metrics.js';
import { estimateGeminiCostUsd, type GeminiClient } from './gemini-client.js';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt.js';
import {
  GeminiCallError,
  MAX_GEMINI_ATTEMPTS,
  withRetry,
  type ClassifiedGeminiError,
} from './retry.js';
import { sanitizeGeminiPayload } from './schema.js';

export type AuditWorkerStatus = 'succeeded' | 'failed' | 'aborted';

export type RunAuditWorkerOptions = {
  pipelineRunId: string;
  checkpoint: AuditCheckpoint;
  gemini: GeminiClient;
  logger: Logger;
  concurrency: number;
  limit?: number;
  maxReviewsPerRun: number;
  skipExisting: boolean;
  forceRescore: boolean;
  allowedTemplateIds: ReadonlySet<string>;
  modelId: string;
  promptVersion: string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  abortSignal?: AbortSignal;
};

export type AuditWorkerResult = {
  status: AuditWorkerStatus;
  pipeline_run_id: string;
  n_copied: number;
  n_pending: number;
  n_attempted: number;
  n_gemini_http_calls: number;
  n_scored: number;
  n_errors: number;
  n_copy_skipped_model_mismatch: number;
  thinking_not_off: boolean;
  gemini_cost_usd_est: number | null;
  gemini_error_rate: number;
  signal_span_mismatch_total: number;
  abort_reason?: string;
};

function assessmentFromSanitize(
  pipelineRunId: string,
  row: PendingReview,
  modelId: string,
  promptVersion: string,
  now: Date,
  sanitized: Extract<ReturnType<typeof sanitizeGeminiPayload>, { ok: true }>,
  tokens: { input?: number; output?: number },
): Parameters<AuditCheckpoint['mergeAssessment']>[0] {
  return {
    review_id: row.review_id,
    pipeline_run_id: pipelineRunId,
    store_id: row.store_id,
    product_id: row.product_id,
    content_hash: row.content_hash,
    shill_score: sanitized.assessment.shill_score,
    template_detected: sanitized.assessment.template_detected,
    template_id: sanitized.assessment.template_id,
    template_name: sanitized.assessment.template_name,
    linguistic_style: sanitized.assessment.linguistic_style,
    detected_signals: sanitized.assessment.detected_signals,
    rationale_short: sanitized.assessment.rationale_short,
    model_id: modelId,
    prompt_version: promptVersion,
    score_source: 'gemini',
    input_tokens: tokens.input ?? null,
    output_tokens: tokens.output ?? null,
    assessed_at: now,
    signal_span_mismatch_count: sanitized.signal_span_mismatch_count,
  };
}

export async function runAuditWorker(opts: RunAuditWorkerOptions): Promise<AuditWorkerResult> {
  const now = opts.now ?? (() => new Date());
  const copyInput = {
    pipelineRunId: opts.pipelineRunId,
    geminiModel: opts.modelId,
    promptVersion: opts.promptVersion,
  };

  let n_copied = 0;
  let n_copy_skipped_model_mismatch = 0;
  if (!opts.forceRescore && opts.skipExisting) {
    const copied = await opts.checkpoint.copyForward(copyInput);
    n_copied = copied.n_copied;
    n_copy_skipped_model_mismatch =
      await opts.checkpoint.countCopySkippedModelMismatch(copyInput);
    if (n_copy_skipped_model_mismatch > 0) {
      opts.logger.info({
        event: 'copy_skipped_model_mismatch',
        n: n_copy_skipped_model_mismatch,
        pipeline_run_id: opts.pipelineRunId,
      });
    }
  }

  const pending = await opts.checkpoint.selectPending({
    ...copyInput,
    forceRescore: opts.forceRescore,
  });
  const wouldCall = opts.limit === undefined ? pending.length : Math.min(opts.limit, pending.length);
  if (wouldCall > opts.maxReviewsPerRun) {
    const aborted: AuditWorkerResult = {
      status: 'aborted',
      pipeline_run_id: opts.pipelineRunId,
      n_copied,
      n_pending: pending.length,
      n_attempted: 0,
      n_gemini_http_calls: 0,
      n_scored: 0,
      n_errors: 0,
      n_copy_skipped_model_mismatch,
      thinking_not_off: false,
      gemini_cost_usd_est: null,
      gemini_error_rate: 0,
      signal_span_mismatch_total: 0,
      abort_reason: 'max_reviews_per_run',
    };
    logPipelineCounters(opts.logger, opts.pipelineRunId, {
      gemini_cost_usd_est: aborted.gemini_cost_usd_est,
      gemini_error_rate: aborted.gemini_error_rate,
      signal_span_mismatch_total: aborted.signal_span_mismatch_total,
    });
    return aborted;
  }

  const batch = pending.slice(0, opts.limit ?? pending.length);
  const limiter = pLimit(opts.concurrency);
  let n_gemini_http_calls = 0;
  let n_scored = 0;
  let n_errors = 0;
  let thinking_not_off = false;
  let signal_span_mismatch_total = 0;
  const costEstimates: Array<number | null> = [];

  await Promise.all(
    batch.map((row) =>
      limiter(async () => {
        if (opts.abortSignal?.aborted === true) {
          return;
        }
        try {
          const generated = await withRetry(
            async () => {
              n_gemini_http_calls += 1;
              return opts.gemini.generate({
                systemPrompt: SYSTEM_PROMPT,
                userPrompt: buildUserPrompt({
                  commentText: row.comment_text,
                  matchedSeedId: row.matched_seed_id,
                  matchedSeedCategory: row.matched_seed_category,
                }),
              });
            },
            {
              ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
              ...(opts.random === undefined ? {} : { random: opts.random }),
            },
          );

          if (generated.thoughtsTokenCount === 0) {
            const usd = estimateGeminiCostUsd(
              opts.modelId,
              generated.promptTokenCount ?? 0,
              generated.candidatesTokenCount ?? 0,
            );
            costEstimates.push(usd);
            if (usd !== null) {
              opts.logger.info({
                event: 'gemini_token_cost_usd_est',
                usd,
                pipeline_run_id: opts.pipelineRunId,
                review_id: row.review_id,
              });
            }
          } else if (typeof generated.thoughtsTokenCount === 'number') {
            thinking_not_off = true;
            costEstimates.push(null);
            opts.logger.warn({
              event: 'thinking_not_off',
              thoughtsTokenCount: generated.thoughtsTokenCount,
              pipeline_run_id: opts.pipelineRunId,
              review_id: row.review_id,
            });
          } else {
            costEstimates.push(
              estimateGeminiCostUsd(
                opts.modelId,
                generated.promptTokenCount ?? 0,
                generated.candidatesTokenCount ?? 0,
              ),
            );
          }

          const sanitized = sanitizeGeminiPayload(
            generated.text,
            row.comment_text,
            opts.allowedTemplateIds,
          );
          if (!sanitized.ok) {
            n_errors += 1;
            await opts.checkpoint.insertError({
              review_id: row.review_id,
              pipeline_run_id: opts.pipelineRunId,
              attempt_count: 1,
              http_status: null,
              error_class: 'schema',
              error_message: sanitized.error_message,
              retryable: false,
              failed_at: now(),
            });
            return;
          }
          const tokens: { input?: number; output?: number } = {};
          if (generated.promptTokenCount !== undefined) {
            tokens.input = generated.promptTokenCount;
          }
          if (generated.candidatesTokenCount !== undefined) {
            tokens.output = generated.candidatesTokenCount;
          }
          await opts.checkpoint.mergeAssessment(
            assessmentFromSanitize(
              opts.pipelineRunId,
              row,
              opts.modelId,
              opts.promptVersion,
              now(),
              sanitized,
              tokens,
            ),
          );
          signal_span_mismatch_total += sanitized.signal_span_mismatch_count;
          n_scored += 1;
        } catch (err) {
          n_errors += 1;
          const classified: ClassifiedGeminiError =
            err instanceof GeminiCallError
              ? err.classified
              : {
                  retryable: false,
                  errorClass: 'unknown',
                  message: err instanceof Error ? err.message : String(err),
                };
          await opts.checkpoint.insertError({
            review_id: row.review_id,
            pipeline_run_id: opts.pipelineRunId,
            attempt_count: MAX_GEMINI_ATTEMPTS,
            http_status: classified.httpStatus ?? null,
            error_class: classified.errorClass,
            error_message: classified.message,
            retryable: classified.retryable,
            failed_at: now(),
          });
        }
      }),
    ),
  );

  const aborted = opts.abortSignal?.aborted === true;
  const gemini_cost_usd_est = summarizeGeminiCostUsd({
    thinkingNotOff: thinking_not_off,
    estimates: costEstimates,
  });
  const gemini_error_rate = geminiErrorRate(n_errors, batch.length);
  logPipelineCounters(opts.logger, opts.pipelineRunId, {
    gemini_cost_usd_est,
    gemini_error_rate,
    signal_span_mismatch_total,
  });
  return {
    status: aborted ? 'aborted' : 'succeeded',
    pipeline_run_id: opts.pipelineRunId,
    n_copied,
    n_pending: pending.length,
    n_attempted: batch.length,
    n_gemini_http_calls,
    n_scored,
    n_errors,
    n_copy_skipped_model_mismatch,
    thinking_not_off,
    gemini_cost_usd_est,
    gemini_error_rate,
    signal_span_mismatch_total,
    ...(aborted ? { abort_reason: 'signal' } : {}),
  };
}
