-- SPDX-License-Identifier: GPL-3.0-only
-- Shares _stripped from filter_stage1.sql in the same script job.

INSERT INTO `ecom_shill.layer1_exclusion_audit` (
  pipeline_run_id,
  review_id,
  store_id,
  star_rating,
  char_length,
  stripped_char_length,
  exclusion_reason
)
SELECT
  @pipeline_run_id AS pipeline_run_id,
  review_id,
  store_id,
  star_rating,
  char_length,
  stripped_char_length,
  CASE
    WHEN star_rating != 5 THEN 'non_five_star'
    WHEN char_length < 25 THEN 'too_short'
    WHEN stripped_char_length < 25 THEN 'pure_logistics'
    ELSE 'pass'
  END AS exclusion_reason
FROM _stripped;
