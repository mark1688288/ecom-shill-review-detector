-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.layer1_exclusion_audit` (
  pipeline_run_id STRING NOT NULL,
  review_id STRING NOT NULL,
  store_id STRING NOT NULL,
  star_rating INT64 NOT NULL,
  char_length INT64 NOT NULL,
  stripped_char_length INT64,
  exclusion_reason STRING NOT NULL  -- non_five_star | too_short | pure_logistics | pass
)
CLUSTER BY pipeline_run_id;
