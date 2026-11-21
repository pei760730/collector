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

**怎麼讀每個 target 的 run 結果**(run 首頁 Step Summary 會先給一行白話標籤,再附 log 的收尾行「已處理 N 筆更新(寫入、重複、失敗未寫入、其他)」)。

收尾行的分項只講**這一輪程式親眼看到的事**:

- 寫入:這一輪送出寫入並收到成功回應的筆數。若中止時有一筆已落表才丟錯,它不計入,以表上實際列數為準。
- 重複:這一輪去重查到表上已有同一則而略過的筆數。
- 失敗未寫入:這一輪處理這則時,在**寫入前**就出了非暫態錯誤(例如讀去重資料失敗),所以沒有對它送出寫入。**這不代表表上沒有**:例如上一輪其實已經寫進去、只是結果不明,這一輪去重讀取又失敗,就會落在這一項。
- 其他:沒有連結的訊息、指令、未授權來源、夯度按鈕等。

收尾行用肯定句的,都是這一輪親眼看到的:送出寫入並收到成功回應、哪些向 Telegram 的確認收到成功回應(所以才寫「已被確認收走、不會重領」)、哪一步出了什麼類別的錯、因中止而沒送出確認。表上現在有什麼、確認結果不明時 Telegram 伺服器端的狀態、下一輪領不領得到、該不該重貼,都是推論,只用「若…」「可能」或「請核對」的條件句。

- ✅ 正常收尾(`drain 完成:`):最後一次向 Telegram 確認成功,這一輪的每一則更新都歸進上面四項之一。
- 🔴 有訊息這一輪沒有寫入就被確認收走(run 紅燈,結束碼 3):這幾筆 Telegram 已確認、不會再給,重跑也領不回來。收尾行寫「其中 K 筆這一輪沒有寫入(寫入前出錯)、已被確認收走、不會重領;表上可能已有同一則(例如上一輪已寫入),請先核對,沒有再重貼連結」。請先到表上核對,沒有再請分享者重貼連結。
- 🔴 寫入失敗中止(結束碼 2):迴圈停下後就沒再向 Telegram 送確認,所以沒確認的那段(收尾行寫「其中 M 筆因中止沒送出確認,尚未確認:下一輪若成功領取、且更新還在 Telegram 保留期內(最長 24 小時),才會重領,去重通常會擋」)。這是預測不是保證:下一輪可能沒跑到、領取失敗,或更新已經過了保留期(Telegram 官方只說最長保留 24 小時)。重領時去重通常會擋住已寫入的,不會變兩列。**例外**:of/ofgay 抓不到影片 ID 的 `raw_` 更新(刻意每貼必留一列),如果跨台北午夜才被重領,會多一列,要人工刪。
- 🔴 有更新已處理但確認結果不明(結束碼 1):最後一次向 Telegram 確認沒拿到成功回應(可能是網路斷在回應途中,Telegram 端其實已經收下確認)。收尾行寫「其中 M 筆的確認結果不明」:若其實未確認,下一輪若成功領取、且更新還在 Telegram 保留期內(最長 24 小時)才會重領(去重通常會擋,同上例外);若其實已確認,就不會再領。這 M 筆可能是已寫入、重複、這一輪沒有寫入或其他,看收尾行分項。若這 M 筆裡有這一輪沒有寫入的,收尾行另寫「這 M 筆裡有 U 筆這一輪沒有寫入(寫入前出錯):若其實已被確認收走就不會重領,請核對表上有沒有,沒有再重貼連結」。
- 🔴 沒跑(結束碼 1):一筆都沒領到。
- 已知限制:夯度按鈕(tbvoc)的寫入結果不在這份回條的分項內(成功或失敗都算「其他」,失敗也不會讓 run 變成結束碼 3),以表為準。
- 多批時收尾行(與標籤)可同時有幾句各自獨立的話,K、M、U 是實際筆數:有先前批次這一輪沒寫入就被收走的,寫上面 K 那句;有未確認的,依上面兩種寫法(中止寫「沒送出確認」、中斷寫「確認結果不明」)。這些話可能同時出現,也可能只出現其中一句(例如中止時失敗的那筆剛好是新一批的第一筆,就只有 K 那句)。同時出現時結束碼仍是 1 或 2(不是 3),請務必看標籤與收尾行,不要只看紅燈。

## 開發

```
npm run dev        # 本機 long polling(僅開發用)
npm test           # vitest
npm run typecheck
npm run build
```

協作規則、資料契約與不變式見 `CLAUDE.md` / `AGENTS.md`。
