-- SPDX-License-Identifier: GPL-3.0-only
-- @pipeline_run_id STRING
-- @seed_version STRING
-- @embedding_model STRING
-- @threshold FLOAT64
-- Cosine *distance* (1 - similarity). Default threshold 0.28 is a hypothesis,
-- not a CI funnel SLA. Re-run of the same pipeline_run_id must DELETE first.

DELETE FROM `ecom_shill.layer2_distance_audit`
WHERE pipeline_run_id = @pipeline_run_id;

DELETE FROM `ecom_shill.stage2_suspicious_for_gemini`
WHERE pipeline_run_id = @pipeline_run_id;

CREATE TEMP TABLE _ranked AS
WITH dist AS (
  SELECT
    r.review_id,
    r.store_id,
    r.product_id,
    s1.comment_text,
    s1.review_ts,
    se.seed_id,
    se.category,
    ML.DISTANCE(r.embedding, se.embedding, 'COSINE') AS cosine_distance
  FROM `ecom_shill.review_embeddings` AS r
  JOIN `ecom_shill.stage1_filtered` AS s1
    ON s1.review_id = r.review_id
   AND s1.pipeline_run_id = @pipeline_run_id
  CROSS JOIN `ecom_shill.seed_embeddings` AS se
  WHERE r.status = 'ok'
    AND se.seed_version = @seed_version
    AND r.embedding_model = @embedding_model
    AND se.embedding_model = @embedding_model
    AND se.seed_id IN (
      SELECT seed_id
      FROM `ecom_shill.pr_seed_phrases`
      WHERE seed_version = @seed_version
        AND is_active = TRUE
    )
),
ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY review_id ORDER BY cosine_distance ASC, seed_id ASC) AS rn
  FROM dist
)
SELECT * FROM ranked WHERE rn = 1;

INSERT INTO `ecom_shill.layer2_distance_audit` (
  pipeline_run_id,
  review_id,
  store_id,
  product_id,
  matched_seed_id,
  matched_seed_category,
  min_cosine_distance,
  min_cosine_similarity,
  threshold,
  review_ts
)
SELECT
  @pipeline_run_id AS pipeline_run_id,
  review_id,
  store_id,
  product_id,
  seed_id AS matched_seed_id,
  category AS matched_seed_category,
  cosine_distance AS min_cosine_distance,
  1 - cosine_distance AS min_cosine_similarity,
  @threshold AS threshold,
  review_ts
FROM _ranked;

INSERT INTO `ecom_shill.stage2_suspicious_for_gemini` (
  pipeline_run_id,
  review_id,
  store_id,
  product_id,
  comment_text,
  review_ts,
  matched_seed_id,
  matched_seed_category,
  min_cosine_distance,
  min_cosine_similarity,
  threshold
)
SELECT
  @pipeline_run_id AS pipeline_run_id,
  review_id,
  store_id,
  product_id,
  comment_text,
  review_ts,
  seed_id AS matched_seed_id,
  category AS matched_seed_category,
  cosine_distance AS min_cosine_distance,
  1 - cosine_distance AS min_cosine_similarity,
  @threshold AS threshold
FROM _ranked
WHERE cosine_distance <= @threshold;
