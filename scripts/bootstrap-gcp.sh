#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-only
# Echo-only sandbox checklist. Does not call gcloud / mutate GCP.
# Real IAM + Vertex connection + CREATE MODEL are required before live layer2.
# Worked session log (project-specific ids, not a template): docs/gcp-commands.md
set -euo pipefail

cat <<'EOF'
bootstrap-gcp.sh (echo-only)

Generic checklist distilled from docs/gcp-commands.md. Do not copy project ids,
Gmail addresses, crawl_batch_id, or pipeline_run_id from that log.

Prereq: gcloud CLI, an empty-enough GCP project, and:
  export GCP_PROJECT=<your-project>
  export GCP_LOCATION=asia-east1   # required; dataset / connection / Vertex must match
  export BQ_DATASET=ecom_shill
  export BQ_CONNECTION_ID=ecom_shill_vertex
  export EMBEDDING_MODEL=text-multilingual-embedding-002
  export GCS_STAGING_BUCKET=gs://${GCP_PROJECT}-ecom-shill-staging

This script prints the steps. It does not enable APIs or create resources.

0) Auth + ADC (local; every machine)
  gcloud auth login
  gcloud auth application-default login
  gcloud config set project "${GCP_PROJECT}"
  gcloud config set compute/region "${GCP_LOCATION}"
  gcloud auth application-default set-quota-project "${GCP_PROJECT}"

1) Enable APIs, then verify (BQ / Storage may already be on)
  gcloud services enable \
    bigquery.googleapis.com \
    aiplatform.googleapis.com \
    storage.googleapis.com \
    iam.googleapis.com \
    --project="${GCP_PROJECT}"
  gcloud services list --enabled --project="${GCP_PROJECT}" \
    --filter="config.name:(bigquery.googleapis.com OR aiplatform.googleapis.com OR storage.googleapis.com OR iam.googleapis.com)"

2) Create dataset ecom_shill in asia-east1
  bq --location="${GCP_LOCATION}" mk --dataset "${GCP_PROJECT}:${BQ_DATASET}"

3) Staging bucket (uniform access, lifecycle 7 days). Prefer gcloud storage, not gsutil.
   Skip create if the bucket already exists (mk is not idempotent).
  gcloud storage buckets create "${GCS_STAGING_BUCKET}" \
    --project="${GCP_PROJECT}" \
    --location="${GCP_LOCATION}" \
    --uniform-bucket-level-access
  echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}' > /tmp/lifecycle.json
  gcloud storage buckets update "${GCS_STAGING_BUCKET}" \
    --lifecycle-file=/tmp/lifecycle.json
  gcloud storage buckets describe "${GCS_STAGING_BUCKET}" \
    --format="yaml(name,location,lifecycle_config,iam_configuration.uniformBucketLevelAccess)"

4) Cloud Resource connection (BigQuery remote model / Vertex)
  bq mk --connection \
    --location="${GCP_LOCATION}" \
    --connection_type=CLOUD_RESOURCE \
    "${BQ_CONNECTION_ID}"
  bq show --connection --location="${GCP_LOCATION}" \
    --format=prettyjson "${BQ_CONNECTION_ID}"
  # CONNECTION_SA = JSON serviceAccountId (not your Gmail)

5) IAM (minimum)
  Developer / CLI identity (not roles/owner for the job itself).
  MEMBER="user:<you@example.com>"
    gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
      --member="${MEMBER}" \
      --role="roles/bigquery.jobUser"
    # dataset ecom_shill: roles/bigquery.dataEditor (not OWNER)
    bq show --format=prettyjson "${GCP_PROJECT}:${BQ_DATASET}" > /tmp/ecom_shill.json
    # append {"role":"roles/bigquery.dataEditor","userByEmail":"<you@example.com>"}
    # to access[] if missing, then:
    bq update --source=/tmp/ecom_shill.json "${GCP_PROJECT}:${BQ_DATASET}"
    gcloud storage buckets add-iam-policy-binding "${GCS_STAGING_BUCKET}" \
      --member="${MEMBER}" \
      --role="roles/storage.objectAdmin"
  Connection SA (the only principal that should hold project-wide aiplatform.user):
    gcloud projects add-iam-policy-binding "${GCP_PROJECT}" \
      --member="serviceAccount:${CONNECTION_SA}" \
      --role="roles/aiplatform.user"
  Worker SA (audit, later): prefer a custom role with aiplatform.endpoints.predict
    over project-wide aiplatform.user.
  Do not grant roles/owner or roles/bigquery.admin to the CLI / worker / connection SA.
  A one-person sandbox may keep roles/owner on the human admin account.
  Verify:
    gcloud projects get-iam-policy "${GCP_PROJECT}" \
      --flatten="bindings[].members" \
      --filter="bindings.role=roles/bigquery.jobUser" \
      --format="table(bindings.role, bindings.members)"
    bq show --format=prettyjson "${GCP_PROJECT}:${BQ_DATASET}"
    gcloud storage buckets get-iam-policy "${GCS_STAGING_BUCKET}" \
      --format="table(bindings.role, bindings.members)"

