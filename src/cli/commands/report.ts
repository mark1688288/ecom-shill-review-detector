// SPDX-License-Identifier: GPL-3.0-only
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BigQuery } from '@google-cloud/bigquery';
import {
  parseReportFormat,
  renderDot,
  renderJson,
  renderMarkdown,
  resolveReportOutputPaths,
  type BurstEventRow,
  type FunnelStatsRow,
  type NetworkEdgeRow,
  type ReportData,
  type ReportFormat,
  type StoreShillStatsRow,
} from '../../analysis/report.js';
import {
  assertBqConfig,
  bqConfigFromGcp,
  getBigQuery,
  quotedTable,
  runQuery,
  type BqConfig,
} from '../../shared/bq.js';
import { loadEnv, type GcpEnv } from '../../shared/env.js';
import {
  printPipelineRunId,
  resolvePipelineRunId,
  RunIdError,
} from '../../shared/run-id.js';

export type ReportCliOptions = {
  pipelineRunId?: string;
  continueLatest?: boolean;
  format?: string;
  dot?: boolean;
  out?: string;
};

export type RunReportOptions = ReportCliOptions & {
  cwd?: string;
  latestPath?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: { write(chunk: string): unknown };
  bigquery?: BigQuery;
};

export type ReportCommandResult = {
  exitCode: number;
  pipeline_run_id: string;
  fromLatest: boolean;
  format: ReportFormat;
  primaryPath: string;
  dotPath: string | undefined;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unwrap(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'value' in value) {
    return (value as { value: unknown }).value;
  }
  return value;
}

function asInt(value: unknown, field: string): number {
  const raw = unwrap(value);
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'bigint') {
    return Number(raw);
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  throw new Error(`report expected integer ${field}, got ${String(value)}`);
}

function asIntOrNull(value: unknown, field: string): number | null {
  const raw = unwrap(value);
  if (raw === null || raw === undefined) {
    return null;
  }
  return asInt(raw, field);
}

function asFloatOrNull(value: unknown, field: string): number | null {
  const raw = unwrap(value);
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  throw new Error(`report expected float ${field}, got ${String(value)}`);
}

function asString(value: unknown, field: string): string {
  const raw = unwrap(value);
  if (typeof raw === 'string') {
    return raw;
  }
  throw new Error(`report expected string ${field}, got ${String(value)}`);
}

function asStringOrNull(value: unknown, field: string): string | null {
  const raw = unwrap(value);
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === 'string') {
    return raw;
  }
  throw new Error(`report expected string ${field}, got ${String(value)}`);
}

function asBool(value: unknown, field: string): boolean {
  const raw = unwrap(value);
  if (typeof raw === 'boolean') {
    return raw;
  }
  throw new Error(`report expected boolean ${field}, got ${String(value)}`);
}

function asTimestamp(value: unknown, field: string): string {
  const raw = unwrap(value);
  if (raw instanceof Date) {
    return raw.toISOString();
  }
  if (typeof raw === 'string') {
    return raw;
  }
  if (typeof raw === 'object' && raw !== null && 'value' in raw) {
    return asTimestamp((raw as { value: unknown }).value, field);
  }
  throw new Error(`report expected timestamp ${field}, got ${String(value)}`);
}

function asStringArray(value: unknown, field: string): string[] {
  const raw = unwrap(value);
  if (raw === null || raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`report expected array ${field}, got ${String(value)}`);
  }
  return raw.map((item, index) => asString(item, `${field}[${String(index)}]`));
}

async function requireExistingPipelineRun(
  bq: BigQuery,
  config: BqConfig,
  pipelineRunId: string,
): Promise<void> {
  const rows = await runQuery(
    bq,
    config,
    `SELECT pipeline_run_id FROM ${quotedTable(config, 'pipeline_runs')}
WHERE pipeline_run_id = @pipeline_run_id LIMIT 1`,
    { pipeline_run_id: pipelineRunId },
  );
  if (rows.length === 0) {
    throw new RunIdError(
      `pipeline run not found: ${pipelineRunId}; load/layer1 must create it first`,
      2,
    );
  }
}

