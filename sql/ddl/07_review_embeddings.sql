-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.review_embeddings` (
  pipeline_run_id STRING NOT NULL,
  review_id STRING NOT NULL,
  store_id STRING NOT NULL,
  product_id STRING NOT NULL,
  content_hash STRING NOT NULL,
  embedding ARRAY<FLOAT64> NOT NULL,    -- status='error' must be []; NULL aborts INSERT
  embedding_model STRING NOT NULL,
  task_type STRING NOT NULL,            -- SEMANTIC_SIMILARITY
  status STRING NOT NULL,               -- ok | error
  status_detail STRING,
  embedded_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(embedded_at)
CLUSTER BY pipeline_run_id, store_id;
