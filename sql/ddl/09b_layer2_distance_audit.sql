-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.layer2_distance_audit` (
  pipeline_run_id STRING NOT NULL,
  review_id STRING NOT NULL,
  store_id STRING NOT NULL,
  product_id STRING NOT NULL,
  matched_seed_id STRING NOT NULL,
  matched_seed_category STRING NOT NULL,
  min_cosine_distance FLOAT64 NOT NULL,
  min_cosine_similarity FLOAT64 NOT NULL,  -- 1 - min_cosine_distance
  threshold FLOAT64 NOT NULL,              -- Layer 2 that-run T (stage2 cut)
  review_ts TIMESTAMP NOT NULL,
  PRIMARY KEY (pipeline_run_id, review_id) NOT ENFORCED
)
PARTITION BY DATE(review_ts)
CLUSTER BY pipeline_run_id, store_id;