function parseFunnel(row: Record<string, unknown>, pipelineRunId: string): FunnelStatsRow {
  return {
    pipeline_run_id: pipelineRunId,
    n_raw: asInt(row['n_raw'], 'n_raw'),
    n_stage1: asInt(row['n_stage1'], 'n_stage1'),
    n_stage2: asInt(row['n_stage2'], 'n_stage2'),
    n_assessed: asInt(row['n_assessed'], 'n_assessed'),
    n_assess_errors: asInt(row['n_assess_errors'], 'n_assess_errors'),
    pct_stage1: asFloatOrNull(row['pct_stage1'], 'pct_stage1'),
    pct_stage2_of_raw: asFloatOrNull(row['pct_stage2_of_raw'], 'pct_stage2_of_raw'),
    pct_stage2_of_stage1: asFloatOrNull(row['pct_stage2_of_stage1'], 'pct_stage2_of_stage1'),
  };
}

function parseStore(row: Record<string, unknown>): StoreShillStatsRow {
  return {
    store_id: asString(row['store_id'], 'store_id'),
    marketplace: asString(row['marketplace'], 'marketplace'),
    n_raw: asInt(row['n_raw'], 'n_raw'),
    n_stage1: asInt(row['n_stage1'], 'n_stage1'),
    n_stage2: asInt(row['n_stage2'], 'n_stage2'),
    n_assessed: asInt(row['n_assessed'], 'n_assessed'),
    n_shill_75: asInt(row['n_shill_75'], 'n_shill_75'),
    pct_shill_75: asFloatOrNull(row['pct_shill_75'], 'pct_shill_75'),
    n_template_hit: asIntOrNull(row['n_template_hit'], 'n_template_hit'),
    template_hit_rate: asFloatOrNull(row['template_hit_rate'], 'template_hit_rate'),
    avg_min_seed_distance: asFloatOrNull(row['avg_min_seed_distance'], 'avg_min_seed_distance'),
    p50_shill_score: asFloatOrNull(row['p50_shill_score'], 'p50_shill_score'),
  };
}

function parseBurst(row: Record<string, unknown>): BurstEventRow {
  return {
    store_id: asString(row['store_id'], 'store_id'),
    product_id: asStringOrNull(row['product_id'], 'product_id'),
    bucket_ts: asTimestamp(row['bucket_ts'], 'bucket_ts'),
    granularity: asString(row['granularity'], 'granularity'),
    n_reviews: asInt(row['n_reviews'], 'n_reviews'),
    n_five_star: asInt(row['n_five_star'], 'n_five_star'),
    z_score: asFloatOrNull(row['z_score'], 'z_score'),
    is_burst: asBool(row['is_burst'], 'is_burst'),
  };
}

function parseEdge(row: Record<string, unknown>): NetworkEdgeRow {
  return {
    src_store_id: asString(row['src_store_id'], 'src_store_id'),
    dst_store_id: asString(row['dst_store_id'], 'dst_store_id'),
    weight: asInt(row['weight'], 'weight'),
    template_ids: asStringArray(row['template_ids'], 'template_ids'),
  };
}

