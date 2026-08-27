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

子命令已登記；Phase 0 尚未實作業務邏輯，執行 `crawl` / `load` / … / `seeds` 會 **exit 2** 並印 `not implemented`。

Help 必須寫成 `pnpm cli -- --help`（pnpm 把第一個 `--` 當 script 參數分隔）。

## GCP（可選）

Phase 0 的 [`scripts/bootstrap-gcp.sh`](scripts/bootstrap-gcp.sh) **只 echo 步驟**（enable BigQuery / Vertex / Storage / IAM、dataset、connection、最小 IAM）。真正建 connection 是後續 sandbox checklist，不是 merge gate。區域鎖定 `asia-east1`。

## 安全

- 不要把真實商店 cookie、token、或未授權 API endpoint 提交進 git。
- `REVIEWER_ID_SALT` 不得進 BigQuery、不得進 git。
