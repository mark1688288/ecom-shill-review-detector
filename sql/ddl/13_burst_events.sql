-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.burst_events` (
  pipeline_run_id STRING NOT NULL,
  store_id STRING NOT NULL,
  product_id STRING,
  bucket_ts TIMESTAMP NOT NULL,
  granularity STRING NOT NULL,
  n_reviews INT64 NOT NULL,
  n_five_star INT64 NOT NULL,
  baseline_mean FLOAT64,
  baseline_stddev FLOAT64,
  z_score FLOAT64,
  is_burst BOOL NOT NULL
)
PARTITION BY DATE(bucket_ts)
CLUSTER BY pipeline_run_id, store_id;
