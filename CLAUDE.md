# CLAUDE.md — short-video-bot 協作規則

> 接手這個 repo(含 AI)先讀這份。short-video-bot = Telegram 短影音收集 bot,
> 取代舊 n8n 流程。貼「連結+備註」→ 解析→清理→判平台→抽 video ID→去重→寫 Google Sheet「暫存區」。

## 第一層:永久紅線(違反就停)

1. **機密永不進 git**:`TELEGRAM_BOT_TOKEN`、`service_account.json`、`.env`。有人提議 commit 立刻拒絕(`.gitignore` 已擋)。
2. **未經明確同意不 commit / push / 開 PR**。在 branch 做完、跑 `npm test` + `npm run typecheck`、先報告,等 yes。
3. **只改被要求的部分**,不順手改旁邊的 code/欄位。
4. **修 bug 前先想**:能不能用 schema/設定/純函式擋掉?n8n 的 regex 與邏輯要 1:1 保留,別憑印象重寫跑掉行為。
5. **不在 Sheet 裡的事實不能編造**;寫入後反向驗證(讀回確認),CLI 自報成功不算數。

## 第二層:資料地圖

| 找什麼 | 去哪 |
|---|---|
| 「暫存區」欄位 / schema(SSOT) | `src/types.ts`:`StagingRow` / `STAGING_COLUMNS` |
| 抽網址 + 備註 | `src/pipeline/parse.ts` |
| 清網址(追蹤參數/行動版/短網址) | `src/pipeline/cleanUrl.ts` |
| 判斷平台(domain 優先序) | `src/pipeline/detectPlatform.ts` |
| 抽 video ID(各平台 regex) | `src/pipeline/extractVideoId.ts` |
| pipeline 組合(parse→組草稿) | `src/pipeline/index.ts` |
| 去重 / 寫入 / 統計介面 | `src/storage/Storage.ts` |
| Google Sheets 實作 | `src/storage/googleSheets.ts` |
| 測試用記憶體 storage | `src/storage/memory.ts` |
| 收集流程 handler | `src/bot/handlers/collect.ts`(`runCollect`,不依賴 Telegraf) |
| `/stats` `/move` | `src/bot/handlers/{stats,move}.ts` |
| 指令路由 / 錯誤通知 | `src/bot/router.ts` |
| 訊息模板 | `src/messages/templates.ts` |
| 設定 / 環境變數 | `src/config.ts`(範本 `.env.example`) |

## 第三層:技術不變式

- **pipeline 全純函式**:parse / cleanUrl / detectPlatform / extractVideoId 無副作用、無網路,I/O 隔在 storage + handler。改邏輯先補 / 改 `tests/`。
- **時區固定 `Asia/Taipei`**(`src/utils/date.ts`),DATE 欄格式 `YYYY/M/D`(不補零,沿用 n8n moment 行為)。
- **寫入一律 RAW**(不用 USER_ENTERED),避免 video ID / 開頭 0 被吃成數字。
- **訊息純文字**,不用 MarkdownV2(舊版跳脫漏字會發送失敗)。
- **去重靠 `VIDEO_ID`**(去多餘空白),且只看 `DEDUPE_PERIOD_DAYS` 天內;`unknown_*` 視為唯一不去重。
- **storage 只認 `Storage` 介面**:換來源新增實作即可,handlers 不動。
- **最小權限**:Google 只用 `spreadsheets` scope。
- **fail fast**:缺必要 env 啟動就丟錯,不帶半套設定跑。

## 第四層:環境

