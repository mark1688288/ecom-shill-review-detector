-- SPDX-License-Identifier: GPL-3.0-only
-- @pipeline_run_id STRING
-- @embedding_model STRING
-- Default model text-multilingual-embedding-002 is 768-d; max input ~2048 tokens.
-- CJK worst case ~1 token/char, so LEFT(..., 6000) can overflow the window.
-- Vertex autoTruncate defaults true and would embed a prefix only. v1 uses
-- LEFT(..., 1500) as a conservative CJK bound (config layer2.comment_char_cap).
-- Error rows must be status='error' with embedding=[] — NULL aborts the INSERT.
-- EXISTS (not correlated IN) so content_hash mismatch DELETE is valid BQ DML.

DELETE FROM `ecom_shill.review_embeddings` AS e
WHERE e.embedding_model = @embedding_model
  AND EXISTS (
    SELECT 1
    FROM `ecom_shill.stage1_filtered` AS s
    WHERE s.pipeline_run_id = @pipeline_run_id
      AND s.review_id = e.review_id
      AND s.content_hash != e.content_hash
  );

INSERT INTO `ecom_shill.review_embeddings` (
  pipeline_run_id,
  review_id,
  store_id,
  product_id,
  content_hash,
  embedding,
  embedding_model,
  task_type,
  status,
  status_detail,
  embedded_at
)
SELECT
  @pipeline_run_id AS pipeline_run_id,
  review_id,
  store_id,
  product_id,
  content_hash,
  IFNULL(ml_generate_embedding_result, ARRAY<FLOAT64>[]) AS embedding,
  @embedding_model AS embedding_model,
  'SEMANTIC_SIMILARITY' AS task_type,
  IF(
    LENGTH(IFNULL(ml_generate_embedding_status, '')) = 0
    AND ARRAY_LENGTH(IFNULL(ml_generate_embedding_result, ARRAY<FLOAT64>[])) > 0,
    'ok',
    'error'
  ) AS status,
  ml_generate_embedding_status AS status_detail,
  CURRENT_TIMESTAMP() AS embedded_at
FROM ML.GENERATE_EMBEDDING(
  MODEL `ecom_shill.text_embedding`,
  (
    SELECT
      s.review_id,
      s.store_id,
      s.product_id,
      s.content_hash,
      LEFT(s.comment_text, 1500) AS content
    FROM `ecom_shill.stage1_filtered` AS s
    WHERE s.pipeline_run_id = @pipeline_run_id
      AND s.review_id NOT IN (
        SELECT review_id
        FROM `ecom_shill.review_embeddings`
        WHERE embedding_model = @embedding_model
          AND status = 'ok'
      )
  ),
  STRUCT(
    TRUE AS flatten_json_output,
    'SEMANTIC_SIMILARITY' AS task_type
  )
);
