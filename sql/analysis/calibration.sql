-- SPDX-License-Identifier: GPL-3.0-only
-- @pipeline_run_id STRING
-- @shill_score_threshold INT64
-- @current_l2_threshold FLOAT64
-- @usd_per_review FLOAT64
-- Labeled sweep for Layer 2 cosine-distance cut points. Precision/recall
-- exclude unsure. n_predicted_stage2 / estimated_gemini_usd use this run's
-- full layer2_distance_audit (not only the labeled subset). Layer 3 metrics
-- are at the run's existing stage2 cut (@current_l2_threshold), not re-swept.
-- 0.28 remains a hypothesis; this script does not write config.

DELETE FROM `ecom_shill.calibration_sweep`
WHERE pipeline_run_id = @pipeline_run_id;

CREATE TEMP TABLE _labeled AS
SELECT
  h.review_id,
  h.label,
  a.min_cosine_distance,
  g.shill_score
FROM `ecom_shill.human_labels` AS h
LEFT JOIN `ecom_shill.layer2_distance_audit` AS a
  ON a.pipeline_run_id = h.pipeline_run_id
 AND a.review_id = h.review_id
LEFT JOIN `ecom_shill.gemini_review_assessments` AS g
  ON g.pipeline_run_id = h.pipeline_run_id
 AND g.review_id = h.review_id
WHERE h.pipeline_run_id = @pipeline_run_id;

INSERT INTO `ecom_shill.calibration_sweep` (
  pipeline_run_id,
  metric_kind,
  cosine_distance_threshold,
  shill_score_threshold,
  n_labeled,
  n_shill,
  n_not_shill,
  n_unsure,
  n_predicted_positive,
  n_true_positive,
  n_false_positive,
  n_false_negative,
  precision,
  recall,
  n_predicted_stage2,
  estimated_gemini_usd,
  computed_at
)
WITH thresholds AS (
  SELECT threshold
  FROM UNNEST([0.18, 0.22, 0.25, 0.28, 0.32, 0.38]) AS threshold
),
l2 AS (
  SELECT
    t.threshold AS cosine_distance_threshold,
    COUNT(*) AS n_labeled,
    COUNTIF(l.label = 'shill') AS n_shill,
    COUNTIF(l.label = 'not_shill') AS n_not_shill,
    COUNTIF(l.label = 'unsure') AS n_unsure,
    COUNTIF(
      l.label IN ('shill', 'not_shill')
      AND l.min_cosine_distance IS NOT NULL
      AND l.min_cosine_distance <= t.threshold
    ) AS n_predicted_positive,
    COUNTIF(
      l.label = 'shill'
      AND l.min_cosine_distance IS NOT NULL
      AND l.min_cosine_distance <= t.threshold
    ) AS n_true_positive,
    COUNTIF(
      l.label = 'not_shill'
      AND l.min_cosine_distance IS NOT NULL
      AND l.min_cosine_distance <= t.threshold
    ) AS n_false_positive,
    COUNTIF(
      l.label = 'shill'
      AND (
        l.min_cosine_distance IS NULL
        OR l.min_cosine_distance > t.threshold
      )
    ) AS n_false_negative
  FROM thresholds AS t
  CROSS JOIN _labeled AS l
  GROUP BY t.threshold
),
l2_out AS (
  SELECT
    @pipeline_run_id AS pipeline_run_id,
    'layer2_distance' AS metric_kind,
    l2.cosine_distance_threshold,
    CAST(NULL AS INT64) AS shill_score_threshold,
    l2.n_labeled,
    l2.n_shill,
    l2.n_not_shill,
    l2.n_unsure,
    l2.n_predicted_positive,
    l2.n_true_positive,
    l2.n_false_positive,
    l2.n_false_negative,
    SAFE_DIVIDE(l2.n_true_positive, l2.n_true_positive + l2.n_false_positive) AS precision,
    SAFE_DIVIDE(l2.n_true_positive, l2.n_true_positive + l2.n_false_negative) AS recall,
    (
      SELECT COUNT(*)
      FROM `ecom_shill.layer2_distance_audit` AS a
      WHERE a.pipeline_run_id = @pipeline_run_id
        AND a.min_cosine_distance <= l2.cosine_distance_threshold
    ) AS n_predicted_stage2,
    (
      SELECT COUNT(*)
      FROM `ecom_shill.layer2_distance_audit` AS a
      WHERE a.pipeline_run_id = @pipeline_run_id
        AND a.min_cosine_distance <= l2.cosine_distance_threshold
    ) * @usd_per_review AS estimated_gemini_usd,
    CURRENT_TIMESTAMP() AS computed_at
  FROM l2
),
l3 AS (
  SELECT
    COUNT(*) AS n_labeled,
    COUNTIF(label = 'shill') AS n_shill,
    COUNTIF(label = 'not_shill') AS n_not_shill,
    COUNTIF(label = 'unsure') AS n_unsure,
    COUNTIF(
      label IN ('shill', 'not_shill')
      AND shill_score IS NOT NULL
      AND shill_score >= @shill_score_threshold
    ) AS n_predicted_positive,
    COUNTIF(
      label = 'shill'
      AND shill_score IS NOT NULL
      AND shill_score >= @shill_score_threshold
    ) AS n_true_positive,
    COUNTIF(
      label = 'not_shill'
      AND shill_score IS NOT NULL
      AND shill_score >= @shill_score_threshold
    ) AS n_false_positive,
    COUNTIF(
      label = 'shill'
      AND (
        shill_score IS NULL
        OR shill_score < @shill_score_threshold
      )
    ) AS n_false_negative
  FROM _labeled
)
SELECT * FROM l2_out
UNION ALL
SELECT
  @pipeline_run_id AS pipeline_run_id,
  'layer3_score' AS metric_kind,
  @current_l2_threshold AS cosine_distance_threshold,
  @shill_score_threshold AS shill_score_threshold,
  l3.n_labeled,
  l3.n_shill,
  l3.n_not_shill,
  l3.n_unsure,
  l3.n_predicted_positive,
  l3.n_true_positive,
  l3.n_false_positive,
  l3.n_false_negative,
  SAFE_DIVIDE(l3.n_true_positive, l3.n_true_positive + l3.n_false_positive) AS precision,
  SAFE_DIVIDE(l3.n_true_positive, l3.n_true_positive + l3.n_false_negative) AS recall,
  (
    SELECT COUNT(*)
    FROM `ecom_shill.stage2_suspicious_for_gemini`
    WHERE pipeline_run_id = @pipeline_run_id
  ) AS n_predicted_stage2,
  (
    SELECT COUNT(*)
    FROM `ecom_shill.stage2_suspicious_for_gemini`
    WHERE pipeline_run_id = @pipeline_run_id
  ) * @usd_per_review AS estimated_gemini_usd,
  CURRENT_TIMESTAMP() AS computed_at
FROM l3;