- 使用者 **Pei**([pei760730](https://github.com/pei760730)),回覆繁體中文、短句直接。
- 技術棧已定案:Node.js + TypeScript、telegraf、googleapis、dayjs、vitest。儲存 Google Sheets。
- **部署:GitHub Actions cron drain($0,預設)** —— `.github/workflows/collect.yml` 每小時跑 `npm run drain`(`src/drain.ts`:`getUpdates` 撈乾→`handleUpdate`→ack→結束)。Telegram 留更新 ~24h,間隔<24h 不漏;收訊息延遲最多 ~1h。**不要在本機 Docker/WSL2 跑常駐**:連 googleapis 帶 JWT 大封包會 `Premature close`(WSL2 MTU 丟大封包)。要「秒回」才用常駐 long polling(`src/index.ts`,`BOT_MODE=polling`),且部署到雲端 VM 而非本機 Docker。webhook 模式需 `WEBHOOK_DOMAIN`。
- 開發指令:`npm run dev`(tsx watch)、`npm test`、`npm run typecheck`、`npm run build`。

## 第五層:待確認(邊做邊修)

- `/stats` 顯示哪些數字 —— 現為預設版(總筆數+各平台+本週/本月+狀態+最近5筆)。
- `/move` 行為 —— 現為「改 STATUS active→moved、不搬表」。要加「正式區」分頁時改 `handlers/move.ts` + storage。
- 短網址展開(`EXPAND_SHORT_URLS`)預設關;要開再驗 redirect 行為。

## 第六層:與 voc 對接契約(改欄位前先讀!跨 repo)

bot 是上游:寫 Google 表「**短影音進度N**」(`1V_CaTb…`,= voc 的 `VOC_SPREADSHEET_ID`)的「**暫存區**」分頁。
voc 的 `src/voc/sync.py`(指令 `voc sync-pool`)從**同一張表**讀「暫存區」→ 映射進「參考池」。bot 不重造輪子,voc 直接消費 bot 解析好的欄位。

- **同一張表**:bot `GOOGLE_SHEET_ID` 必須 = voc `VOC_SPREADSHEET_ID`(`1V_CaTb…`)。憑證共用 voc 的 `service_account.json`(`voc-sheets@voc-499914`)。
- **bot 自建暫存區分頁**:voc `init-sheet` 不建「暫存區」,由 bot `GoogleSheetsStorage.ensureHeader` 啟動時自建(addSheet + 表頭)。
- **契約欄位(以 voc `sync.py` 當前讀的為準,2026-06-20)**:voc 精簡後**只按表頭名讀這 4 欄**,改這幾欄名要兩 repo 一起改:
  - `PLATFORM` → 平台(voc `_PLATFORM_MAP` 轉小寫;7 個顯示名都對得上)
  - `VIDEO_REF` → 後備連結(CLEAN_URL 空時用)
  - `CLEAN_URL` → 連結(**voc 去重 key + 「打開」用**)
  - `DATE` → 加入日期(voc `normalize_date` 轉 ISO)
- **bot 仍寫滿 14 欄沒問題**:voc 參考池現在 5 欄 = `id/平台/連結/挑/加入日期`(voc PR #7「砍狀態欄、改 checkbox 挑片」後;舊「狀態」欄已砍 —— 在池=還沒挑,勾「挑」→ `voc pick` 整列搬待拍、本列消失,所以不需狀態)。`VIDEO_ID/SENDER/NOTE` 等原始細節 voc **不再複製**,留在暫存區當原始底料(voc 設計如此,不是漏)。梗/點子改在 `pick` 時落地到「待拍.備註」。
- **Threads 兩端都支援(2026-06-20 對齊確認)**:voc `normalize._PLATFORM_RULES` 有 `threads.(net|com)` + `/post/(id)` 抽取,`parse_url` 認得;voc `_norm_platform("Threads")` 走 `.lower()` fallback → 參考池平台欄落 `threads`,與 voc 自身慣例一致。(脆弱點:voc `sync._PLATFORM_MAP` 沒明列 threads,靠 fallback 剛好對上;要硬化在 voc 補一行,屬可選、現在不壞。)
- **`/pick` 打勾(bot 不自己搬待拍,2026-06-20)**:`/pick R####` 在「參考池」按 `id` 找列、把「**挑**」欄寫 `TRUE`,真正的搬移交回 `voc pick`。
  - **為什麼不在 bot 搬**:「參考池→待拍」是 voc pick 的不變式重活(T 號跨待拍+完成取 max、ISO 日期、先 append 後 delete、欄名漂移會炸);bot 重做=脆弱第二真相。bot 只寫一格,單一真相留 voc。
  - **耦合點(改任一個要兩 repo 一起)**:欄名 `id`、`挑`(= voc `schema.PICK_COL`);打勾值寫 `TRUE`(voc `_is_checked` 認 `TRUE/✓/V/Y/1/X/是`)。bot 端在 `src/storage/poolPick.ts`。
  - **待補(voc 端,另開 voc session)**:把 `voc pick --execute` 排進 voc 每日 cron,打勾才會自動搬;否則要手動跑 `voc pick`。
- **去重**:voc `_dedup_key` 優先用 `parse_url` 抽「平台:影片id」當 key(抽不到才退乾淨連結路徑:砍 query/fragment + 去尾斜線 + lower)。冪等,重跑 sync 不重複。bot 端去重(暫存區用 VIDEO_ID)與 voc 端(參考池用連結 key)各自獨立,前綴格式(`threads_`/`threads:`)不需一致。
- **✅ 原 youtube `watch?v=` 去重 edge 已修(voc PR #5 merged,2026-06-20)**:`_dedup_key` 改抽「平台:影片id」,`watch?v=AAA` 與 `watch?v=BBB` 不再砍 query 後塌成重複;同支影片的 `youtu.be/`、`shorts/`、`watch?v=` 反而收斂同 key。**改 voc 一律另開 voc session**,別從 bot 滑上游。
- 驗證腳本:`npx tsx scripts/verify-sheet.ts`(列分頁)、`scripts/read-staging.ts`(讀暫存區)、`scripts/read-refs.ts`(讀參考池)。
