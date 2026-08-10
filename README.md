# collector

Personal automation utility — internal use only, provided as-is with no support.

Telegram 收集 bot(原 short-video-bot,2026-07-15 三併一改名)。一套殼跑四個 target(**voc / tbvoc / of / ofgay**),每個 target 一隻獨立 Telegram bot、寫一張獨立 Google Sheet:貼「連結+備註」→ 解析 → 清理 → 判平台 → 抽 video ID → 去重 → 直寫 Sheet。

## 架構

- **抽取/清理/分群 SSOT**:[`@pei760730/collector-core`](https://github.com/pei760730/collector-core)(git tag pin,四 target 共用同一版本 lockstep;`core-bump.yml` 每日 cron 自動開 bump PR)。
- **voc / tbvoc**:共用殼 pipeline,`src/targets.ts` 參數化(tbvoc 原 clip-collector,已併入、舊 repo 已 archive)。
- **of / ofgay**:同一支 vendored 獨立引擎 `src/engines/of/`(原 feed-collector,已併入、舊 repo 已 archive),`src/drain.ts` 依 `targets.ts` 的 `OF_ENGINE_TARGETS`(`isOfTarget`)委派,契約與 voc/tbvoc 刻意不同 scope。ofgay = 同引擎跑 gay 市場(換 bot、換表),程式碼零差異。
- **`src/shared/`**:殼與 of 引擎共用的安全/正確性不變式(白名單去識別、config 防灌池 fail-fast、drain at-least-once 迴圈、append 冪等護欄、Telegram 暫態重試),各存一份會漂移的東西收成單一來源;兩邊正當的 model 差異仍留各自實作。

## 部署

GitHub Actions cron drain(`.github/workflows/collect.yml`):matrix 併行跑四個 target,把 Telegram 囤積的更新撈乾、寫入後結束,無常駐機。secrets 採 per-target 前綴(voc 無前綴、`TBVOC_`、`OF_`、`OFGAY_`),缺任一支紅燈、五支全空視為未接線跳過(ofgay 現況即為此:休眠待接線)。

## 開發

```
npm run dev        # 本機 long polling(僅開發用)
npm test           # vitest
npm run typecheck
npm run build
```

協作規則、資料契約與不變式見 `CLAUDE.md` / `AGENTS.md`。
