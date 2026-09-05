// SPDX-License-Identifier: GPL-3.0-only
import { BigQuery, type Query } from '@google-cloud/bigquery';
import type { GcpEnv } from './env.js';

export type BqConfig = {
  project: string;
  location: string;
  dataset: string;
};

const DATASET_ID = /^[A-Za-z0-9_]+$/;
const PROJECT_ID = /^[a-z0-9-]+$/;

export function bqConfigFromGcp(gcp: GcpEnv, datasetOverride?: string): BqConfig {
  const dataset = datasetOverride ?? gcp.BQ_DATASET;
  return {
    project: gcp.GCP_PROJECT,
    location: gcp.GCP_LOCATION,
    dataset,
  };
}

export function assertBqConfig(config: BqConfig): void {
  if (!PROJECT_ID.test(config.project)) {
    throw new Error(`invalid GCP_PROJECT: ${config.project}`);
  }
  if (!DATASET_ID.test(config.dataset)) {
    throw new Error(`invalid BigQuery dataset id: ${config.dataset}`);
  }
  if (config.location.length === 0) {
    throw new Error('GCP_LOCATION is required');
  }
}

export function fullyQualifiedTable(config: BqConfig, table: string): string {
  return `${config.project}.${config.dataset}.${table}`;
}

export function quotedTable(config: BqConfig, table: string): string {
  return `\`${fullyQualifiedTable(config, table)}\``;
}

export function quotedJobsByProject(config: BqConfig): string {
  return `\`${config.project}.region-${config.location}.INFORMATION_SCHEMA.JOBS_BY_PROJECT\``;
}

export function quotedInformationSchemaTables(config: BqConfig): string {
  return `\`${config.project}.${config.dataset}.INFORMATION_SCHEMA.TABLES\``;
}

export function quotedInformationSchemaModels(config: BqConfig): string {
  return `\`${config.project}.${config.dataset}.INFORMATION_SCHEMA.MODELS\``;
}

export function getBigQuery(config: BqConfig): BigQuery {
  assertBqConfig(config);
  return new BigQuery({
    projectId: config.project,
    location: config.location,
  });
}

export type BqSqlType = 'STRING' | 'INT64' | 'TIMESTAMP' | 'BOOL' | 'FLOAT64';

/**
 * The BigQuery client cannot encode JS `null` without `types`.
 * Omit the param and splice a typed SQL NULL instead.
 */
export function sqlParamOrNull(
  params: Record<string, unknown>,
  name: string,
  value: unknown,
  sqlType: BqSqlType,
): string {
  if (value === undefined || value === null) {
    return `CAST(NULL AS ${sqlType})`;
  }
  params[name] = value;
  return `@${name}`;
}

export type QueryWithJobResult = {
  rows: Record<string, unknown>[];
  jobId?: string;
};

export function extractJobId(job: unknown): string | undefined {
  if (typeof job !== 'object' || job === null) {
    return undefined;
  }
  const rec = job as {
    id?: unknown;
    metadata?: { jobReference?: { jobId?: unknown } };
    jobReference?: { jobId?: unknown };
  };
  if (typeof rec.id === 'string' && rec.id.length > 0) {
    return rec.id;
  }
  const ref = rec.jobReference ?? rec.metadata?.jobReference;
  if (typeof ref?.jobId === 'string' && ref.jobId.length > 0) {
    return ref.jobId;
  }
  return undefined;
}

export async function runQueryWithJob(
  bq: BigQuery,
  config: BqConfig,
  query: string,
  params?: Record<string, unknown>,
): Promise<QueryWithJobResult> {
  const options: Query = {
    query,
    location: config.location,
  };
  if (params !== undefined && Object.keys(params).length > 0) {
    options.params = params;
  }
  const [rows, job] = await bq.query(options);
  const jobId = extractJobId(job);
  if (jobId === undefined) {
    return { rows: rows as Record<string, unknown>[] };
  }
  return { rows: rows as Record<string, unknown>[], jobId };
}

export async function runQuery(
  bq: BigQuery,
  config: BqConfig,
  query: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const result = await runQueryWithJob(bq, config, query, params);
  return result.rows;
}
