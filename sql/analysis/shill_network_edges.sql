-- SPDX-License-Identifier: GPL-3.0-only
-- @pipeline_run_id STRING
-- Aggregate template + embedding collisions into undirected store edges.
-- src_store_id < dst_store_id because collisions already enforce store_id_a < store_id_b.

DELETE FROM `ecom_shill.shill_network_edges`
WHERE pipeline_run_id = @pipeline_run_id;

INSERT INTO `ecom_shill.shill_network_edges` (
  pipeline_run_id,
  src_store_id,
  dst_store_id,
  weight,
  template_ids,
  computed_at
)
SELECT
  pipeline_run_id,
  store_id_a AS src_store_id,
  store_id_b AS dst_store_id,
  COUNT(*) AS weight,
  ARRAY_AGG(DISTINCT template_id IGNORE NULLS) AS template_ids,
  CURRENT_TIMESTAMP() AS computed_at
FROM `ecom_shill.cross_store_template_collisions`
WHERE pipeline_run_id = @pipeline_run_id
GROUP BY pipeline_run_id, store_id_a, store_id_b;
