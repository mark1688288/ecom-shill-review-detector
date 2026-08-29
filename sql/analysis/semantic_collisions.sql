-- SPDX-License-Identifier: GPL-3.0-only
-- @pipeline_run_id STRING
-- @embedding_model STRING
-- @threshold FLOAT64
-- Embedding collisions on stage2 of this run only (not stage1 pairwise).
-- store_id_a < store_id_b. Distance is cosine *distance* (default 0.20).
-- Does not DELETE: run after cross_store_collisions.sql which cleared the run.

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
WITH pairs AS (
  SELECT
    a.store_id AS store_id_a,
    b.store_id AS store_id_b,
    a.review_id AS review_id_a,
    b.review_id AS review_id_b,
    ML.DISTANCE(ea.embedding, eb.embedding, 'COSINE') AS cosine_distance,
    ga.shill_score AS shill_score_a,
    gb.shill_score AS shill_score_b
  FROM `ecom_shill.stage2_suspicious_for_gemini` AS a
  INNER JOIN `ecom_shill.stage2_suspicious_for_gemini` AS b
    ON a.pipeline_run_id = b.pipeline_run_id
   AND a.store_id < b.store_id
  INNER JOIN `ecom_shill.review_embeddings` AS ea
    ON ea.review_id = a.review_id
   AND ea.pipeline_run_id = a.pipeline_run_id
   AND ea.status = 'ok'
   AND ea.embedding_model = @embedding_model
  INNER JOIN `ecom_shill.review_embeddings` AS eb
    ON eb.review_id = b.review_id
   AND eb.pipeline_run_id = b.pipeline_run_id
   AND eb.status = 'ok'
   AND eb.embedding_model = @embedding_model
  LEFT JOIN `ecom_shill.gemini_review_assessments` AS ga
    ON ga.review_id = a.review_id
   AND ga.pipeline_run_id = a.pipeline_run_id
  LEFT JOIN `ecom_shill.gemini_review_assessments` AS gb
    ON gb.review_id = b.review_id
   AND gb.pipeline_run_id = b.pipeline_run_id
  WHERE a.pipeline_run_id = @pipeline_run_id
)
SELECT
  @pipeline_run_id AS pipeline_run_id,
  store_id_a,
  store_id_b,
  review_id_a,
  review_id_b,
  CAST(NULL AS STRING) AS template_id,
  cosine_distance,
  shill_score_a,
  shill_score_b,
  'embedding' AS pair_type,
  CURRENT_TIMESTAMP() AS computed_at
FROM pairs
WHERE cosine_distance <= @threshold;
