#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Phase 0: echo-only. Does not call gcloud / mutate GCP.
# Real IAM + connection is a Phase 2 sandbox checklist, not a PR-00 merge gate.
set -euo pipefail

cat <<'EOF'
bootstrap-gcp.sh (echo-only)

Prereq: gcloud CLI, an empty-enough GCP project, and:
  export GCP_PROJECT=<your-project>
  export GCP_LOCATION=asia-east1   # required; dataset / connection / Vertex must match

This script prints the steps. It does not enable APIs or create resources.

1) Enable APIs
  gcloud services enable \
    bigquery.googleapis.com \
    aiplatform.googleapis.com \
    storage.googleapis.com \
    iam.googleapis.com \
    --project="${GCP_PROJECT}"

2) Create dataset ecom_shill in asia-east1
  bq --location="${GCP_LOCATION}" mk --dataset "${GCP_PROJECT}:ecom_shill"

3) Create Cloud Resource connection (BigQuery remote model / Vertex)
  bq mk --connection \
    --location="${GCP_LOCATION}" \
    --connection_type=CLOUD_RESOURCE \
    ecom_shill_vertex

4) IAM (minimum; see docs/design.md)
  Developer / optional sandbox CI SA:
    roles/bigquery.jobUser          (project)
    roles/bigquery.dataEditor       (dataset ecom_shill)
    roles/storage.objectAdmin       (staging bucket only)
  Connection SA:
    roles/aiplatform.user           (this is the only principal that should hold project-wide aiplatform.user by default)
  Worker SA (audit):
    aiplatform.endpoints.predict capability; prefer a custom role over project-wide aiplatform.user
  Do not grant roles/owner or roles/bigquery.admin.

5) Staging bucket (lifecycle 7 days)
  gsutil mb -p "${GCP_PROJECT}" -l "${GCP_LOCATION}" "gs://${GCP_PROJECT}-ecom-shill-staging"

Stop if CREATE MODEL 404s for text-multilingual-embedding-002 in this region.
Do not silently switch to text-embedding-004.

v1 has no live marketplace crawler. Do not put cookies, tokens, or real shop endpoints in git.
EOF
