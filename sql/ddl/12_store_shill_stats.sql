-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.store_shill_stats` (
  pipeline_run_id STRING NOT NULL,
  store_id STRING NOT NULL,
  marketplace STRING NOT NULL,
  n_raw INT64 NOT NULL,
  n_stage1 INT64 NOT NULL,
  n_stage2 INT64 NOT NULL,
  n_assessed INT64 NOT NULL,
  n_shill_75 INT64 NOT NULL,
  pct_shill_75 FLOAT64,
  n_template_hit INT64,
  template_hit_rate FLOAT64,
  avg_min_seed_distance FLOAT64,
  p50_shill_score FLOAT64,
  computed_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(computed_at)
CLUSTER BY pipeline_run_id, store_id;
