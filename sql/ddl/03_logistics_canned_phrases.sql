-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.logistics_canned_phrases` (
  phrase_id STRING NOT NULL,
  phrase STRING NOT NULL,
  match_type STRING NOT NULL,  -- exact | contains | regexp
  lang STRING NOT NULL,        -- yue | zh | en
  category STRING NOT NULL,    -- shipping_speed | packaging | courier | generic_thanks
  is_active BOOL NOT NULL,
  phrase_version STRING NOT NULL,
  notes STRING
);
