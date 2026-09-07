# ecom-shill-review-detector

廣東話電商鱔稿／水軍好評偵測 CLI。個人研究／分析工具：**統計 ≠ 法律事實**。

Licensed under [GNU GPL-3.0-only](LICENSE). New source files carry `SPDX-License-Identifier: GPL-3.0-only`.

v1 是 **fixture-first**：用 JSONL 重放評論。不實作 live marketplace crawler，也不對商店做公開指控。

完整架構見 [`docs/design.md`](docs/design.md)。HKTVmall 公開評論擷取（`ecom-shill harvest`）見 [`docs/design-bright-data-scrapping-pro-browser-hktvmall.md`](docs/design-bright-data-scrapping-pro-browser-hktvmall.md)（預設 Bright Data Browser API）同 [`docs/design-scrapingbee-hktvmall-reviews.md`](docs/design-scrapingbee-hktvmall-reviews.md)（`--transport scrapingbee`）。

## 需求

- Node.js 22 LTS（`>=22`）
- pnpm 9+

## 安裝

```bash
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install
cp .env.example .env
# 設定 REVIEWER_ID_SALT（至少 16 字元）。禁止空字串。
```

`crawl --dry-run` 與 unit test **不**需要 `GCP_*`。`load` / Layer 2+ 才懶載入 GCP。

## CI 級指令

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm cli -- --help
pnpm cli -- crawl --adapter fixture --input fixtures/reviews/cantonese-mix.jsonl --dry-run
```

Help 必須寫成 `pnpm cli -- --help`（pnpm 把第一個 `--` 當 script 參數分隔）。`seeds` 仍 **exit 2**（`not implemented`）。

CI **只**保證 TypeScript goldens、mock audit call-count、同 fixture `crawl --dry-run`。CI **不**連 GCP、**不**執行 `ML.GENERATE_EMBEDDING`、**不**驗證 SQL 語意，亦 **不斷言** 漏斗 35%/5%。

`layer2` 用 BigQuery remote model（ENDPOINT 來自 `EMBEDDING_MODEL`，預設 `text-multilingual-embedding-002`）embed 種子同 stage1，再以 cosine distance ≤ config 門檻寫入 stage2。`CREATE MODEL` 對 multilingual-002 在該區 404 時必須停止，禁止默默改 `text-embedding-004`。

`audit` 會對 stage2 打 Gemini Flash（JSON Schema、`p-limit` 8）。CI 用 mock 計 call-count；live Vertex 唔喺 merge gate。`layer2` / `audit` / `analyze` / `report` **禁止新建** `pipeline_runs`（必須 `--pipeline-run-id` 或 `--continue-latest`）。`asia-east1` 沒有 Gemini `generateContent`；BQ / embedding 維持 `GCP_LOCATION`，live audit 設 `GEMINI_LOCATION=global`（或 `asia-southeast1` / `asia-northeast1`）。

`analyze` 按 `pipeline_run_id` DELETE+INSERT 單店水分、burst、跨店 template/embedding 碰撞、edge list 同 `funnel_stats`。`report` 讀分析表寫 markdown/JSON（頂部「統計 ≠ 法律事實」；含 L1/L2/L3 ASCII 分數分佈直方圖）；`--dot` 另寫 Graphviz。`shill_score>=75` 同 cosine 0.28 一樣是可調預設，不是 SLA。漏斗百分比只寫 `funnel_stats` 同 JSON log；`pct_stage2_of_raw > 0.15` 或 `< 0.01` 會 warn，唔會令 CLI 失敗。BQ job 之後會查 `region-${GCP_LOCATION}.INFORMATION_SCHEMA.JOBS_BY_PROJECT` 並 log `bq_job_bytes`（禁止把區域寫死成 `asia-east1`）。

## Fixture 管線 walkthrough

v1 **只跑 fixture**。`crawl --dry-run` 同 unit test **不**需要 `GCP_*`。下面 sandbox 段先要 `scripts/bq-apply.sh` 同 `.env`（見「GCP（可選）」）。

```bash
# GCP-free（CI 亦跑呢步）
pnpm cli -- crawl --adapter fixture --input fixtures/reviews/cantonese-mix.jsonl --dry-run

# Sandbox（需要 ADC + BQ dataset + staging bucket）
set -a && source .env && set +a