export async function loadReportData(
  bq: BigQuery,
  config: BqConfig,
  pipelineRunId: string,
): Promise<ReportData> {
  const funnelRows = await runQuery(
    bq,
    config,
    `SELECT
  n_raw,
  n_stage1,
  n_stage2,
  n_assessed,
  n_assess_errors,
  pct_stage1,
  pct_stage2_of_raw,
  pct_stage2_of_stage1
FROM ${quotedTable(config, 'funnel_stats')}
WHERE pipeline_run_id = @pipeline_run_id
ORDER BY computed_at DESC
LIMIT 1`,
    { pipeline_run_id: pipelineRunId },
  );
  const funnelRow = funnelRows[0];
  if (funnelRow === undefined) {
    throw new Error(
      `no funnel_stats for pipeline_run_id=${pipelineRunId}; run analyze first`,
    );
  }

  const storeRows = await runQuery(
    bq,
    config,
    `SELECT
  store_id,
  marketplace,
  n_raw,
  n_stage1,
  n_stage2,
  n_assessed,
  n_shill_75,
  pct_shill_75,
  n_template_hit,
  template_hit_rate,
  avg_min_seed_distance,
  p50_shill_score
FROM ${quotedTable(config, 'store_shill_stats')}
WHERE pipeline_run_id = @pipeline_run_id
ORDER BY pct_shill_75 DESC, n_shill_75 DESC, store_id ASC`,
    { pipeline_run_id: pipelineRunId },
  );

  const burstRows = await runQuery(
    bq,
    config,
    `SELECT
  store_id,
  product_id,
  bucket_ts,
  granularity,
  n_reviews,
  n_five_star,
  z_score,
  is_burst
FROM ${quotedTable(config, 'burst_events')}
WHERE pipeline_run_id = @pipeline_run_id
  AND is_burst = TRUE
ORDER BY bucket_ts DESC, store_id ASC`,
    { pipeline_run_id: pipelineRunId },
  );

  const edgeRows = await runQuery(
    bq,
    config,
    `SELECT
  src_store_id,
  dst_store_id,
  weight,
  template_ids
FROM ${quotedTable(config, 'shill_network_edges')}
WHERE pipeline_run_id = @pipeline_run_id
ORDER BY weight DESC, src_store_id ASC, dst_store_id ASC`,
    { pipeline_run_id: pipelineRunId },
  );

  return {
    pipeline_run_id: pipelineRunId,
    funnel: parseFunnel(funnelRow, pipelineRunId),
    stores: storeRows.map(parseStore),
    bursts: burstRows.map(parseBurst),
    edges: edgeRows.map(parseEdge),
  };
}

export async function runReport(opts: RunReportOptions): Promise<ReportCommandResult> {
  const loaded = loadEnv({
    command: 'report',
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });
  const cwd = opts.cwd ?? process.cwd();
  const latestPath = opts.latestPath ?? path.join(cwd, 'data', 'runs', 'latest');
  const resolved = resolvePipelineRunId({
    allowCreate: false,
    latestPath,
    ...(opts.pipelineRunId === undefined ? {} : { pipelineRunId: opts.pipelineRunId }),
    ...(opts.continueLatest === undefined ? {} : { continueLatest: opts.continueLatest }),
  });
  if (loaded.gcp === undefined) {
    throw new Error('GCP_PROJECT, GCP_LOCATION, and BQ_DATASET are required for report');
  }
  const gcp: GcpEnv = loaded.gcp;
  const config = bqConfigFromGcp(gcp);
  assertBqConfig(config);
  const bq = opts.bigquery ?? getBigQuery(config);
  const stdout = opts.stdout ?? process.stdout;
  const format = parseReportFormat(opts.format);

  await requireExistingPipelineRun(bq, config, resolved.pipeline_run_id);
  const data = await loadReportData(bq, config, resolved.pipeline_run_id);

  const outOpts: {
    pipelineRunId: string;
    format: ReportFormat;
    dot: boolean;
    cwd: string;
    out?: string;
  } = {
    pipelineRunId: resolved.pipeline_run_id,
    format,
    dot: opts.dot === true,
    cwd,
  };
  if (opts.out !== undefined) {
    outOpts.out = opts.out;
  }
  const paths = resolveReportOutputPaths(outOpts);

  mkdirSync(path.dirname(paths.primary), { recursive: true });
  const body = format === 'json' ? renderJson(data) : renderMarkdown(data);
  writeFileSync(paths.primary, body, 'utf8');
  if (paths.dotPath !== undefined) {
    mkdirSync(path.dirname(paths.dotPath), { recursive: true });
    writeFileSync(paths.dotPath, renderDot(data), 'utf8');
  }

  printPipelineRunId(resolved.pipeline_run_id, stdout);
  stdout.write(`report=${paths.primary}\n`);
  if (paths.dotPath !== undefined) {
    stdout.write(`dot=${paths.dotPath}\n`);
  }

  return {
    exitCode: 0,
    pipeline_run_id: resolved.pipeline_run_id,
    fromLatest: resolved.fromLatest,
    format,
    primaryPath: paths.primary,
    dotPath: paths.dotPath,
  };
}

export async function reportAction(opts: ReportCliOptions): Promise<void> {
  try {
    const result = await runReport(opts);
    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode;
    }
  } catch (err) {
    const message = errorMessage(err);
    process.stderr.write(`${message}\n`);
    if (err instanceof RunIdError) {
      process.exitCode = err.exitCode;
      return;
    }
    process.exitCode = 1;
  }
}
