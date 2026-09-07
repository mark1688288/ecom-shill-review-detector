-- SPDX-License-Identifier: GPL-3.0-only
-- @pipeline_run_id STRING
-- @shill_score_threshold INT64
-- Per-run DELETE+INSERT. Assessments are never "latest globally".
-- n_shill_75 / pct_shill_75 use shill_score >= @shill_score_threshold (default 75).
-- avg_min_seed_distance is the store's stage2 mean (lower → closer to seeds).

DELETE FROM `ecom_shill.store_shill_stats`
WHERE pipeline_run_id = @pipeline_run_id;

INSERT INTO `ecom_shill.store_shill_stats` (
  pipeline_run_id,
  store_id,
  marketplace,
  n_raw,
  n_stage1,
  n_stage2,
  n_assessed,
  n_shill_75,
  pct_shill_75,
  n_template_hit,
  template_hit_rate,
  avg_min_seed_distance,
  p50_shill_score,
  computed_at
)
WITH raw AS (
  SELECT
    store_id,
    ANY_VALUE(marketplace) AS marketplace,
    COUNT(*) AS n_raw
  FROM `ecom_shill.raw_reviews`
  WHERE pipeline_run_id = @pipeline_run_id
  GROUP BY store_id
),
stage1 AS (
  SELECT store_id, COUNT(*) AS n_stage1
  FROM `ecom_shill.stage1_filtered`
  WHERE pipeline_run_id = @pipeline_run_id
    AND review_id IN (
      SELECT review_id FROM `ecom_shill.raw_reviews`
      WHERE pipeline_run_id = @pipeline_run_id
    )
  GROUP BY store_id
),
stage2 AS (
  SELECT
    store_id,
    COUNT(*) AS n_stage2,
    AVG(min_cosine_distance) AS avg_min_seed_distance
  FROM `ecom_shill.stage2_suspicious_for_gemini`
  WHERE pipeline_run_id = @pipeline_run_id
    AND review_id IN (
      SELECT review_id FROM `ecom_shill.raw_reviews`
      WHERE pipeline_run_id = @pipeline_run_id
    )
  GROUP BY store_id
),
assessed AS (
  SELECT
    store_id,
    COUNT(*) AS n_assessed,
    COUNTIF(shill_score >= @shill_score_threshold) AS n_shill_75,
    COUNTIF(template_detected) AS n_template_hit,
    APPROX_QUANTILES(shill_score, 100)[OFFSET(50)] AS p50_shill_score
  FROM `ecom_shill.gemini_review_assessments`
  WHERE pipeline_run_id = @pipeline_run_id
    AND review_id IN (
      SELECT review_id FROM `ecom_shill.raw_reviews`
      WHERE pipeline_run_id = @pipeline_run_id
    )
  GROUP BY store_id
)
SELECT
  @pipeline_run_id AS pipeline_run_id,
  raw.store_id,
  raw.marketplace,
  raw.n_raw,
  IFNULL(stage1.n_stage1, 0) AS n_stage1,
  IFNULL(stage2.n_stage2, 0) AS n_stage2,
  IFNULL(assessed.n_assessed, 0) AS n_assessed,
  IFNULL(assessed.n_shill_75, 0) AS n_shill_75,
  SAFE_DIVIDE(assessed.n_shill_75, assessed.n_assessed) AS pct_shill_75,
  assessed.n_template_hit,
  SAFE_DIVIDE(assessed.n_template_hit, assessed.n_assessed) AS template_hit_rate,
  stage2.avg_min_seed_distance,
  assessed.p50_shill_score,
  CURRENT_TIMESTAMP() AS computed_at
FROM raw
LEFT JOIN stage1 ON stage1.store_id = raw.store_id
LEFT JOIN stage2 ON stage2.store_id = raw.store_id
LEFT JOIN assessed ON assessed.store_id = raw.store_id;
