#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail

: "${GCP_PROJECT:?GCP_PROJECT is required}"
: "${GCP_LOCATION:?GCP_LOCATION is required}"
BQ_DATASET="${BQ_DATASET:-ecom_shill}"
BQ_CONNECTION_ID="${BQ_CONNECTION_ID:-ecom_shill_vertex}"
EMBEDDING_MODEL="${EMBEDDING_MODEL:-text-multilingual-embedding-002}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DDL_DIR="${ROOT}/sql/ddl"
SEED_DIR="${ROOT}/sql/seeds"

bq_query() {
  # stdin: DDL files start with `-- SPDX...`; a positional query argv would be parsed as a flag.
  bq --location="${GCP_LOCATION}" --project_id="${GCP_PROJECT}" query \
    --use_legacy_sql=false \
    --nouse_cache
}

apply_sql() {
  local file="$1"
  local sql
  sql="$(<"$file")"
  sql="${sql//ecom_shill/${BQ_DATASET}}"
  sql="${sql//asia-east1/${GCP_LOCATION}}"
  printf '%s\n' "$sql" | bq_query
}

# 06 uses explicit placeholders so connection id ecom_shill_vertex is not rewritten.
apply_remote_model() {
  local file="$1"
  local sql
  sql="$(<"$file")"
  sql="${sql//__GCP_PROJECT__/${GCP_PROJECT}}"
  sql="${sql//__GCP_LOCATION__/${GCP_LOCATION}}"
  sql="${sql//__BQ_CONNECTION_ID__/${BQ_CONNECTION_ID}}"
  sql="${sql//__EMBEDDING_MODEL__/${EMBEDDING_MODEL}}"
  sql="${sql//__DATASET__/${BQ_DATASET}}"
  printf '%s\n' "$sql" | bq_query
}

apply_sql "${DDL_DIR}/00_dataset.sql"
apply_sql "${DDL_DIR}/01_pipeline_runs.sql"
apply_sql "${DDL_DIR}/02_raw_reviews.sql"
apply_sql "${DDL_DIR}/03_logistics_canned_phrases.sql"
apply_sql "${DDL_DIR}/04_pr_seed_phrases.sql"
apply_sql "${DDL_DIR}/05_stage1_filtered.sql"
apply_sql "${DDL_DIR}/05b_layer1_exclusion_audit.sql"
apply_sql "${DDL_DIR}/07_review_embeddings.sql"
apply_sql "${DDL_DIR}/08_seed_embeddings.sql"
apply_sql "${DDL_DIR}/09_stage2_suspicious.sql"
apply_sql "${DDL_DIR}/09b_layer2_distance_audit.sql"
apply_sql "${DDL_DIR}/10_gemini_review_assessments.sql"
apply_sql "${DDL_DIR}/11_gemini_assessment_errors.sql"
apply_sql "${DDL_DIR}/12_store_shill_stats.sql"
apply_sql "${DDL_DIR}/13_burst_events.sql"
apply_sql "${DDL_DIR}/14_cross_store_template_collisions.sql"
apply_sql "${DDL_DIR}/15_shill_network_edges.sql"
apply_sql "${DDL_DIR}/16_funnel_stats.sql"

apply_sql "${SEED_DIR}/pr_seed_phrases_v0.sql"

# Vertex connection + connection SA roles/aiplatform.user must exist.
# 404 on text-multilingual-embedding-002: stop; do not switch to 004.
apply_remote_model "${DDL_DIR}/06_remote_models.sql"
