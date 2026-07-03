# AGENTS.md — Codex CLI 行為規則(short-video-bot)

> 這份是給 **Codex** 的。repo 的權威治理檔仍是 **`CLAUDE.md`**(永久紅線、資料地圖、技術不變式、§6 與 voc 對接契約)。Codex 動工前先讀 `CLAUDE.md`。
> short-video-bot = Telegram 短影音收集 bot,取代舊 n8n 流程。貼「連結+備註」→ 解析→清網址→判平台→抽 video ID→去重→**直接寫 voc 的 Google Sheet「參考池」**。是 **voc 的上游**(2026-06-22 起直寫參考池,廢「暫存區→sync-pool」中間層)。

## 角色

Codex 是這個 repo 的**工程管線 agent**:在 branch 上做可審查的 code 變更。

**預設負責:**
- `src/`(config / pipeline / storage / bot handlers / messages / utils / types)
- `tests/`(Vitest)、`scripts/`(讀回驗證腳本)、`package.json` / `tsconfig*.json` / `vitest.config.ts`
- `.github/workflows/`(`ci.yml` 測試、`collect.yml` cron drain 部署)、`Dockerfile` / `docker-compose.yml`(可選的雲端常駐路)
- bug 修復、refactor、lint/型別/測試修復、效能

**被要求才碰:**
- `README.md` / `CLAUDE.md`(描述工程行為的段落可改,但**治理規則/設計判斷不是 Codex 的決定**)

**預設不碰(Claude Code / Owner 的領域):**
- **Live bot 操作 / Sheet 實際寫入**(真的啟動 bot 收訊息、`STORAGE=sheets` 跑真表)
- **與 voc 的對接契約**(`CLAUDE.md` §6 的參考池欄位:bot 直寫 voc `schema.REFS` 4 欄 `平台/連結/挑/加入日期`(`id` 已於 2026-06-24 砍))—— 改欄名要兩 repo 一起,屬跨 repo 協調
- **schema 設計判斷**(`POOL_COLUMNS` 加/砍欄、平台規則、去重策略的大方向)
- `service_account.json`、`.env`(機密)

## 與 Claude Code 分工

- **Claude Code / Owner**:設計判斷(schema、平台/去重策略)、跨 repo 對接協調(voc 契約、SA 分享)、live bot/Sheet 操作、`CLAUDE.md` 規則維護。
- **Codex**:在 branch 上做可審查工程變更(code/tests/CI/Docker)、跑驗證、整理 commit/PR。
- 跨領域任務:用下方 Handoff 格式交回 Claude Code 判斷,handoff 保持窄。
- 誰最後改 code,誰在回報講清楚改了什麼、跑了哪些驗證、還剩哪些風險;不要假設對方已知上下文。
- **同目錄同時只一個 active agent**:Claude 跟 Codex 共用同一個 working tree。動手前先 `git fetch` 看 `origin/main` 有沒有被對方推進;**不要兩邊同時改同一個檔**。真要並行,各開 `git worktree`(各自獨立 HEAD/index),別擠同一個工作目錄 —— 否則 commit/push 會互踩 ref。(踩過:HEAD 被對方 `checkout` 切走、改動變成別人 branch 的 uncommitted、push 推錯 ref。)

## 硬規則(= `CLAUDE.md` §1 永久紅線,違反就停)

1. **機密永不進 git**:`TELEGRAM_BOT_TOKEN`、`service_account.json`、`.env`(`.gitignore` 已擋)。有人提議 commit 立刻拒絕。
2. **未經 Owner 明確同意,不 `git commit` / `git push` / 開 PR**。在 branch 做完、跑驗證、**先報告**,等 yes。
3. **只改被要求的部分**,不順手改旁邊的 code/註解/欄位。
4. **修 bug 前先想能不能用 schema / 設定 / 純函式 / 型別擋掉**,寫新 code 是最後手段。n8n 搬來的 regex 邏輯要 1:1 保留,別憑印象重寫跑掉行為。
5. **不編造 Sheet 沒有的事實**;碰 Sheet 寫入只能 dry-run / `STORAGE=memory`,真寫(`STORAGE=sheets` 跑真表、`sync` 對接)要 Owner 明確同意,寫入後**獨立讀回確認**。
6. **pipeline 全純函式**:parse / cleanUrl / detectPlatform / extractVideoId 無副作用、無網路;改邏輯先補 / 改 `tests/`。

