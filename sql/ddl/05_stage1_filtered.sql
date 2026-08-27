-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.stage1_filtered` (
  pipeline_run_id STRING NOT NULL,
  review_id STRING NOT NULL,
  marketplace STRING NOT NULL,
  store_id STRING NOT NULL,
  product_id STRING NOT NULL,
  reviewer_id_hash STRING NOT NULL,
  star_rating INT64 NOT NULL,
  comment_text STRING NOT NULL,
  content_hash STRING NOT NULL,
  review_ts TIMESTAMP NOT NULL,
  language_hint STRING NOT NULL,
  char_length INT64 NOT NULL,
  stripped_char_length INT64 NOT NULL,
  filter_reason STRING NOT NULL
)
PARTITION BY DATE(review_ts)
CLUSTER BY pipeline_run_id, store_id;

CREATE OR REPLACE VIEW `ecom_shill.v_stage1_latest` AS
SELECT * FROM `ecom_shill.stage1_filtered`
WHERE pipeline_run_id = (SELECT pipeline_run_id FROM `ecom_shill.pipeline_runs`
  WHERE phase = 'layer1' AND status = 'succeeded'
  ORDER BY finished_at DESC LIMIT 1);