6) .env (CLI does not load .env by itself)
  cp .env.example .env   # skip if .env already exists
  # REVIEWER_ID_SALT >= 16 chars. Generate locally; never commit; never load into BQ.
  #   export REVIEWER_ID_SALT="$(openssl rand -hex 16)"
  # Set GCP_PROJECT, GCP_LOCATION, BQ_DATASET, GCS_STAGING_BUCKET, BQ_CONNECTION_ID.
  # Gemini generateContent is not served in asia-east1. BQ / embedding stay GCP_LOCATION.
  #   GEMINI_LOCATION=global
  Every new terminal:
    set -a && source .env && set +a

7) Remote embedding model (PR-05b)
  ./scripts/bq-apply.sh
  # applies sql/ddl 00–16 + human_labels + v0 seeds, then 06_remote_models.sql:
  # CREATE OR REPLACE MODEL `${BQ_DATASET}.text_embedding`
  # REMOTE WITH CONNECTION `${GCP_PROJECT}.${GCP_LOCATION}.${BQ_CONNECTION_ID}`
  # OPTIONS (ENDPOINT = '${EMBEDDING_MODEL}');
  Stop if CREATE MODEL 404s for text-multilingual-embedding-002 in this region.
  Do not silently switch to text-embedding-004.
  Do not create a BigQuery remote model for Gemini.
  Verify:
    bq ls --project_id="${GCP_PROJECT}" "${BQ_DATASET}"
    bq query --use_legacy_sql=false --project_id="${GCP_PROJECT}" \
      'SELECT COUNT(*) AS n FROM `ecom_shill.pr_seed_phrases` WHERE seed_version = "v0_hypothesis"'

8) Fixture ingest smoke (creates pipeline_run_id on load)
  pnpm cli crawl --adapter fixture \
    --input fixtures/reviews/cantonese-mix.jsonl
  pnpm cli load \
    --ndjson data/batches/<crawl_batch_id>/reviews.ndjson \
    --continue-latest
  pnpm cli layer1 --continue-latest
  # stage1: CHAR_LENGTH >= 25, star_rating = 5, not pure logistics
  bq query --use_legacy_sql=false --project_id="${GCP_PROJECT}" \
    --parameter="pipeline_run_id:STRING:${PIPELINE_RUN_ID}" \
    'SELECT COUNT(*) AS n FROM `ecom_shill.stage1_filtered` WHERE pipeline_run_id = @pipeline_run_id'

9) Layer 2 smoke (existing pipeline_run_id from load/layer1)
  pnpm cli layer2 --continue-latest
  # or: PIPELINE_RUN_ID=<uuid> ./scripts/bq-run-layer2.sh
  Expect ARRAY_LENGTH=768 on status='ok' rows. Print cosine distances; 0.28 is a hypothesis.
  bq query --use_legacy_sql=false --project_id="${GCP_PROJECT}" \
    --parameter="pipeline_run_id:STRING:${PIPELINE_RUN_ID}" \
    --parameter="embedding_model:STRING:text-multilingual-embedding-002" \
    'SELECT ARRAY_LENGTH(e.embedding) AS dim, COUNT(*) AS n
     FROM `ecom_shill.review_embeddings` e
     JOIN `ecom_shill.stage1_filtered` s ON s.review_id = e.review_id
     WHERE s.pipeline_run_id = @pipeline_run_id
       AND e.embedding_model = @embedding_model
       AND e.status = "ok"
     GROUP BY dim'
  bq query --use_legacy_sql=false --project_id="${GCP_PROJECT}" \
    --parameter="pipeline_run_id:STRING:${PIPELINE_RUN_ID}" \
    'SELECT review_id, matched_seed_category, min_cosine_distance
     FROM `ecom_shill.stage2_suspicious_for_gemini`
     WHERE pipeline_run_id = @pipeline_run_id
     ORDER BY min_cosine_distance
     LIMIT 10'

10) Audit (Gemini Flash; not required for analyze SQL itself)
  # asia-east1 has no generateContent; set GEMINI_LOCATION=global. Do not change GCP_LOCATION.
  pnpm cli audit --continue-latest

11) Analyze + report (does not call Gemini)
  pnpm cli analyze --continue-latest
  pnpm cli report --continue-latest --format markdown --dot
  bq query --use_legacy_sql=false --project_id="${GCP_PROJECT}" \
    --parameter="pipeline_run_id:STRING:${PIPELINE_RUN_ID}" \
    'SELECT store_id, n_assessed, n_shill_75, pct_shill_75
     FROM `ecom_shill.store_shill_stats`
     WHERE pipeline_run_id = @pipeline_run_id
     ORDER BY pct_shill_75 DESC'
  bq query --use_legacy_sql=false --project_id="${GCP_PROJECT}" \
    --parameter="pipeline_run_id:STRING:${PIPELINE_RUN_ID}" \
    'SELECT pair_type, COUNT(*) AS n
     FROM `ecom_shill.cross_store_template_collisions`
     WHERE pipeline_run_id = @pipeline_run_id
     GROUP BY pair_type'
  bq query --use_legacy_sql=false --project_id="${GCP_PROJECT}" \
    --parameter="pipeline_run_id:STRING:${PIPELINE_RUN_ID}" \
    'SELECT src_store_id, dst_store_id, weight
     FROM `ecom_shill.shill_network_edges`
     WHERE pipeline_run_id = @pipeline_run_id'

v1 has no live marketplace crawler. Do not put cookies, tokens, or real shop endpoints in git.
EOF
