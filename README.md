# collector

Personal automation utility — internal use only, provided as-is with no support.

Telegram 收集 bot(原 short-video-bot,2026-07-15 三併一改名)。一套殼跑三個 target(**voc / tbvoc / of**),每個 target 一隻獨立 Telegram bot、寫一張獨立 Google Sheet:貼「連結+備註」→ 解析 → 清理 → 判平台 → 抽 video ID → 去重 → 直寫 Sheet。

## 架構

- **抽取/清理/分群 SSOT**:[`@pei760730/collector-core`](https://github.com/pei760730/collector-core)(git tag pin,三 target 共用同一版本 lockstep;`core-bump.yml` 每日 cron 自動開 bump PR)。
- **voc / tbvoc**:共用殼 pipeline,`src/targets.ts` 參數化(tbvoc 原 clip-collector,已併入、舊 repo 已 archive)。
- **of**:vendored 獨立引擎 `src/engines/of/`(原 feed-collector,已併入、舊 repo 已 archive),`src/drain.ts` 依 `COLLECTOR_TARGET=of` 委派,契約與 voc/tbvoc 刻意不同 scope。

## 部署

GitHub Actions cron drain(`.github/workflows/collect.yml`):matrix 併行跑三個 target,把 Telegram 囤積的更新撈乾、寫入後結束,無常駐機。secrets 採 per-target 前綴(voc 無前綴、`TBVOC_`、`OF_`),缺任一支紅燈、五支全空視為未接線跳過。

## 開發

```
npm run dev        # 本機 long polling(僅開發用)
npm test           # vitest
npm run typecheck
npm run build
```

協作規則、資料契約與不變式見 `CLAUDE.md` / `AGENTS.md`。