pnpm cli -- crawl --adapter fixture --input fixtures/reviews/cantonese-mix.jsonl
pnpm cli -- load --ndjson data/batches/<crawl_batch_id>/reviews.ndjson --continue-latest
pnpm cli -- layer1 --continue-latest
pnpm cli -- layer2 --continue-latest
# live audit：asia-east1 無 generateContent 時設 GEMINI_LOCATION=global，唔好改 GCP_LOCATION
pnpm cli -- audit --continue-latest
pnpm cli -- analyze --continue-latest
pnpm cli -- report --continue-latest --format markdown --dot
```

`data/runs/latest` 會記住 `pipeline_run_id`。重跑同一 run 時 `layer1` / `layer2` / `analyze` 會先 DELETE 該 run 再 INSERT。`audit --skip-existing`（預設）會 copy-forward 同分同 model／prompt 嘅舊分數。

## Harvest（操作者明示；CI 唔跑 live）

`ecom-shill harvest` 喺公開 HKTVmall `/hktv/zh/` 商品頁撳「評論」、翻頁，寫 `FixtureReviewRaw` JSONL。之後仍然走 `crawl --adapter fixture --input <jsonl>`。`harvest` **唔**建立 `pipeline_runs`，**唔**走 `addRunFlags`。

預設 `--transport brightdata`（Bright Data Browser API）。`--transport scrapingbee` 改走 ScrapingBee HTML API（每評論頁一次 GET；**唔**用 Playwright）。設計見 [`docs/design-bright-data-scrapping-pro-browser-hktvmall.md`](docs/design-bright-data-scrapping-pro-browser-hktvmall.md) 同 [`docs/design-scrapingbee-hktvmall-reviews.md`](docs/design-scrapingbee-hktvmall-reviews.md)。

`--dry-run` 只驗證 URL 同印 `plan_*`：**唔**連 CDP／HTML API、唔要 creds、唔要 `--i-accept-tos`、唔寫 `--out`。真正 scrape 先要 `--i-accept-tos`。`brightdata` 要 `BRIGHTDATA_BROWSERAPI_USERNAME` / `BRIGHTDATA_BROWSERAPI_PASSWORD`；`scrapingbee` 只要非 `YOUR_API_KEY` 嘅 `SCRAPINGBEE_API_KEY`（唔要 Bright Data creds）。

```bash
pnpm cli -- harvest --dry-run --url https://www.hktvmall.com/hktv/zh/main/Store/s/S2090001/cat/p/S2090001_S_4000412
pnpm cli -- harvest --transport scrapingbee --dry-run --url <public-product-url>

pnpm cli -- harvest --url <public-product-url> --i-accept-tos --out data/harvested/batch.jsonl
pnpm cli -- harvest --transport scrapingbee --url <public-product-url> --i-accept-tos --out data/harvested/batch.jsonl
pnpm cli -- crawl --adapter fixture --input data/harvested/batch.jsonl --dry-run
```

只把 sidecar `ok: true` 嘅 `--out` JSONL 餵給 crawl；**唔好** crawl `.partial`。Harvest JSONL 含 `reviewer_id_raw`，唔好 commit（`data/` 已 gitignore）。

Live 測試（本機 opt-in；CI 永不設呢啲變數；測試檔唔 hardcode 商店 URL）。兩條閘獨立：Bright Data 讀 `HARVEST_LIVE=1`；ScrapingBee 讀 `SCRAPINGBEE_LIVE=1`，**唔**讀 `HARVEST_LIVE`。

```bash
HARVEST_LIVE=1 HARVEST_LIVE_URL=https://www.hktvmall.com/... pnpm test
SCRAPINGBEE_LIVE=1 HARVEST_LIVE_URL=https://www.hktvmall.com/... pnpm test
```

`HARVEST_LIVE_URL` 由操作者填。缺 URL／creds 時 skip，唔 fail。`SCRAPINGBEE_API_KEY=YOUR_API_KEY` 當缺席。`--no-optional` 唔支援 typecheck／Bright Data live harvest（需要 `playwright-core` optionalDependency：`pnpm install`）；ScrapingBee 路徑零 Playwright。

## Layer 2 種子句（`v0_hypothesis`）

[`sql/seeds/pr_seed_phrases_v0.sql`](sql/seeds/pr_seed_phrases_v0.sql) 的 7 句是 **hypothesis, replaceable**，不是已驗證的「官方 7 大經典」。之後以新 `seed_version` 或 `ecom-shill seeds upsert`（Phase 5）替換。

Layer 2 SQL 在 [`sql/layer2/`](sql/layer2/)（embed seeds / embed reviews / cosine distance ≤ config 門檻）。CI **不**執行 `ML.GENERATE_EMBEDDING`（需 Vertex remote model）。

## GCP（可選）

[`scripts/bootstrap-gcp.sh`](scripts/bootstrap-gcp.sh) **只 echo 步驟**（enable APIs、dataset、staging bucket、connection、最小 IAM、CREATE MODEL）。真正建 connection / remote model 是 sandbox checklist，不是 merge gate。BQ / embedding 鎖定 `asia-east1`。`CREATE MODEL` 對 `text-multilingual-embedding-002` 404 就停，不要改 004。Gemini Flash 該區 404 時設 `GEMINI_LOCATION`，不要改 `GCP_LOCATION`。

## 安全

- 不要把真實商店 cookie、token、或未授權 API endpoint 提交進 git。
- `REVIEWER_ID_SALT` 不得進 BigQuery、不得進 git。
