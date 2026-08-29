-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.shill_network_edges` (
  pipeline_run_id STRING NOT NULL,
  src_store_id STRING NOT NULL,
  dst_store_id STRING NOT NULL,
  weight INT64 NOT NULL,
  template_ids ARRAY<STRING>,
  computed_at TIMESTAMP NOT NULL
)
CLUSTER BY pipeline_run_id;
