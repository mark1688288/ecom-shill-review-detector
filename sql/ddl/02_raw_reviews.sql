-- SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS `ecom_shill.raw_reviews` (
  review_id STRING NOT NULL,
  marketplace STRING NOT NULL,
  native_review_id STRING,
  store_id STRING NOT NULL,
  product_id STRING NOT NULL,
  reviewer_id_hash STRING NOT NULL,
  star_rating INT64 NOT NULL,
  comment_text STRING NOT NULL,
  content_hash STRING NOT NULL,
  review_ts TIMESTAMP NOT NULL,
  ingested_at TIMESTAMP NOT NULL,
  crawl_batch_id STRING NOT NULL,
  pipeline_run_id STRING NOT NULL,
  source_url_hash STRING,
  language_hint STRING NOT NULL,
  has_media BOOL NOT NULL,
  raw_payload_hash STRING,
  char_length INT64 NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  PRIMARY KEY (review_id) NOT ENFORCED
)
PARTITION BY DATE(review_ts)
CLUSTER BY marketplace, store_id, product_id
OPTIONS (description = 'Full-fidelity reviews; PII-hashed reviewer ids');
