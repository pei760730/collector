# short-video-bot

Telegram 短影音收集 bot —— 取代原本跑在 n8n 上的流程,改成獨立、可自架、可版本控管的 Node.js + TypeScript 服務。功能與 n8n workflow 等價,並修掉舊版已知問題。

在 Telegram 貼「**連結 + 備註**」,bot 會:解析 → 清理網址 → 判斷平台 → 抽 video ID → 去重 → 寫進 Google Sheet「暫存區」→ 回報。

## 收集 pipeline

```
訊息文字
  → parse        抽第一個網址 + 備註 + 提交者
  → cleanUrl     去追蹤參數、行動版轉桌面版、短網址偵測、補 https
  → detectPlatform  依 hostname 判斷(8 平台,認不得 fallback Instagram)
  → extractVideoId  帶平台前綴的唯一 ID(tiktok_/ig_/yt_/xhs_;抓不到 unknown_<ts>)
  → 去重         N 天內同 VIDEO_ID 視為重複(DEDUPE_PERIOD_DAYS)
  → 重複:回提醒不寫入 / 不重複:append 進暫存區 → 回成功
```

每個 pipeline 步驟都是純函式,好測試(`tests/`)。

## 支援平台

| 平台 | Icon | Video ID |
|------|------|----------|
| TikTok | 🎵 | `tiktok_<id>` |
| YouTube | 📺 | `yt_<id>`(watch / youtu.be / shorts) |
| Facebook | 📘 | 無抽取規則 → `unknown_<ts>` |
| Instagram | 📸 | `ig_<code>`(p / reel) |
| Threads | 🧵 | `threads_<id>`(post) |
| X (Twitter) | 🐦 | 無抽取規則 → `unknown_<ts>` |
| 抖音 | 🎶 | 無抽取規則 → `unknown_<ts>` |
| 小紅書 | 📕 | `xhs_<id>`(explore) |

## 指令

| 指令 | 行為 |
|------|------|
| 一般訊息(含網址) | 走完整收集 pipeline |
| 無網址 / 格式錯誤 | 回格式錯誤提示 + 範例 |
| `/stats` | 總筆數 + 各平台 + 本週/本月新增 + 狀態分布 + 最近 5 筆 |
| `/move [VIDEO_ID]` | 把 active 標成 moved(預設不搬表,日後可擴正式區分頁) |

> `/stats` 與 `/move` 是「邊做邊修」的預設版,handler 介面已留好。

## 安裝 / 開發

```bash
npm install
cp .env.example .env      # 填 TELEGRAM_BOT_TOKEN 與 Google 憑證
npm run dev               # tsx watch,long polling
npm test                  # vitest(42 個測試)
npm run typecheck         # tsc(含 tests)
npm run build && npm start
```

## 部署(GitHub Actions cron drain,$0,預設)

正式部署**不需要常駐機器**。`.github/workflows/collect.yml` 每小時跑一次 `npm run drain`:把 Telegram 這 24h 囤的更新一次撈乾→處理→寫暫存區→結束。Telegram 保留未領更新約 24h,間隔 < 24h 就不漏訊息;public repo 的 Actions 免費額度無上限。

- 設 3 個 GitHub Secrets:`TELEGRAM_BOT_TOKEN`、`GOOGLE_SERVICE_ACCOUNT_JSON`、`GOOGLE_SHEET_ID`。
- 手動補跑:Actions → collect → Run workflow。
- **取捨**:收訊息延遲最多約 1 小時(下個整點才入庫+回覆)。

### (可選)常駐 polling — 要「秒回」才用

不想等整點、要即時回覆,才需要常駐 long polling(`src/index.ts`)。本機 Docker Desktop/WSL2 連 googleapis 大封包會 `Premature close`(見 `CLAUDE.md`),所以常駐要跑就**部署到雲端 VM / 容器host**,別在本機 Docker 跑:

```bash
cp .env.example .env          # 填好變數
docker compose up -d --build  # BOT_MODE=polling
docker compose logs -f
```

要走 webhook 設 `BOT_MODE=webhook` + `WEBHOOK_DOMAIN`,並在 compose 打開對外埠。

## 設定(.env)

| 變數 | 說明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | BotFather token |
| `GOOGLE_SERVICE_ACCOUNT_JSON` / `_BASE64` / `_FILE` | service account 憑證(三選一) |
| `GOOGLE_SHEET_ID` | 試算表 ID |
| `STAGING_SHEET_NAME` | 暫存區分頁名(預設「暫存區」) |
| `ADMIN_CHAT_ID` / `ERROR_CHAT_ID` | 通知 / 錯誤回報 chat |
| `DEDUPE_PERIOD_DAYS` | 去重時間窗(預設 180) |
| `EXPAND_SHORT_URLS` | 是否自動展開短網址(預設 false) |
| `BOT_MODE` | `polling`(預設)或 `webhook` |

**機密一律走 env,不進版控**(`.gitignore` 已擋 `.env` 與 `service_account.json`)。

## 與 voc 對接

bot 是上游:寫 Google 表「短影音進度N」的「暫存區」分頁。下游 [voc](https://github.com/pei760730/voc) 的 `voc sync-pool` 從同一張表讀「暫存區」→ 映射進「參考池」,再走 pick→待拍→完成。

- bot `GOOGLE_SHEET_ID` 要等於 voc 的 `VOC_SPREADSHEET_ID`,憑證共用同一把 service account。
- voc 精簡後只按表頭名讀 `PLATFORM / VIDEO_REF / CLEAN_URL / DATE` 4 欄(改這幾欄名要兩 repo 一起改);其餘細節留在暫存區當底料。
- 契約現狀與殘留去重 edge 見 `CLAUDE.md` 第六層。

## 設計原則

- pipeline 全純函式,I/O(去重 / 寫入)隔在 storage 與 handler。
- 儲存包成 `Storage` 介面,Google Sheets 只是其中一個實作(測試用 `MemoryStorage`)。
- 寫入 RAW(避免 video ID / 開頭 0 被當數字)。
- 訊息一律純文字,不用 MarkdownV2(舊版跳脫漏字釀發送失敗)。
- 失敗回明確錯誤 + 通知 error chat,不靜默吞掉。

## 改自 n8n 版的修正

1. 去重 lookup value 去掉多餘空白
2. 格式錯誤訊息改純文字(舊 MarkdownV2 未跳脫會發送失敗)
3. `dedupe_period_days` 真正實作(時間窗去重)
4. 欄位命名統一成一份 schema(`src/types.ts`)
5. SENDER 用真實提交者(舊版寫死 'Pei')
6. 用清楚條件流程取代 n8n 脆弱的 Merge / Is Duplicate 分支
