-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.funnel_stats` (
  pipeline_run_id STRING NOT NULL,
  n_raw INT64,
  n_stage1 INT64,
  n_stage2 INT64,
  n_assessed INT64,
  n_assess_errors INT64,
  pct_stage1 FLOAT64,
  pct_stage2_of_raw FLOAT64,
  pct_stage2_of_stage1 FLOAT64,
  computed_at TIMESTAMP NOT NULL
);
