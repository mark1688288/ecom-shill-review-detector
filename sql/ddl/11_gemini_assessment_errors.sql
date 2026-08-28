-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.gemini_assessment_errors` (
  review_id STRING NOT NULL,
  pipeline_run_id STRING NOT NULL,
  attempt_count INT64 NOT NULL,
  http_status INT64,
  error_class STRING NOT NULL,          -- rate_limit | server | schema | timeout | unknown
  error_message STRING,
  retryable BOOL NOT NULL,
  failed_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(failed_at);
