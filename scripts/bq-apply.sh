#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail

: "${GCP_PROJECT:?GCP_PROJECT is required}"
: "${GCP_LOCATION:?GCP_LOCATION is required}"
BQ_DATASET="${BQ_DATASET:-ecom_shill}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DDL_DIR="${ROOT}/sql/ddl"

apply_sql() {
  local file="$1"
  local sql
  sql="$(<"$file")"
  sql="${sql//ecom_shill/${BQ_DATASET}}"
  sql="${sql//asia-east1/${GCP_LOCATION}}"
  bq --location="${GCP_LOCATION}" --project_id="${GCP_PROJECT}" query \
    --use_legacy_sql=false \
    --nouse_cache \
    "${sql}"
}

apply_sql "${DDL_DIR}/00_dataset.sql"
apply_sql "${DDL_DIR}/01_pipeline_runs.sql"
apply_sql "${DDL_DIR}/02_raw_reviews.sql"
