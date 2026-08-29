-- SPDX-License-Identifier: GPL-3.0-only
-- BigQuery <-> Vertex remote model for Layer 2 embeddings.
-- Prereq: Cloud Resource connection in the same location as the dataset:
--   bq mk --connection --location=$GCP_LOCATION \
--     --connection_type=CLOUD_RESOURCE ecom_shill_vertex
-- Grant that connection's serviceAccountId roles/aiplatform.user (project).
-- Placeholders are substituted by scripts/bq-apply.sh, bq-run-layer2.sh, and
-- the layer2 CLI. Do not replaceAll "ecom_shill" here: it would rewrite
-- connection id ecom_shill_vertex.
-- If CREATE MODEL 404s for text-multilingual-embedding-002 in this region:
-- STOP. Do not silently switch to text-embedding-004.
-- Do not create a BigQuery remote model for Gemini (KD-14: Node worker).

CREATE OR REPLACE MODEL `__DATASET__.text_embedding`
REMOTE WITH CONNECTION `__GCP_PROJECT__.__GCP_LOCATION__.__BQ_CONNECTION_ID__`
OPTIONS (ENDPOINT = '__EMBEDDING_MODEL__');
