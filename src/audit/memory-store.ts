// SPDX-License-Identifier: GPL-3.0-only
import type {
  AssessmentRecord,
  AuditCheckpoint,
  CopyForwardInput,
  ErrorRecord,
  PendingReview,
  PipelineRunPort,
  PipelineRunRow,
} from './checkpoint.js';

export type MemoryStage2Row = PendingReview & { pipeline_run_id: string };

export type MemoryAuditDb = {
  pipelineRuns: Map<string, PipelineRunRow>;
  stage2: MemoryStage2Row[];
  raw: { review_id: string; content_hash: string }[];
  assessments: AssessmentRecord[];
  errors: ErrorRecord[];
};

export function createMemoryAuditDb(): MemoryAuditDb {
  return {
    pipelineRuns: new Map(),
    stage2: [],
    raw: [],
    assessments: [],
    errors: [],
  };
}

function latestCopyCandidate(
  db: MemoryAuditDb,
  input: CopyForwardInput,
  reviewId: string,
  contentHash: string,
): AssessmentRecord | undefined {
  const matches = db.assessments.filter(
    (row) =>
      row.review_id === reviewId &&
      row.content_hash === contentHash &&
      row.model_id === input.geminiModel &&
      row.prompt_version === input.promptVersion &&
      row.pipeline_run_id !== input.pipelineRunId,
  );
  matches.sort((a, b) => b.assessed_at.getTime() - a.assessed_at.getTime());
  return matches[0];
}

export function createMemoryCheckpoint(db: MemoryAuditDb): AuditCheckpoint {
  return {
    async copyForward(input) {
      const now = new Date();
      let n_copied = 0;
      for (const stage of db.stage2.filter((row) => row.pipeline_run_id === input.pipelineRunId)) {
        const already = db.assessments.some(
          (row) =>
            row.pipeline_run_id === input.pipelineRunId && row.review_id === stage.review_id,
        );
        if (already) {
          continue;
        }
        const raw = db.raw.find((row) => row.review_id === stage.review_id);
        if (raw === undefined) {
          continue;
        }
        const prev = latestCopyCandidate(db, input, stage.review_id, raw.content_hash);
        if (prev === undefined) {
          continue;
        }
        db.assessments.push({
          ...prev,
          pipeline_run_id: input.pipelineRunId,
          store_id: stage.store_id,
          product_id: stage.product_id,
          content_hash: raw.content_hash,
          score_source: 'copied',
          assessed_at: now,
        });
        n_copied += 1;
      }
      return { n_copied };
    },
    async countCopySkippedModelMismatch(input) {
      let n = 0;
      for (const stage of db.stage2.filter((row) => row.pipeline_run_id === input.pipelineRunId)) {
        const raw = db.raw.find((row) => row.review_id === stage.review_id);
        if (raw === undefined) {
          continue;
        }
        const hasMatch = latestCopyCandidate(db, input, stage.review_id, raw.content_hash);
        if (hasMatch !== undefined) {
          continue;
        }
        const mismatched = db.assessments.some(
          (row) =>
            row.review_id === stage.review_id &&
            row.content_hash === raw.content_hash &&
            row.pipeline_run_id !== input.pipelineRunId &&
            (row.model_id !== input.geminiModel || row.prompt_version !== input.promptVersion),
        );
        if (mismatched) {
          n += 1;
        }
      }
      return n;
    },
    async selectPending(input) {
      const blocked = new Set(
        db.errors
          .filter((row) => row.pipeline_run_id === input.pipelineRunId && !row.retryable)
          .map((row) => row.review_id),
      );
      const scored = new Set(
        db.assessments
          .filter((row) => row.pipeline_run_id === input.pipelineRunId)
          .map((row) => row.review_id),
      );
      const pending: PendingReview[] = [];
      for (const stage of db.stage2.filter((row) => row.pipeline_run_id === input.pipelineRunId)) {
        if (!input.forceRescore && blocked.has(stage.review_id)) {
          continue;
        }
        if (!input.forceRescore && scored.has(stage.review_id)) {
          continue;
        }
        const raw = db.raw.find((row) => row.review_id === stage.review_id);
        if (raw === undefined) {
          continue;
        }
        pending.push({
          review_id: stage.review_id,
          comment_text: stage.comment_text,
          store_id: stage.store_id,
          product_id: stage.product_id,
          matched_seed_id: stage.matched_seed_id,
          matched_seed_category: stage.matched_seed_category,
          content_hash: raw.content_hash,
        });
      }
      return pending;
    },
    async mergeAssessment(row) {
      const idx = db.assessments.findIndex(
        (existing) =>
          existing.pipeline_run_id === row.pipeline_run_id && existing.review_id === row.review_id,
      );
      if (idx === -1) {
        db.assessments.push({ ...row });
      } else {
        db.assessments[idx] = { ...row };
      }
      db.errors = db.errors.filter(
        (err) =>
          !(err.pipeline_run_id === row.pipeline_run_id && err.review_id === row.review_id),
      );
    },
    async insertError(row) {
      db.errors.push({ ...row });
    },
  };
}

export function createMemoryPipelineRuns(db: MemoryAuditDb): PipelineRunPort {
  return {
    async get(pipelineRunId) {
      return db.pipelineRuns.get(pipelineRunId) ?? null;
    },
    async update(patch) {
      const existing = db.pipelineRuns.get(patch.pipelineRunId);
      if (existing === undefined) {
        throw new Error(`pipeline run not found: ${patch.pipelineRunId}`);
      }
      db.pipelineRuns.set(patch.pipelineRunId, {
        ...existing,
        status: patch.status,
        phase: 'audit',
        heartbeat_at: patch.heartbeatAt,
      });
    },
  };
}
