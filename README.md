# collector

Personal automation utility — internal use only, provided as-is with no support.

Telegram 收集 bot(原 short-video-bot,2026-07-15 三併一改名)。一套殼跑四個 target(**voc / tbvoc / of / ofgay**),每個 target 一隻獨立 Telegram bot、寫一張獨立 Google Sheet:貼「連結+備註」→ 解析 → 清理 → 判平台 → 抽 video ID → 去重 → 直寫 Sheet。

## 架構

- **抽取/清理/分群 SSOT**:[`@pei760730/collector-core`](https://github.com/pei760730/collector-core)(git tag pin,四 target 共用同一版本 lockstep;`core-bump.yml` 每日 cron 自動開 bump PR)。
- **voc / tbvoc**:共用殼 pipeline,`src/targets.ts` 參數化(tbvoc 原 clip-collector,已併入、舊 repo 已 archive)。
- **of / ofgay**:同一支 vendored 獨立引擎 `src/engines/of/`(原 feed-collector,已併入、舊 repo 已 archive),`src/drain.ts` 依 `targets.ts` 的 `OF_ENGINE_TARGETS`(`isOfTarget`)委派,契約與 voc/tbvoc 刻意不同 scope。ofgay = 同引擎跑 gay 市場(換 bot、換表),程式碼零差異。
- **`src/shared/`**:殼與 of 引擎共用的安全/正確性不變式(白名單去識別、config 防灌池 fail-fast、drain at-least-once 迴圈、append 冪等護欄(查詢失敗不盲打)、Telegram 暫態重試、公開 log 錯誤摘要/遮 token),各存一份會漂移的東西收成單一來源;兩邊正當的 model 差異仍留各自實作。

## 部署

GitHub Actions cron drain(`.github/workflows/collect.yml`):matrix 併行跑四個 target,把 Telegram 囤積的更新撈乾、寫入後結束,無常駐機。secrets 採 per-target 前綴(voc 無前綴、`TBVOC_`、`OF_`、`OFGAY_`),缺任一支紅燈、五支全空視為未接線跳過(目前四個 target **全部已接線並在收**;2026-09-12 實測每個 job 都印出 `drain 完成:已處理 N 筆更新`)。`.github/workflows/heartbeat.yml` 每 6h 看守:collect 太久沒跑就自動補觸發,快逼近 Telegram 24h 保留期才通知。

**怎麼讀每個 target 的 run 結果**(run 首頁 Step Summary 會先給一行白話標籤,再附 log 的收尾行「已處理 N 筆更新(寫入、重複、失敗未寫入、其他)」。收尾行的「寫入」只計確認寫入成功的;若中止時有一筆已落表才丟錯,以表上實際列數為準):

- ✅ 正常收尾:每一筆都有去處。
- 🔴 有訊息被確認收走但沒寫進表(run 紅燈,結束碼 3):這幾筆 Telegram 不會再給。要重新操作:連結請分享者重貼,夯度(tbvoc)請重按按鈕。這種情況佇列其實已排空,重跑領不回來。
- 🔴 寫入失敗中止(結束碼 2):沒確認的那段下一輪會自動重領,去重會擋住已寫入的,不會變兩列。
- 🔴 有更新已處理但沒回條(結束碼 1):最後一次向 Telegram 確認失敗,所以「其中 M 筆尚未被 Telegram 確認」。這 M 筆下一輪會重領,去重會擋;它們可能是已寫入、重複、沒寫入或其他,看收尾行分項,不一定都已寫進表。
- 🔴 沒跑(結束碼 1):一筆都沒領到。
- 多批時兩件事可同時出現:收尾行(與標籤)會同時寫「M 筆尚未確認、下輪重領」以及「K 筆失敗未寫入、已被確認收走、不會重領,需重新操作」。這時結束碼仍是 1 或 2(不是 3),請務必看標籤與收尾行,不要只看紅燈。

## 開發

```
npm run dev        # 本機 long polling(僅開發用)
npm test           # vitest
npm run typecheck
npm run build
```

協作規則、資料契約與不變式見 `CLAUDE.md` / `AGENTS.md`。
