-- SPDX-License-Identifier: GPL-3.0-only
-- @pipeline_run_id STRING
-- @shill_score_threshold INT64
-- Template self-join on this pipeline_run_id only (KD-23).
-- store_id_a < store_id_b. unlisted_template is excluded.
-- DELETE this run's collisions (template + embedding) before INSERT.

DELETE FROM `ecom_shill.cross_store_template_collisions`
WHERE pipeline_run_id = @pipeline_run_id;

INSERT INTO `ecom_shill.cross_store_template_collisions` (
  pipeline_run_id,
  store_id_a,
  store_id_b,
  review_id_a,
  review_id_b,
  template_id,
  cosine_distance,
  shill_score_a,
  shill_score_b,
  pair_type,
  computed_at
)
SELECT
  @pipeline_run_id AS pipeline_run_id,
  a.store_id AS store_id_a,
  b.store_id AS store_id_b,
  a.review_id AS review_id_a,
  b.review_id AS review_id_b,
  a.template_id,
  CAST(NULL AS FLOAT64) AS cosine_distance,
  a.shill_score AS shill_score_a,
  b.shill_score AS shill_score_b,
  'template' AS pair_type,
  CURRENT_TIMESTAMP() AS computed_at
FROM `ecom_shill.gemini_review_assessments` AS a
INNER JOIN `ecom_shill.gemini_review_assessments` AS b
  ON a.template_id = b.template_id
 AND a.store_id < b.store_id
 AND a.pipeline_run_id = b.pipeline_run_id
WHERE a.pipeline_run_id = @pipeline_run_id
  AND a.template_detected
  AND b.template_detected
  AND a.template_id IS NOT NULL
  AND b.template_id IS NOT NULL
  AND a.template_id != 'unlisted_template'
  AND b.template_id != 'unlisted_template'
  AND a.shill_score >= @shill_score_threshold
  AND b.shill_score >= @shill_score_threshold;
