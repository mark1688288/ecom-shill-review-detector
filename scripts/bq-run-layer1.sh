#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
set -euo pipefail

: "${GCP_PROJECT:?GCP_PROJECT is required}"
: "${GCP_LOCATION:?GCP_LOCATION is required}"
BQ_DATASET="${BQ_DATASET:-ecom_shill}"
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

# stdin: SQL files start with `-- SPDX...`; a positional query argv would be parsed as a flag.
bq_query() {
  bq --location="${GCP_LOCATION}" --project_id="${GCP_PROJECT}" query \
    --use_legacy_sql=false \
    --nouse_cache \
    "$@"
}

substitute_sql "${ROOT}/sql/seeds/logistics_canned_phrases.sql" | bq_query

{
  substitute_sql "${ROOT}/sql/layer1/filter_stage1.sql"
  substitute_sql "${ROOT}/sql/layer1/debug_exclusions.sql"
} | bq_query --parameter="pipeline_run_id:STRING:${PIPELINE_RUN_ID}"
