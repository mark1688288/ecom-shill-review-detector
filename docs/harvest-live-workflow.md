<!-- SPDX-License-Identifier: GPL-3.0-only -->
# HKTVmall harvest live workflow

操作者用 Bright Data Browser API 收公開 HKTVmall 評論，再餵入既有 fixture 管線。契約見 [`docs/design.md`](design.md)、[`docs/design-bright-data-scrapping-pro-browser-hktvmall.md`](design-bright-data-scrapping-pro-browser-hktvmall.md)。分頁 commit／settle／假完整不得 `ok: true` 以 [`docs/fix-harvest-bright-data-hktvmall.md`](fix-harvest-bright-data-hktvmall.md) 為準。

Bright Data 翻頁必須等 `parseHktvmallReviewPage` 解析出**新的** `native_review_id` 才算一頁；空 snapshot 不計入 `n_pages`。

ScrapingBee（`--transport scrapingbee`）仍係第 2 選擇：收費、live 罕用。CLI completeness gate **一樣套用**，但本 workflow 唔要求再跑一轉 live ScrapingBee。

---

## 1. 前置環境變數

在 `.env` 或終端機設定 Bright Data Browser API 憑證與 salt：

```bash
# Username 後綴不要手動加 -country-xx；CLI 會自動附加 -country-hk
export BRIGHTDATA_BROWSERAPI_USERNAME="your_brightdata_user"
export BRIGHTDATA_BROWSERAPI_PASSWORD="your_brightdata_password"

# 後續 crawl 計算 reviewer HMAC（至少 16 字元）
export REVIEWER_ID_SALT="your_secret_salt_16chars_min"
```

---

## 2. Harvest

### (A) Dry-run（不連 CDP、不計費、不需 `--i-accept-tos`）

檢查 URL 格式（host `www.hktvmall.com` 或 `hktvmall.com`、pathname 含 `/hktv/zh/`、`/s/{store}/`、`/p/{sku}/`）。Dry-run **無法**得知「N則評論」。

```bash
pnpm cli -- harvest \
  --marketplace hktvmall \
  --url "https://www.hktvmall.com/hktv/zh/main/Store-Name/s/S2090001/.../p/S2090001_S_4000412" \
  --dry-run
```

### (B) Live harvest

`--max-pages` 預設 **20 = 成本牆 ≈ 200 則**，**不是**「完整收」。先睇商品頁「N則評論」（或 live 第一頁／probe），設 `--max-pages` ≥ `ceil(N/10)`。536 則 → 至少 54；80 當安全邊際可接受。Browser API session 上限 60 min，單次 54 頁夠用。

```bash
pnpm cli -- harvest \
  --marketplace hktvmall \
  --url "https://www.hktvmall.com/hktv/zh/main/Store-Name/s/S2090001/.../p/S2090001_S_4000412" \
  --i-accept-tos \
  --country HK \
  --max-pages 80 \
  --out data/harvested/20260908T120000Z-hktvmall.jsonl
```

多個商品：重複 `--url <URL>` 或 `--url-file <path>`。

`--strict` 只表示任一 wrapper reject → exit 1（空產物無論如何失敗）。它**不**控制分頁完整性。

### Sidecar

每個 `--out` 旁邊有 `*.manifest.json`。必填鍵（可 `null`）：`ok`、`failed_url`、計數、`stamp`、`stopped_reason`、`page_total`。

- **只把 sidecar `ok: true` 的 JSONL 餵給 `crawl`。**
- log 出現 `harvest_pagination_shortfall`：**不要** crawl `.partial`。
- `stopped_reason=max_pages` 係操作者成本牆，**不是** shortfall；產物仍可 `ok: true`，但未收齊母體。

---

## 3. 接入偵測管線

### (A) Crawl

```bash
pnpm cli -- crawl --adapter fixture --input data/harvested/20260908T120000Z-hktvmall.jsonl --dry-run
pnpm cli -- crawl --adapter fixture --input data/harvested/20260908T120000Z-hktvmall.jsonl
```

`crawl --adapter fixture` **不**做 last-write-wins。

### (B) Load

`--continue-latest` 只讀 `data/runs/latest` 的 `pipeline_run_id`。`load` **仍然要** `--ndjson`。

```bash
pnpm cli -- load \
  --ndjson data/batches/<crawl_batch_id>/reviews.ndjson \
  --continue-latest
```

### (C) 三層漏斗

```bash
pnpm cli -- layer1 --continue-latest
pnpm cli -- layer2 --continue-latest
pnpm cli -- audit --continue-latest --concurrency 8
pnpm cli -- analyze --continue-latest
pnpm cli -- report --continue-latest --format markdown --out reports/
```

---

## 4. 同一 SKU 多次 harvest

JSONL 可以用既有 `mergeByNativeReviewId` last-write-wins 合成一份再 crawl。v1 **沒有** `harvest --merge`、**沒有** `--start-page`。每次 harvest 仍從評論頁 1 開始，故三次 `--max-pages 20` **不會**變成 54 頁、**拼不到**第 21–54 頁。要收齊 536 則，單次 `--max-pages >= 54`。

分段 merge 的合法用途：多 SKU 合成一份，或重跑覆蓋同一批 `native_review_id`。合成必須先經過 `mergeByNativeReviewId`（unit／一次性 script，或 load 層 BQ `MERGE`）。

---

## 注意事項

1. **`--i-accept-tos`**：live 必須帶此 flag；操作者自行評估目標 ToS／robots／當地法律。
2. **URL**：只支援公開繁體路徑 `/hktv/zh/`。
3. **Session**：每個商品 URL 獨立 CDP session，結束後 close（idle 5 min、max 60 min）。
4. **輸出原子性**：執行中寫 `.partial` 與 sidecar；全部 URL 成功才 rename 成 `--out`。失敗不 unlink 既有 `--out`。
