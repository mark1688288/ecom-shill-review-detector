# ecom-shill-review-detector

廣東話電商鱔稿／水軍好評偵測 CLI。個人研究／分析工具：**統計 ≠ 法律事實**。

Licensed under [GNU GPL-3.0-only](LICENSE). New source files carry `SPDX-License-Identifier: GPL-3.0-only`.

v1 是 **fixture-first**：用 JSONL 重放評論。不實作 live marketplace crawler，也不對商店做公開指控。

完整架構見 [`docs/design.md`](docs/design.md)。

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
```

Help 必須寫成 `pnpm cli -- --help`（pnpm 把第一個 `--` 當 script 參數分隔）。`seeds` 仍 **exit 2**（`not implemented`）。

`layer2` 用 BigQuery remote model（ENDPOINT 來自 `EMBEDDING_MODEL`，預設 `text-multilingual-embedding-002`）embed 種子同 stage1，再以 cosine distance ≤ config 門檻寫入 stage2。`CREATE MODEL` 對 multilingual-002 在該區 404 時必須停止，禁止默默改 `text-embedding-004`。CI **不**執行 `ML.GENERATE_EMBEDDING`。

`audit` 會對 stage2 打 Gemini Flash（JSON Schema、`p-limit` 8）。CI 用 mock 計 call-count；live Vertex 唔喺 merge gate。`layer2` / `audit` / `analyze` / `report` **禁止新建** `pipeline_runs`（必須 `--pipeline-run-id` 或 `--continue-latest`）。`asia-east1` 沒有 Gemini `generateContent`；BQ / embedding 維持 `GCP_LOCATION`，live audit 設 `GEMINI_LOCATION=global`（或 `asia-southeast1` / `asia-northeast1`）。

`analyze` 按 `pipeline_run_id` DELETE+INSERT 單店水分、burst、跨店 template/embedding 碰撞與 edge list。`report` 讀分析表寫 markdown/JSON（頂部「統計 ≠ 法律事實」）；`--dot` 另寫 Graphviz。CI 不斷言漏斗 35%/5%。`shill_score>=75` 同 cosine 0.28 一樣是可調預設，不是 SLA。

## Layer 2 種子句（`v0_hypothesis`）

[`sql/seeds/pr_seed_phrases_v0.sql`](sql/seeds/pr_seed_phrases_v0.sql) 的 7 句是 **hypothesis, replaceable**，不是已驗證的「官方 7 大經典」。之後以新 `seed_version` 或 `ecom-shill seeds upsert`（Phase 5）替換。

Layer 2 SQL 在 [`sql/layer2/`](sql/layer2/)（embed seeds / embed reviews / cosine distance ≤ config 門檻）。CI **不**執行 `ML.GENERATE_EMBEDDING`（需 Vertex remote model）。

## GCP（可選）

[`scripts/bootstrap-gcp.sh`](scripts/bootstrap-gcp.sh) **只 echo 步驟**（enable APIs、dataset、staging bucket、connection、最小 IAM、CREATE MODEL）。真正建 connection / remote model 是 sandbox checklist，不是 merge gate。BQ / embedding 鎖定 `asia-east1`。`CREATE MODEL` 對 `text-multilingual-embedding-002` 404 就停，不要改 004。Gemini Flash 該區 404 時設 `GEMINI_LOCATION`，不要改 `GCP_LOCATION`。

## 安全

- 不要把真實商店 cookie、token、或未授權 API endpoint 提交進 git。
- `REVIEWER_ID_SALT` 不得進 BigQuery、不得進 git。
