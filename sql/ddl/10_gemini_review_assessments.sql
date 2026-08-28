-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.gemini_review_assessments` (
  review_id STRING NOT NULL,
  pipeline_run_id STRING NOT NULL,
  store_id STRING NOT NULL,
  product_id STRING NOT NULL,
  content_hash STRING NOT NULL,
  shill_score INT64 NOT NULL,
  template_detected BOOL NOT NULL,
  template_id STRING,
  template_name STRING,
  linguistic_style STRING NOT NULL,
  detected_signals JSON NOT NULL,
  rationale_short STRING,
  model_id STRING NOT NULL,
  prompt_version STRING NOT NULL,
  score_source STRING NOT NULL,         -- gemini | copied
  input_tokens INT64,
  output_tokens INT64,
  assessed_at TIMESTAMP NOT NULL,
  signal_span_mismatch_count INT64 NOT NULL,
  PRIMARY KEY (pipeline_run_id, review_id) NOT ENFORCED
)
PARTITION BY DATE(assessed_at)
CLUSTER BY pipeline_run_id, store_id;
