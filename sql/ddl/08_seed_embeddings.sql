-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.seed_embeddings` (
  seed_version STRING NOT NULL,
  seed_id STRING NOT NULL,
  category STRING NOT NULL,
  embedding ARRAY<FLOAT64> NOT NULL,
  embedding_model STRING NOT NULL,
  embedded_at TIMESTAMP NOT NULL
);
-- Tiny table; v1 does not partition. Readers must filter:
--   seed_version = @seed_version AND embedding_model = @embedding_model
--   AND seed_id IN (
--     SELECT seed_id FROM pr_seed_phrases
--     WHERE seed_version = @seed_version AND is_active = TRUE
--   )
