// SPDX-License-Identifier: GPL-3.0-only
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PIPELINE_PHASES, type PipelinePhase } from './types.js';

export const LATEST_RUN_RELATIVE_PATH = path.join('data', 'runs', 'latest');

const latestRunSchema = z.object({
  pipeline_run_id: z.string().uuid(),
  crawl_batch_id: z.string().uuid().optional(),
  phase: z.enum(PIPELINE_PHASES),
  started_at: z.string().min(1),
});

export type LatestRunFile = z.infer<typeof latestRunSchema>;

export class RunIdError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = 'RunIdError';
    this.exitCode = exitCode;
  }
}

export function defaultLatestPath(cwd = process.cwd()): string {
  return path.join(cwd, LATEST_RUN_RELATIVE_PATH);
}

export function newUuid(): string {
  return randomUUID();
}

export function printPipelineRunId(
  pipelineRunId: string,
  out: { write(chunk: string): unknown } = process.stdout,
): void {
  out.write(`pipeline_run_id=${pipelineRunId}\n`);
}

export function writeLatestRun(run: LatestRunFile, latestPath = defaultLatestPath()): void {
  const parsed = latestRunSchema.parse(run);
  mkdirSync(path.dirname(latestPath), { recursive: true });
  writeFileSync(latestPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}

export function readLatestRun(latestPath = defaultLatestPath()): LatestRunFile | null {
  if (!existsSync(latestPath)) {
    return null;
  }
  const raw: unknown = JSON.parse(readFileSync(latestPath, 'utf8'));
  return latestRunSchema.parse(raw);
}

export type ResolveRunIdOptions = {
  pipelineRunId?: string;
  continueLatest?: boolean;
  /**
   * load / layer1: true (implicit continue-latest if the file exists, else create).
   * layer2 / audit / analyze / report: false (must pass a flag; never create an empty run).
   */
  allowCreate: boolean;
  latestPath?: string;
};

export type ResolvedRunId = {
  pipeline_run_id: string;
  created: boolean;
  fromLatest: boolean;
};

export function resolvePipelineRunId(opts: ResolveRunIdOptions): ResolvedRunId {
  const latestPath = opts.latestPath ?? defaultLatestPath();

  if (opts.pipelineRunId !== undefined && opts.continueLatest === true) {
    throw new RunIdError('--pipeline-run-id and --continue-latest are mutually exclusive');
  }

  if (opts.pipelineRunId !== undefined && opts.pipelineRunId.length > 0) {
    return { pipeline_run_id: opts.pipelineRunId, created: false, fromLatest: false };
  }

  if (opts.continueLatest === true) {
    const latest = readLatestRun(latestPath);
    if (latest === null) {
      throw new RunIdError(
        `${LATEST_RUN_RELATIVE_PATH} not found; pass --pipeline-run-id`,
        2,
      );
    }
    return { pipeline_run_id: latest.pipeline_run_id, created: false, fromLatest: true };
  }

  if (opts.allowCreate) {
    const latest = readLatestRun(latestPath);
    if (latest !== null) {
      return { pipeline_run_id: latest.pipeline_run_id, created: false, fromLatest: true };
    }
    return { pipeline_run_id: newUuid(), created: true, fromLatest: false };
  }

  throw new RunIdError(
    'pipeline run id required: pass --pipeline-run-id or --continue-latest',
    2,
  );
}

export function newCrawlBatch(phase: PipelinePhase = 'crawl'): LatestRunFile {
  return {
    pipeline_run_id: newUuid(),
    crawl_batch_id: newUuid(),
    phase,
    started_at: new Date().toISOString(),
  };
}
