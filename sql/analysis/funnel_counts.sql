-- SPDX-License-Identifier: GPL-3.0-only
-- @pipeline_run_id STRING
-- Informational funnel for this run. Percentages are not CI SLAs.

DELETE FROM `ecom_shill.funnel_stats`
WHERE pipeline_run_id = @pipeline_run_id;

INSERT INTO `ecom_shill.funnel_stats` (
  pipeline_run_id,
  n_raw,
  n_stage1,
  n_stage2,
  n_assessed,
  n_assess_errors,
  pct_stage1,
  pct_stage2_of_raw,
  pct_stage2_of_stage1,
  computed_at
)
WITH counts AS (
  SELECT
    (SELECT COUNT(*) FROM `ecom_shill.raw_reviews`
      WHERE pipeline_run_id = @pipeline_run_id) AS n_raw,
    (SELECT COUNT(*) FROM `ecom_shill.stage1_filtered`
      WHERE pipeline_run_id = @pipeline_run_id) AS n_stage1,
    (SELECT COUNT(*) FROM `ecom_shill.stage2_suspicious_for_gemini`
      WHERE pipeline_run_id = @pipeline_run_id) AS n_stage2,
    (SELECT COUNT(*) FROM `ecom_shill.gemini_review_assessments`
      WHERE pipeline_run_id = @pipeline_run_id) AS n_assessed,
    (SELECT COUNT(*) FROM `ecom_shill.gemini_assessment_errors`
      WHERE pipeline_run_id = @pipeline_run_id) AS n_assess_errors
)
SELECT
  @pipeline_run_id AS pipeline_run_id,
  n_raw,
  n_stage1,
  n_stage2,
  n_assessed,
  n_assess_errors,
  SAFE_DIVIDE(n_stage1, n_raw) AS pct_stage1,
  SAFE_DIVIDE(n_stage2, n_raw) AS pct_stage2_of_raw,
  SAFE_DIVIDE(n_stage2, n_stage1) AS pct_stage2_of_stage1,
  CURRENT_TIMESTAMP() AS computed_at
FROM counts;
