-- SPDX-License-Identifier: GPL-3.0-only
-- @seed_version STRING
-- @embedding_model STRING
-- Re-run of the same (seed_version, embedding_model) must not duplicate rows.

DELETE FROM `ecom_shill.seed_embeddings`
WHERE seed_version = @seed_version
  AND embedding_model = @embedding_model;

INSERT INTO `ecom_shill.seed_embeddings` (
  seed_version,
  seed_id,
  category,
  embedding,
  embedding_model,
  embedded_at
)
SELECT
  @seed_version AS seed_version,
  seed_id,
  category,
  IFNULL(ml_generate_embedding_result, ARRAY<FLOAT64>[]) AS embedding,
  @embedding_model AS embedding_model,
  CURRENT_TIMESTAMP() AS embedded_at
FROM ML.GENERATE_EMBEDDING(
  MODEL `ecom_shill.text_embedding`,
  (
    SELECT
      seed_id,
      category,
      seed_text AS content
    FROM `ecom_shill.pr_seed_phrases`
    WHERE seed_version = @seed_version
      AND is_active = TRUE
  ),
  STRUCT(
    TRUE AS flatten_json_output,
    'SEMANTIC_SIMILARITY' AS task_type
  )
)
WHERE ARRAY_LENGTH(IFNULL(ml_generate_embedding_result, ARRAY<FLOAT64>[])) > 0;
