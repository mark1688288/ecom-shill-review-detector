-- SPDX-License-Identifier: GPL-3.0-only
-- Phase 5 calibration tables. 0.28 / shill_score>=75 stay hypotheses until
-- a labeled sweep is inspected; this DDL does not change config defaults.

CREATE TABLE IF NOT EXISTS `ecom_shill.human_labels` (
  pipeline_run_id STRING NOT NULL,
  review_id STRING NOT NULL,
  label STRING NOT NULL,                -- shill | not_shill | unsure
  stratum STRING,                       -- near_seed | far_seed | genuine_long | logistics_edge
  notes STRING,
  labeled_at TIMESTAMP NOT NULL,
  PRIMARY KEY (pipeline_run_id, review_id) NOT ENFORCED
)
CLUSTER BY pipeline_run_id, label;

CREATE TABLE IF NOT EXISTS `ecom_shill.calibration_sweep` (
  pipeline_run_id STRING NOT NULL,
  metric_kind STRING NOT NULL,          -- layer2_distance | layer3_score
  cosine_distance_threshold FLOAT64 NOT NULL,
  shill_score_threshold INT64,
  n_labeled INT64 NOT NULL,
  n_shill INT64 NOT NULL,
  n_not_shill INT64 NOT NULL,
  n_unsure INT64 NOT NULL,
  n_predicted_positive INT64 NOT NULL,
  n_true_positive INT64 NOT NULL,
  n_false_positive INT64 NOT NULL,
  n_false_negative INT64 NOT NULL,
  precision FLOAT64,
  recall FLOAT64,
  n_predicted_stage2 INT64 NOT NULL,
  estimated_gemini_usd FLOAT64,
  computed_at TIMESTAMP NOT NULL
)
CLUSTER BY pipeline_run_id, metric_kind;
