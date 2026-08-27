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

export function getBigQuery(config: BqConfig): BigQuery {
  assertBqConfig(config);
  return new BigQuery({
    projectId: config.project,
    location: config.location,
  });
}

export async function runQuery(
  bq: BigQuery,
  config: BqConfig,
  query: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>[]> {
  const options: Query = {
    query,
    location: config.location,
  };
  if (params !== undefined && Object.keys(params).length > 0) {
    options.params = params;
  }
  const [rows] = await bq.query(options);
  return rows as Record<string, unknown>[];
}