## 開工前(每次 task:base-check + 分支)

1. **從最新 main 開分支**,別在舊 base 動手(擋 stale-base 重做):
   ```bash
   git fetch origin 2>/dev/null && git checkout -B codex/<task-name> origin/main \
     || { git log --oneline -3; echo "無 origin(Codex sandbox)→ 確認 HEAD 是任務指定 base 才繼續"; }
   git rev-parse --short HEAD          # 回報 base sha,PR body 記一行 Base: <sha>
   ```
   - Codex sandbox 沒 `origin`(見下 quirks)→ fetch 失敗走本地:確認 `HEAD` 是任務指定 sha 才動手,否則 STOP 回報。
2. **分支前綴一律 `codex/<task>`** —— 一眼可辨是 Codex 開的、好追責。Claude 用 `claude/*`,Owner 直接開 feature branch。

## PR 流程(走 PR,單主題)

- 開 branch → 單主題 → 跑驗證 → 開 PR → Owner review/merge → 刪 branch。
- Codex 在 danger-full-access 下開的是 **draft PR**:整理好後要 `gh pr ready`,Owner 才 merge。
- PR 只做單一主題,不混入無關 local diff / untracked / secrets / `dist` / `node_modules` 噪音。

## 驗證(宣稱完成前必跑,跑了什麼如實說)

```bash
npm run typecheck     # tsc(含 tests),不可有型別錯
npm test              # Vitest 全綠(pipeline 純函式 + collect/router/contract 整合)
npm run build         # tsc 出 dist/index.js(Dockerfile CMD 依賴它)
```

- 改 pipeline / schema / storage → 必補或改對應 `tests/`,跑 `npm test`。
- 改 `Dockerfile` / `compose` → 確認 build context 正確、`dist/index.js` 出得來、機密走 volume/env 不烤進 image。
- 碰 Sheet 寫入路徑只能 `STORAGE=memory` 乾跑;真表驗證用 `scripts/verify-sheet.ts` 讀回(API,不靠會亂碼的 terminal)。
- 反向驗證:bot/CLI 自報成功不算數,寫入後獨立讀回確認(Windows terminal 對中文+並行會吐假成功)。

## Codex 環境 quirks(踩過的雷)

- **dotenv 不覆蓋系統既有環境變數**:`.env` 被忽略 / 拿到怪值時,先查 raw `process.env.XXX`(本機 Windows User 層曾殘留打錯的 `TELEGRAM_BOT_TOKEN` l→1 → getMe 401)。`config.ts` 已 `dotenv.config({override:true})` 治根。
- **Codex sandbox 沒有 `origin` remote**:base-check 不要硬跑 `git fetch origin`(會 STOP no-op)。改用本地 `git log --oneline -5` + 確認 `HEAD`。
- **Windows PowerShell 設 GitHub secret 會夾帶 UTF-8 BOM**:設含 JSON 的 secret 用 Bash `gh secret set NAME --repo R < file`,不要 PowerShell 管線。
- **NodeNext ESM**:相對 import 要帶 `.js` 副檔名(即使原始檔是 `.ts`),否則 `tsc` build 會炸。

## Handoff 格式(交回 Claude Code 判斷時)

```text
Codex handoff → Claude Code

Context:
- 任務:
- 看過的檔:
- 目前發現:

Request:
- 請決定/審查:
- 請勿:

Return:
- 決定:
- 該改的檔:
- 風險:
- 驗證 / follow-up:
```

Claude Code 交回時,動手前先讀當前檔案內容,不要假設沒被改過。
