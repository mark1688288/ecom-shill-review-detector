-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.review_embeddings` (
  pipeline_run_id STRING NOT NULL,
  review_id STRING NOT NULL,
  store_id STRING NOT NULL,
  product_id STRING NOT NULL,
  content_hash STRING NOT NULL,
  -- BQ rejects NOT NULL on ARRAY (NULL arrays are stored as []). Writers must
  -- emit ARRAY<FLOAT64>[] on status='error'; never SQL NULL.
  embedding ARRAY<FLOAT64>,
  embedding_model STRING NOT NULL,
  task_type STRING NOT NULL,            -- SEMANTIC_SIMILARITY
  status STRING NOT NULL,               -- ok | error
  status_detail STRING,
  embedded_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(embedded_at)
CLUSTER BY pipeline_run_id, store_id;
