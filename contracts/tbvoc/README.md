# 上游 VOC 契約檔(vendored)

從上游私有 VOC repo 的 `contracts/` 複製過來,給 `tests/contract.test.ts` 跑 conformance。

- **SSoT 在上游 VOC 引擎**:`schema.json` 由上游 `src/tbvoc/schema.py` + `normalize.py` codegen 產出(`scripts/gen_schema_json.py`)。**不要在這裡手改**。
- **為何 vendor**:上游是 private repo、clip-collector 是 public,CI 無法跨 repo 自動抓,故複製一份進來給測試讀。

## 更新(上游契約改動後重新 vendor)

上游端改了參考池欄位 / 平台碼 / dedup 規則 → 重生契約 → 複製過來:

```bash
cp <上游 repo>/contracts/schema.json contracts/tbvoc/schema.json
```

`contract.test.ts` 會驗 ClipBot 與這份契約是否還對得上;對不上就 CI 紅(逼你同步)。

## dedup 契約另走 collector-core

去重分群契約(`dedup_vectors.json`)**不在這裡 vendor** —— 由 `@pei760730/collector-core` 隨包發布。
守門在 core repo 端的 `tests/dedupConformance.test.ts`;clip 端的鏡像測試已於 PR #30(2026-07-04)移除(自己測自己,無守門價值)。
改去重規則 → 先改 core canonical(過 core 的 tests + dedupConformance)→ bump core tag。

## TODO — drift-guard 自動化

上游 CI 改 `contracts/` 時自動對 clip 開「vendor 更新 PR」。卡在跨 repo token(上游 private),待解。在那之前靠這份 README 手動同步 + conformance 紅燈擋漂移。
