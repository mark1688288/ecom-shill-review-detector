-- SPDX-License-Identifier: GPL-3.0-only
-- @pipeline_run_id STRING
-- Burst on raw_reviews for this run (all star ratings). Sample stddev: STDDEV_SAMP.
-- Day: baseline = same group, past 14 days excluding the bucket.
--   baseline_days < 5 OR stddev IS NULL OR stddev = 0 → z_score NULL, is_burst FALSE
--   else is_burst = (z_score >= 3 AND n_reviews >= 10)
-- Hour: is_burst = n_reviews >= 8 AND five-star ratio >= 0.9
--   AND the group has >= 5 hour buckets with data; else FALSE
-- product_id NULL = store-level; filled = store+product.
-- Two granularities × two grouping levels = four INSERTs after DELETE.

DELETE FROM `ecom_shill.burst_events`
WHERE pipeline_run_id = @pipeline_run_id;

-- 1) day, store-level
INSERT INTO `ecom_shill.burst_events` (
  pipeline_run_id,
  store_id,
  product_id,
  bucket_ts,
  granularity,
  n_reviews,
  n_five_star,
  baseline_mean,
  baseline_stddev,
  z_score,
  is_burst
)
WITH daily AS (
  SELECT
    store_id,
    TIMESTAMP_TRUNC(review_ts, DAY) AS bucket_ts,
    COUNT(*) AS n_reviews,
    COUNTIF(star_rating = 5) AS n_five_star
  FROM `ecom_shill.raw_reviews`
  WHERE pipeline_run_id = @pipeline_run_id
  GROUP BY store_id, bucket_ts
),
scored AS (
  SELECT
    d.store_id,
    d.bucket_ts,
    d.n_reviews,
    d.n_five_star,
    AVG(p.n_reviews) AS baseline_mean,
    STDDEV_SAMP(p.n_reviews) AS baseline_stddev,
    COUNT(p.bucket_ts) AS baseline_days
  FROM daily AS d
  LEFT JOIN daily AS p
    ON p.store_id = d.store_id
   AND p.bucket_ts >= TIMESTAMP_SUB(d.bucket_ts, INTERVAL 14 DAY)
   AND p.bucket_ts < d.bucket_ts
  GROUP BY d.store_id, d.bucket_ts, d.n_reviews, d.n_five_star
)
SELECT
  @pipeline_run_id AS pipeline_run_id,
  store_id,
  CAST(NULL AS STRING) AS product_id,
  bucket_ts,
  'day' AS granularity,
  n_reviews,
  n_five_star,
  baseline_mean,
  baseline_stddev,
  CASE
    WHEN baseline_days < 5 OR baseline_stddev IS NULL OR baseline_stddev = 0 THEN CAST(NULL AS FLOAT64)
    ELSE (n_reviews - baseline_mean) / baseline_stddev
  END AS z_score,
  CASE
    WHEN baseline_days < 5 OR baseline_stddev IS NULL OR baseline_stddev = 0 THEN FALSE
    ELSE ((n_reviews - baseline_mean) / baseline_stddev) >= 3 AND n_reviews >= 10
  END AS is_burst
FROM scored;

-- 2) day, store+product
INSERT INTO `ecom_shill.burst_events` (
  pipeline_run_id,
  store_id,
  product_id,
  bucket_ts,
  granularity,
  n_reviews,
  n_five_star,
  baseline_mean,
  baseline_stddev,
  z_score,
  is_burst
)
WITH daily AS (
  SELECT
    store_id,
    product_id,
    TIMESTAMP_TRUNC(review_ts, DAY) AS bucket_ts,
    COUNT(*) AS n_reviews,
    COUNTIF(star_rating = 5) AS n_five_star
  FROM `ecom_shill.raw_reviews`
  WHERE pipeline_run_id = @pipeline_run_id
  GROUP BY store_id, product_id, bucket_ts
),
scored AS (
  SELECT
    d.store_id,
    d.product_id,
    d.bucket_ts,
    d.n_reviews,
    d.n_five_star,
    AVG(p.n_reviews) AS baseline_mean,
    STDDEV_SAMP(p.n_reviews) AS baseline_stddev,
    COUNT(p.bucket_ts) AS baseline_days
  FROM daily AS d
  LEFT JOIN daily AS p
    ON p.store_id = d.store_id
   AND p.product_id = d.product_id
   AND p.bucket_ts >= TIMESTAMP_SUB(d.bucket_ts, INTERVAL 14 DAY)
   AND p.bucket_ts < d.bucket_ts
  GROUP BY d.store_id, d.product_id, d.bucket_ts, d.n_reviews, d.n_five_star
)
SELECT
  @pipeline_run_id AS pipeline_run_id,
  store_id,
  product_id,
  bucket_ts,
  'day' AS granularity,
  n_reviews,
  n_five_star,
  baseline_mean,
  baseline_stddev,
  CASE
    WHEN baseline_days < 5 OR baseline_stddev IS NULL OR baseline_stddev = 0 THEN CAST(NULL AS FLOAT64)
    ELSE (n_reviews - baseline_mean) / baseline_stddev
  END AS z_score,
  CASE
    WHEN baseline_days < 5 OR baseline_stddev IS NULL OR baseline_stddev = 0 THEN FALSE
    ELSE ((n_reviews - baseline_mean) / baseline_stddev) >= 3 AND n_reviews >= 10
  END AS is_burst
