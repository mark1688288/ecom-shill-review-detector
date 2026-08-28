-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.pr_seed_phrases` (
  seed_id STRING NOT NULL,              -- stable slot id; reusable across seed_version
  category STRING NOT NULL,             -- one of 7 slots
  seed_text STRING NOT NULL,
  seed_version STRING NOT NULL,
  is_active BOOL NOT NULL,
  created_at TIMESTAMP NOT NULL
);
