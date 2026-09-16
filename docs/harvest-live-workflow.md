<!-- SPDX-License-Identifier: GPL-3.0-only -->
# HKTVmall harvest live workflow

Operator path: collect public HKTVmall reviews via the Bright Data Browser API, then feed the JSONL into the existing fixture pipeline.

A Bright Data page counts only after `parseHktvmallReviewPage` yields **new** `native_review_id` values. Empty snapshots do not increment `n_pages`. Pagination commit / settle / false-complete must not report `ok: true`.

ScrapingBee (`--transport scrapingbee`) remains the second option: paid, rarely used live. The CLI completeness gate **still applies**, but this workflow does not require a second live ScrapingBee run.

---

## 1. Environment

Set Bright Data Browser API credentials and the reviewer salt in `.env` or the shell:

```bash
# Do not append -country-xx to the username; the CLI adds -country-hk
export BRIGHTDATA_BROWSERAPI_USERNAME="your_brightdata_user"
export BRIGHTDATA_BROWSERAPI_PASSWORD="your_brightdata_password"

# Used later by crawl to HMAC reviewer ids (at least 16 characters)
export REVIEWER_ID_SALT="your_secret_salt_16chars_min"
```

---

## 2. Harvest

### (A) Dry-run (no CDP, no billing, no `--i-accept-tos`)

Validates URL shape (host `www.hktvmall.com` or `hktvmall.com`; pathname contains `/hktv/zh/`, `/s/{store}/`, `/p/{sku}/`). Dry-run **cannot** tell you the review count.

```bash
pnpm cli -- harvest \
  --marketplace hktvmall \
  --url "https://www.hktvmall.com/hktv/zh/main/Store-Name/s/S2090001/.../p/S2090001_S_4000412" \
  --dry-run
```

### (B) Live harvest

Default `--max-pages` **20 is a cost wall ≈ 200 reviews**, **not** “collect everything”. Read “N reviews” on the product page (or the live first page / probe) and set `--max-pages` ≥ `ceil(N/10)`. 536 reviews → at least 54; 80 is an acceptable safety margin. Browser API sessions cap at 60 minutes; 54 pages in one session is enough.

```bash
pnpm cli -- harvest \
  --marketplace hktvmall \
  --url "https://www.hktvmall.com/hktv/zh/main/Store-Name/s/S2090001/.../p/S2090001_S_4000412" \
  --i-accept-tos \
  --country HK \
  --max-pages 80 \
  --out data/harvested/20260908T120000Z-hktvmall.jsonl
```

Multiple products: repeat `--url <URL>` or pass `--url-file <path>`.

`--strict` only means any wrapper reject → exit 1 (empty output always fails). It does **not** control pagination completeness.

### Sidecar

Each `--out` has a sibling `*.manifest.json`. Required keys (may be `null`): `ok`, `failed_url`, counts, `stamp`, `stopped_reason`, `page_total`.

- **Feed `crawl` only sidecar `ok: true` JSONL.**
- If logs show `harvest_pagination_shortfall`: **do not** crawl `.partial`.
- `stopped_reason=max_pages` is the operator cost wall, **not** a shortfall. The artifact may still be `ok: true`, but the population is incomplete.

---

## 3. Into the detection pipeline

### (A) Crawl

```bash
pnpm cli -- crawl --adapter fixture --input data/harvested/20260908T120000Z-hktvmall.jsonl --dry-run
pnpm cli -- crawl --adapter fixture --input data/harvested/20260908T120000Z-hktvmall.jsonl
```

`crawl --adapter fixture` does **not** last-write-wins.

### (B) Load

`--continue-latest` only reads `pipeline_run_id` from `data/runs/latest`. `load` **still requires** `--ndjson`.

```bash
pnpm cli -- load \
  --ndjson data/batches/<crawl_batch_id>/reviews.ndjson \
  --continue-latest
```

### (C) Three-layer funnel

```bash
pnpm cli -- layer1 --continue-latest
pnpm cli -- layer2 --continue-latest
pnpm cli -- audit --continue-latest --concurrency 8
pnpm cli -- analyze --continue-latest
pnpm cli -- report --continue-latest --format markdown --out reports/
```

---

## 4. Harvesting the same SKU more than once

JSONL can be merged with the existing `mergeByNativeReviewId` last-write-wins helper, then crawled. v1 has **no** `harvest --merge` and **no** `--start-page`. Each harvest still starts at review page 1, so three runs of `--max-pages 20` do **not** become 54 pages and do **not** cover pages 21–54. To collect 536 reviews, use a single `--max-pages >= 54`.

Legitimate uses of segmented merge: combining several SKUs into one file, or re-running to overwrite the same `native_review_id` set. Combined files must go through `mergeByNativeReviewId` (unit / one-shot script, or the load-layer BigQuery `MERGE`).

---

## Notes

1. **`--i-accept-tos`**: required for live. The operator evaluates the target ToS / robots / local law.
2. **URL**: public Traditional Chinese path `/hktv/zh/` only.
3. **Session**: each product URL gets its own CDP session, closed when done (idle 5 min, max 60 min).
4. **Output atomicity**: while running, write `.partial` plus sidecar; rename to `--out` only after every URL succeeds. Failure does not unlink an existing `--out`.
