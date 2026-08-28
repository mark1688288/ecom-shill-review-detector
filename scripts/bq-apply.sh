#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail

: "${GCP_PROJECT:?GCP_PROJECT is required}"
: "${GCP_LOCATION:?GCP_LOCATION is required}"
BQ_DATASET="${BQ_DATASET:-ecom_shill}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DDL_DIR="${ROOT}/sql/ddl"
SEED_DIR="${ROOT}/sql/seeds"

apply_sql() {
  local file="$1"
  local sql
  sql="$(<"$file")"
  sql="${sql//ecom_shill/${BQ_DATASET}}"
  sql="${sql//asia-east1/${GCP_LOCATION}}"
  # stdin: DDL files start with `-- SPDX...`; a positional query argv would be parsed as a flag.
  printf '%s\n' "$sql" | bq --location="${GCP_LOCATION}" --project_id="${GCP_PROJECT}" query \
    --use_legacy_sql=false \
    --nouse_cache
}

apply_sql "${DDL_DIR}/00_dataset.sql"
apply_sql "${DDL_DIR}/01_pipeline_runs.sql"
apply_sql "${DDL_DIR}/02_raw_reviews.sql"
apply_sql "${DDL_DIR}/03_logistics_canned_phrases.sql"
apply_sql "${DDL_DIR}/04_pr_seed_phrases.sql"
apply_sql "${DDL_DIR}/05_stage1_filtered.sql"
apply_sql "${DDL_DIR}/05b_layer1_exclusion_audit.sql"
# Remote-model DDL (Vertex connection) is a later PR; Layer 2 tables do not need it.
apply_sql "${DDL_DIR}/07_review_embeddings.sql"
apply_sql "${DDL_DIR}/08_seed_embeddings.sql"
apply_sql "${DDL_DIR}/09_stage2_suspicious.sql"
apply_sql "${DDL_DIR}/10_gemini_review_assessments.sql"
apply_sql "${DDL_DIR}/11_gemini_assessment_errors.sql"

apply_sql "${SEED_DIR}/pr_seed_phrases_v0.sql"
