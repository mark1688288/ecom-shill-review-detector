-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.pipeline_runs` (
  pipeline_run_id STRING NOT NULL,
  parent_run_id STRING,
  phase STRING NOT NULL,
  status STRING NOT NULL,
  crawl_batch_id STRING,
  seed_version STRING,
  embedding_model STRING,
  gemini_model STRING,
  heartbeat_at TIMESTAMP,
  cosine_distance_threshold FLOAT64,
  started_at TIMESTAMP NOT NULL,
  finished_at TIMESTAMP,
  rows_in INT64,
  rows_out INT64,
  error_message STRING,
  extra JSON
)
PARTITION BY DATE(started_at);
