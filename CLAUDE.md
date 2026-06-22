# CLAUDE.md — short-video-bot 協作規則

> 接手這個 repo(含 AI)先讀這份。short-video-bot = Telegram 短影音收集 bot,
> 取代舊 n8n 流程。貼「連結+備註」→ 解析→清理→判平台→抽 video ID→去重→**直接寫 voc 的 Google Sheet「參考池」分頁**。
> (2026-06-22:廢「暫存區」中間層 —— voc 已砍 sync-pool,bot 與 voc 同表同 SA,直寫參考池就是最終狀態。)

## 第一層:永久紅線(違反就停)

1. **機密永不進 git**:`TELEGRAM_BOT_TOKEN`、`service_account.json`、`.env`。有人提議 commit 立刻拒絕(`.gitignore` 已擋)。
2. **未經明確同意不 commit / push / 開 PR**。在 branch 做完、跑 `npm test` + `npm run typecheck`、先報告,等 yes。
3. **只改被要求的部分**,不順手改旁邊的 code/欄位。
4. **修 bug 前先想**:能不能用 schema/設定/純函式擋掉?n8n 的 regex 與邏輯要 1:1 保留,別憑印象重寫跑掉行為。
5. **不在 Sheet 裡的事實不能編造**;寫入後反向驗證(讀回確認),CLI 自報成功不算數。

## 第二層:資料地圖

| 找什麼 | 去哪 |
|---|---|
| 「參考池」欄位 / schema(SSOT) | `src/types.ts`:`RefRow` / `POOL_COLUMNS`(= voc `schema.REFS` 5 欄)+ `PLATFORM_CODE`(顯示名→小寫碼) |
| 去重 key 演算法(連結→key) | `src/pipeline/index.ts`:`dedupKey`(平台:影片id 優先,抽不到退連結路徑;對齊 voc `sync._dedup_key`) |
| 抽網址 + 備註 | `src/pipeline/parse.ts` |
| 清網址(追蹤參數/行動版/短網址) | `src/pipeline/cleanUrl.ts` |
| 判斷平台(domain 優先序) | `src/pipeline/detectPlatform.ts` |
| 抽 video ID(各平台 regex) | `src/pipeline/extractVideoId.ts` |
| pipeline 組合(parse→組草稿) | `src/pipeline/index.ts` |
| 去重 / 寫入 / 統計介面 | `src/storage/Storage.ts` |
| Google Sheets 實作 | `src/storage/googleSheets.ts` |
| 測試用記憶體 storage | `src/storage/memory.ts` |
| 收集流程 handler | `src/bot/handlers/collect.ts`(`runCollect`,不依賴 Telegraf) |
| `/stats` / `/pick` handler | `src/bot/handlers/{stats,pick}.ts`;`/pick` 打勾參考池 `src/storage/poolPick.ts` |
| 指令路由 / 錯誤通知 | `src/bot/router.ts` |
| 訊息模板 | `src/messages/templates.ts` |
| 設定 / 環境變數 | `src/config.ts`(範本 `.env.example`) |

## 第三層:技術不變式

- **pipeline 全純函式**:parse / cleanUrl / detectPlatform / extractVideoId 無副作用、無網路,I/O 隔在 storage + handler。改邏輯先補 / 改 `tests/`。
- **測 router(telegraf)的攔截點**:telegraf `handleUpdate` **每筆更新都 `new Telegram(...)`**(telegraf.js),所以 stub `bot.telegram.sendMessage` / `.callApi` 對 context 無效(ctx 拿的是新實例)。要攔回覆/避免真連線,改 stub `Telegram.prototype.callApi`(測完還原)。範例見 `tests/router.test.ts`。
- **時區固定 `Asia/Taipei`**(`src/utils/date.ts`)。參考池「加入日期」用 ISO `YYYY-MM-DD`(`todayIsoTaipei`,對齊 voc schema)。
- **寫入一律 RAW**(不用 USER_ENTERED),避免 video ID / 開頭 0 被吃成數字。
- **訊息純文字**,不用 MarkdownV2(舊版跳脫漏字會發送失敗)。
- **去重靠連結 key**(`dedupKey`):寫入參考池前讀現有「連結」欄,候選與既有列都用同一支推 key,重複就跳過。**全表比對、無時間窗**(參考池是 voc 永久池,不像舊暫存區會 prune)。同支影片不同形態(youtu.be/watch?v=/shorts)收斂同 key;抓不到影片id 的退連結路徑 key。
- **storage 只認 `Storage` 介面**:換來源新增實作即可,handlers 不動。
- **最小權限**:Google 只用 `spreadsheets` scope。
- **fail fast**:缺必要 env 啟動就丟錯,不帶半套設定跑。

## 第四層:環境

