-- SPDX-License-Identifier: GPL-3.0-only
-- @pipeline_run_id STRING
-- RE2 alternation is leftmost-first; longest phrase must come first.
-- ARRAY_AGG of 0 rows is NULL; NULL pattern must not REGEXP_REPLACE (NULL lengths).

CREATE TEMP TABLE _phrases AS
SELECT phrase, match_type
FROM `ecom_shill.logistics_canned_phrases`
WHERE is_active = TRUE
  AND match_type IN ('contains', 'exact');

CREATE TEMP TABLE _regex AS
SELECT
  CASE
    WHEN COUNT(*) = 0 THEN CAST(NULL AS STRING)
    ELSE CONCAT(
      '(?i)',
      ARRAY_TO_STRING(
        ARRAY_AGG(
          REGEXP_REPLACE(phrase, r'([\\.^$|?*+()[\]{}])', r'\\\1')
          ORDER BY LENGTH(phrase) DESC
        ),
        '|'
      )
    )
  END AS pattern
FROM _phrases;

DELETE FROM `ecom_shill.stage1_filtered`
WHERE pipeline_run_id = @pipeline_run_id;

DELETE FROM `ecom_shill.layer1_exclusion_audit`
WHERE pipeline_run_id = @pipeline_run_id;

CREATE TEMP TABLE _stripped AS
SELECT
  r.review_id,
  r.marketplace,
  r.store_id,
  r.product_id,
  r.reviewer_id_hash,
  r.star_rating,
  r.comment_text,
  r.content_hash,
  r.review_ts,
  r.language_hint,
  r.char_length,
  CHAR_LENGTH(
    TRIM(
      IF(
        p.pattern IS NULL,
        r.comment_text,
        REGEXP_REPLACE(r.comment_text, p.pattern, '')
      )
    )
  ) AS stripped_char_length
FROM `ecom_shill.raw_reviews` AS r
CROSS JOIN _regex AS p
WHERE r.pipeline_run_id = @pipeline_run_id;

INSERT INTO `ecom_shill.stage1_filtered` (
  pipeline_run_id,
  review_id,
  marketplace,
  store_id,
  product_id,
  reviewer_id_hash,
  star_rating,
  comment_text,
  content_hash,
  review_ts,
  language_hint,
  char_length,
  stripped_char_length,
  filter_reason
)
SELECT
  @pipeline_run_id AS pipeline_run_id,
  review_id,
  marketplace,
  store_id,
  product_id,
  reviewer_id_hash,
  star_rating,
  comment_text,
  content_hash,
  review_ts,
  language_hint,
  char_length,
  stripped_char_length,
  'pass' AS filter_reason
FROM _stripped
WHERE star_rating = 5
  AND char_length >= 25
  AND stripped_char_length >= 25;
