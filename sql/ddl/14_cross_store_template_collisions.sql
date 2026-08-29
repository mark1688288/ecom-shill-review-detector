-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.cross_store_template_collisions` (
  pipeline_run_id STRING NOT NULL,
  store_id_a STRING NOT NULL,
  store_id_b STRING NOT NULL,
  review_id_a STRING NOT NULL,
  review_id_b STRING NOT NULL,
  template_id STRING,
  cosine_distance FLOAT64,
  shill_score_a INT64,
  shill_score_b INT64,
  pair_type STRING NOT NULL,
  computed_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(computed_at)
CLUSTER BY store_id_a, store_id_b;
