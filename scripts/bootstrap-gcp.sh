#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Echo-only sandbox checklist. Does not call gcloud / mutate GCP.
# Real IAM + Vertex connection + CREATE MODEL are required before live layer2.
set -euo pipefail

cat <<'EOF'
bootstrap-gcp.sh (echo-only)

Prereq: gcloud CLI, an empty-enough GCP project, and:
  export GCP_PROJECT=<your-project>
  export GCP_LOCATION=asia-east1   # required; dataset / connection / Vertex must match
  export BQ_DATASET=ecom_shill
  export BQ_CONNECTION_ID=ecom_shill_vertex
  export EMBEDDING_MODEL=text-multilingual-embedding-002
  export GCS_STAGING_BUCKET=gs://${GCP_PROJECT}-ecom-shill-staging

This script prints the steps. It does not enable APIs or create resources.

1) Enable APIs
  gcloud services enable \
    bigquery.googleapis.com \
    aiplatform.googleapis.com \
    storage.googleapis.com \
    iam.googleapis.com \
    --project="${GCP_PROJECT}"

2) Create dataset ecom_shill in asia-east1
  bq --location="${GCP_LOCATION}" mk --dataset "${GCP_PROJECT}:${BQ_DATASET}"

3) Staging bucket (uniform access, lifecycle 7 days). Prefer gcloud storage, not gsutil.
  gcloud storage buckets create "${GCS_STAGING_BUCKET}" \
    --project="${GCP_PROJECT}" \
    --location="${GCP_LOCATION}" \
    --uniform-bucket-level-access
  echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}' > /tmp/lifecycle.json
  gcloud storage buckets update "${GCS_STAGING_BUCKET}" \
    --lifecycle-file=/tmp/lifecycle.json

4) Cloud Resource connection (BigQuery remote model / Vertex)
  bq mk --connection \
    --location="${GCP_LOCATION}" \
    --connection_type=CLOUD_RESOURCE \
    "${BQ_CONNECTION_ID}"
  bq show --connection --location="${GCP_LOCATION}" \
    --format=prettyjson "${BQ_CONNECTION_ID}"
  # CONNECTION_SA = JSON serviceAccountId

5) IAM (minimum; see docs/design.md)
  Developer / CLI identity (not roles/owner for the job itself):
    gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
      --member="user:<you>" \
      --role="roles/bigquery.jobUser"
    # dataset ecom_shill: roles/bigquery.dataEditor (bq update access)
    gcloud storage buckets add-iam-policy-binding "${GCS_STAGING_BUCKET}" \
      --member="user:<you>" \
      --role="roles/storage.objectAdmin"
  Connection SA (the only principal that should hold project-wide aiplatform.user):
    gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
      --member="serviceAccount:${CONNECTION_SA}" \
      --role="roles/aiplatform.user"
  Worker SA (audit, later): prefer a custom role with aiplatform.endpoints.predict
    over project-wide aiplatform.user.
  Do not grant roles/owner or roles/bigquery.admin to the CLI / worker / connection SA.
  A one-person sandbox may keep roles/owner on the human admin account.

6) Remote embedding model (PR-05b)
  ./scripts/bq-apply.sh
  # 06_remote_models.sql:
  # CREATE OR REPLACE MODEL `${BQ_DATASET}.text_embedding`
  # REMOTE WITH CONNECTION `${GCP_PROJECT}.${GCP_LOCATION}.${BQ_CONNECTION_ID}`
  # OPTIONS (ENDPOINT = '${EMBEDDING_MODEL}');
  Stop if CREATE MODEL 404s for text-multilingual-embedding-002 in this region.
  Do not silently switch to text-embedding-004.
  Do not create a BigQuery remote model for Gemini.

7) Layer 2 smoke (existing pipeline_run_id from load/layer1)
  pnpm cli layer2 --continue-latest
  # or: PIPELINE_RUN_ID=<uuid> ./scripts/bq-run-layer2.sh
  Expect ARRAY_LENGTH=768 on status='ok' rows. Print cosine distances; 0.28 is a hypothesis.

v1 has no live marketplace crawler. Do not put cookies, tokens, or real shop endpoints in git.
EOF
