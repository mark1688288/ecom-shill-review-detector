#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Sandbox Layer 2: remote model + embed seeds/reviews + cosine distance filter.
# Does not INSERT pipeline_runs. CI must not execute this script.
set -euo pipefail

: "${GCP_PROJECT:?GCP_PROJECT is required}"
: "${GCP_LOCATION:?GCP_LOCATION is required}"
BQ_DATASET="${BQ_DATASET:-ecom_shill}"
BQ_CONNECTION_ID="${BQ_CONNECTION_ID:-ecom_shill_vertex}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-text-multilingual-embedding-002}"
SEED_VERSION="${SEED_VERSION:-v0_hypothesis}"
COSINE_DISTANCE_THRESHOLD="${COSINE_DISTANCE_THRESHOLD:-0.28}"
PIPELINE_RUN_ID="${PIPELINE_RUN_ID:-${1:-}}"
: "${PIPELINE_RUN_ID:?pipeline_run_id is required (PIPELINE_RUN_ID or argv)}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

substitute_sql() {
  local file="$1"
  local sql
  sql="$(<"$file")"
  sql="${sql//ecom_shill/${BQ_DATASET}}"
  sql="${sql//asia-east1/${GCP_LOCATION}}"
  printf '%s\n' "$sql"
}

substitute_remote_model() {
  local file="$1"
  local sql
  sql="$(<"$file")"
  sql="${sql//__GCP_PROJECT__/${GCP_PROJECT}}"
  sql="${sql//__GCP_LOCATION__/${GCP_LOCATION}}"
  sql="${sql//__BQ_CONNECTION_ID__/${BQ_CONNECTION_ID}}"
  sql="${sql//__EMBEDDING_MODEL__/${EMBEDDING_MODEL}}"
  sql="${sql//__DATASET__/${BQ_DATASET}}"
  printf '%s\n' "$sql"
}

# stdin: SQL files start with `-- SPDX...`; a positional query argv would be parsed as a flag.
bq_query() {
  bq --location="${GCP_LOCATION}" --project_id="${GCP_PROJECT}" query \
    --use_legacy_sql=false \
    --nouse_cache \
    "$@"
}

# 404 on multilingual-002 → stop; do not switch ENDPOINT to text-embedding-004.
substitute_remote_model "${ROOT}/sql/ddl/06_remote_models.sql" | bq_query

substitute_sql "${ROOT}/sql/layer2/embed_seeds.sql" | bq_query \
  --parameter="seed_version:STRING:${SEED_VERSION}" \
  --parameter="embedding_model:STRING:${EMBEDDING_MODEL}"

substitute_sql "${ROOT}/sql/layer2/embed_reviews.sql" | bq_query \
  --parameter="pipeline_run_id:STRING:${PIPELINE_RUN_ID}" \
  --parameter="embedding_model:STRING:${EMBEDDING_MODEL}"

substitute_sql "${ROOT}/sql/layer2/distance_filter.sql" | bq_query \
  --parameter="pipeline_run_id:STRING:${PIPELINE_RUN_ID}" \
  --parameter="seed_version:STRING:${SEED_VERSION}" \
  --parameter="embedding_model:STRING:${EMBEDDING_MODEL}" \
  --parameter="threshold:FLOAT64:${COSINE_DISTANCE_THRESHOLD}"

# Sandbox smoke: 768-d on ok rows; print closest stage2 distances (not a 5% SLA).
bq_query --parameter="pipeline_run_id:STRING:${PIPELINE_RUN_ID}" \
  --parameter="embedding_model:STRING:${EMBEDDING_MODEL}" <<EOF
SELECT
  ARRAY_LENGTH(e.embedding) AS dim,
  COUNT(*) AS n_ok
FROM \`${GCP_PROJECT}.${BQ_DATASET}.review_embeddings\` AS e
JOIN \`${GCP_PROJECT}.${BQ_DATASET}.stage1_filtered\` AS s
  ON s.review_id = e.review_id
WHERE s.pipeline_run_id = @pipeline_run_id
  AND e.embedding_model = @embedding_model
  AND e.status = 'ok'
GROUP BY dim
ORDER BY dim
EOF

bq_query --parameter="pipeline_run_id:STRING:${PIPELINE_RUN_ID}" <<EOF
SELECT
  review_id,
  matched_seed_category,
  min_cosine_distance,
  min_cosine_similarity
FROM \`${GCP_PROJECT}.${BQ_DATASET}.stage2_suspicious_for_gemini\`
WHERE pipeline_run_id = @pipeline_run_id
ORDER BY min_cosine_distance ASC, review_id ASC
LIMIT 10
EOF