- 使用者 **Pei**([pei760730](https://github.com/pei760730)),回覆繁體中文、短句直接。
- 技術棧已定案:Node.js + TypeScript、telegraf、googleapis、dayjs、vitest。儲存 Google Sheets。
- **部署:GitHub Actions cron drain($0,預設)** —— `.github/workflows/collect.yml` 每小時跑 `npm run drain`(`src/drain.ts`:`getUpdates` 撈乾→`handleUpdate`→ack→結束)。Telegram 留更新 ~24h,間隔<24h 不漏;收訊息延遲最多 ~1h。**不要在本機 Docker/WSL2 跑常駐**:連 googleapis 帶 JWT 大封包會 `Premature close`(WSL2 MTU 丟大封包)。要「秒回」才用常駐 long polling(`src/index.ts`,`BOT_MODE=polling`),且部署到雲端 VM 而非本機 Docker。webhook 模式需 `WEBHOOK_DOMAIN`。
- 開發指令:`npm run dev`(tsx watch)、`npm test`、`npm run typecheck`、`npm run build`。

## 第五層:待確認(邊做邊修)

- `/stats` 顯示哪些數字 —— 現為預設版,**讀「參考池」**(總筆數+各平台+本週/本月+最近5筆)。注意:已挑走的素材會搬離參考池,故統計反映「目前池中未挑」的素材,不含已挑/已拍。
- `/move` 已退役(隨第二輪瘦身砍 STATUS 欄一起;`move.ts` 已刪)。改用 `/pick` 打勾流程,詳見第六層。
- 短網址展開(`EXPAND_SHORT_URLS`)預設關;要開再驗 redirect 行為。

## 第六層:與 voc 對接契約(改欄位前先讀!跨 repo)

bot 是上游:**直接寫** Google 表「**短影音進度N**」(`1V_CaTb…`,= voc 的 `VOC_SPREADSHEET_ID`)的「**參考池**」分頁。
2026-06-22 起廢「暫存區」中間層 —— voc 已砍 `sync.py` / `sync-pool`(暫存區→參考池 每日複製是純儀式,第一性原理刪除)。bot 與 voc 同一張表、同一把 SA,bot 直寫參考池就是最終狀態。

- **同一張表**:bot `GOOGLE_SHEET_ID` 必須 = voc `VOC_SPREADSHEET_ID`(`1V_CaTb…`)。憑證共用 voc 的 `service_account.json`(`voc-sheets@voc-499914`)。
- **參考池由 voc 擁有,bot 不自建/不改表頭**:voc `init-sheet` 建「參考池」。bot `GoogleSheetsStorage.ensureHeader` 只**驗表頭對齊**,缺分頁 / 表頭不齊一律 fail-fast(不替 voc 動表結構,避免錯欄寫入靜默毀 voc 的池)。
- **契約欄位 = voc `schema.REFS` 5 欄(改名要兩 repo 一起)**。bot append 用固定欄序硬塞,**欄名 + 順序**都要對上;由 `tests/contract.test.ts` 守(改欄名 → CI 紅):
  - `id`:bot 寫**留空**(voc `pick` 搬待拍時統一編 R 號)。
  - `平台`:**小寫碼**(`PLATFORM_CODE`:tiktok/youtube/facebook/instagram/threads/x/douyin/xiaohongshu;認不得 → `unknown`)。voc 全系統用小寫碼。
  - `連結`:乾淨連結 —— 「打開」+ 去重的唯一 key。
  - `挑`:checkbox,bot 寫**留空**(=還沒挑)。`/pick` 才打 `TRUE`(見下)。
  - `加入日期`:ISO `YYYY-MM-DD`(`todayIsoTaipei`;voc `normalize_date` 也吃 ISO)。
- **NOTE/VIDEO_ID/SENDER 不進參考池**(voc 設計如此,不是漏):參考池只存不可化約的 5 欄,梗/點子在 `voc pick` 時落地到「待拍.備註」。去重 key 寫入前由連結即時推導(`dedupKey`),不需存欄。
- **去重(寫入前,bot 端負責)**:`src/pipeline/index.ts` 的 `dedupKey` 對齊 voc 舊 `sync._dedup_key` —— 優先「平台:影片id」(用 bot `detectPlatform`+`extractVideoId`,讓 youtu.be/watch?v=/shorts 收斂),抽不到才退連結路徑(砍 query/fragment + 去尾斜線 + lower)。`collect` 寫入前讀現有「連結」欄、候選與既有列同支推 key 比對,重複跳過。**全表比對、無時間窗**(參考池永久池,不 prune)。
  - **範圍限制(已知,刻意)**:只比對**參考池**的「連結」欄,不比對 待拍/完成。被 `pick` 搬走的素材若再次分享,bot 會當新素材再收一筆(舊 `sync.py` 會連 待拍/完成 一起比)。換取 bot 不耦合 voc 全 schema;若日後重複太多,再在 bot 端擴比對範圍。
- **`/pick` 打勾(bot 不自己搬待拍)**:`/pick R####` 在「參考池」按 `id` 找列、把「**挑**」欄寫 `TRUE`,真正搬移交 `voc pick`(`voc pick --execute` 已在 voc 每日 cron)。
  - **為什麼不在 bot 搬**:「參考池→待拍」是 voc pick 的不變式重活(T 號跨待拍+完成取 max、ISO 日期、先 append 後 delete);bot 重做=脆弱第二真相。bot 只寫一格,單一真相留 voc。
  - **耦合點(改任一個要兩 repo 一起)**:欄名 `id`、`挑`(= voc `schema.PICK_COL`);打勾值寫 `TRUE`(voc `_is_checked` 認 `TRUE/✓/V/Y/1/X/是`)。bot 端在 `src/storage/poolPick.ts`。注意 `poolPick.ts`(寫「挑」格)與 `googleSheets.ts`(append 整列)**都碰參考池但各寫各的欄**,符合「同一欄只一邊寫」。
- **平台偵測器兩套、各自獨立**:bot `detectPlatform`(hostname)與 voc `parse_url`(regex)是兩份實作。bot 是參考池唯一寫入者 → 平台欄以 bot 判定為準(voc 不再 re-derive)。`contract.test.ts` 釘住 bot 8 個平台碼都落在 voc 認得的小寫碼集合。
- **改 voc 一律另開 voc session**,別從 bot 滑上游。
- 驗證腳本:`npx tsx scripts/verify-sheet.ts`(列分頁 + 印參考池表頭)、`scripts/read-refs.ts`(讀參考池)。
