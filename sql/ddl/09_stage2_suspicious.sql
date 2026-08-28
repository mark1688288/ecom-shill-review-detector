-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.stage2_suspicious_for_gemini` (
  pipeline_run_id STRING NOT NULL,
  review_id STRING NOT NULL,
  store_id STRING NOT NULL,
  product_id STRING NOT NULL,
  comment_text STRING NOT NULL,
  review_ts TIMESTAMP NOT NULL,
  matched_seed_id STRING NOT NULL,
  matched_seed_category STRING NOT NULL,
  min_cosine_distance FLOAT64 NOT NULL,
  min_cosine_similarity FLOAT64 NOT NULL,  -- 1 - min_cosine_distance; debug
  threshold FLOAT64 NOT NULL,
  PRIMARY KEY (pipeline_run_id, review_id) NOT ENFORCED
)
PARTITION BY DATE(review_ts)
CLUSTER BY pipeline_run_id, store_id;

CREATE OR REPLACE VIEW `ecom_shill.v_stage2_latest` AS
SELECT * FROM `ecom_shill.stage2_suspicious_for_gemini`
WHERE pipeline_run_id = (SELECT pipeline_run_id FROM `ecom_shill.pipeline_runs`
  WHERE phase = 'layer2' AND status = 'succeeded'
  ORDER BY finished_at DESC LIMIT 1);