FROM scored;

-- 3) hour, store-level
INSERT INTO `ecom_shill.burst_events` (
  pipeline_run_id,
  store_id,
  product_id,
  bucket_ts,
  granularity,
  n_reviews,
  n_five_star,
  baseline_mean,
  baseline_stddev,
  z_score,
  is_burst
)
WITH hourly AS (
  SELECT
    store_id,
    TIMESTAMP_TRUNC(review_ts, HOUR) AS bucket_ts,
    COUNT(*) AS n_reviews,
    COUNTIF(star_rating = 5) AS n_five_star
  FROM `ecom_shill.raw_reviews`
  WHERE pipeline_run_id = @pipeline_run_id
  GROUP BY store_id, bucket_ts
),
store_buckets AS (
  SELECT store_id, COUNT(*) AS n_buckets
  FROM hourly
  GROUP BY store_id
),
scored AS (
  SELECT
    d.store_id,
    d.bucket_ts,
    d.n_reviews,
    d.n_five_star,
    AVG(p.n_reviews) AS baseline_mean,
    STDDEV_SAMP(p.n_reviews) AS baseline_stddev,
    COUNT(p.bucket_ts) AS baseline_hours,
    sb.n_buckets AS store_bucket_count
  FROM hourly AS d
  INNER JOIN store_buckets AS sb
    ON sb.store_id = d.store_id
  LEFT JOIN hourly AS p
    ON p.store_id = d.store_id
   AND p.bucket_ts >= TIMESTAMP_SUB(d.bucket_ts, INTERVAL 14 DAY)
   AND p.bucket_ts < d.bucket_ts
  GROUP BY d.store_id, d.bucket_ts, d.n_reviews, d.n_five_star, sb.n_buckets
)
SELECT
  @pipeline_run_id AS pipeline_run_id,
  store_id,
  CAST(NULL AS STRING) AS product_id,
  bucket_ts,
  'hour' AS granularity,
  n_reviews,
  n_five_star,
  baseline_mean,
  baseline_stddev,
  CASE
    WHEN baseline_hours < 5 OR baseline_stddev IS NULL OR baseline_stddev = 0 THEN CAST(NULL AS FLOAT64)
    ELSE (n_reviews - baseline_mean) / baseline_stddev
  END AS z_score,
  CASE
    WHEN store_bucket_count < 5 THEN FALSE
    ELSE n_reviews >= 8 AND SAFE_DIVIDE(n_five_star, n_reviews) >= 0.9
  END AS is_burst
FROM scored;

-- 4) hour, store+product
INSERT INTO `ecom_shill.burst_events` (
  pipeline_run_id,
  store_id,
  product_id,
  bucket_ts,
  granularity,
  n_reviews,
  n_five_star,
  baseline_mean,
  baseline_stddev,
  z_score,
  is_burst
)
WITH hourly AS (
  SELECT
    store_id,
    product_id,
    TIMESTAMP_TRUNC(review_ts, HOUR) AS bucket_ts,
    COUNT(*) AS n_reviews,
    COUNTIF(star_rating = 5) AS n_five_star
  FROM `ecom_shill.raw_reviews`
  WHERE pipeline_run_id = @pipeline_run_id
  GROUP BY store_id, product_id, bucket_ts
),
group_buckets AS (
  SELECT store_id, product_id, COUNT(*) AS n_buckets
  FROM hourly
  GROUP BY store_id, product_id
),
scored AS (
  SELECT
    d.store_id,
    d.product_id,
    d.bucket_ts,
    d.n_reviews,
    d.n_five_star,
    AVG(p.n_reviews) AS baseline_mean,
    STDDEV_SAMP(p.n_reviews) AS baseline_stddev,
    COUNT(p.bucket_ts) AS baseline_hours,
    gb.n_buckets AS group_bucket_count
  FROM hourly AS d
  INNER JOIN group_buckets AS gb
    ON gb.store_id = d.store_id
   AND gb.product_id = d.product_id
  LEFT JOIN hourly AS p
    ON p.store_id = d.store_id
   AND p.product_id = d.product_id
   AND p.bucket_ts >= TIMESTAMP_SUB(d.bucket_ts, INTERVAL 14 DAY)
   AND p.bucket_ts < d.bucket_ts
  GROUP BY d.store_id, d.product_id, d.bucket_ts, d.n_reviews, d.n_five_star, gb.n_buckets
)
SELECT
  @pipeline_run_id AS pipeline_run_id,
  store_id,
  product_id,
  bucket_ts,
  'hour' AS granularity,
  n_reviews,
  n_five_star,
  baseline_mean,
  baseline_stddev,
  CASE
    WHEN baseline_hours < 5 OR baseline_stddev IS NULL OR baseline_stddev = 0 THEN CAST(NULL AS FLOAT64)
    ELSE (n_reviews - baseline_mean) / baseline_stddev
  END AS z_score,
  CASE
    WHEN group_bucket_count < 5 THEN FALSE
    ELSE n_reviews >= 8 AND SAFE_DIVIDE(n_five_star, n_reviews) >= 0.9
  END AS is_burst
FROM scored;
