# voc 契約檔(vendored)

從上游私有 repo `voc` 的 `contracts/` 複製過來,給 `tests/contract.test.ts` 跑 conformance。

- **SSoT 在 voc**：`schema.json` / `dedup_vectors.json` 由 voc `src/voc/schema.py` + `normalize.py` codegen 產出(voc `scripts/gen_schema_json.py`)。**不要在這裡手改**。
- **為何 vendor**：voc 是 private repo、svb 是 public,CI 無法跨 repo 自動抓,故複製一份進來給測試讀。

## 更新(voc 契約改動後重新 vendor)

voc 端改了參考池欄位 / 平台碼 / dedup 規則 → 重生 voc 契約 → 複製過來:

```bash
cp <voc-repo>/contracts/{schema.json,dedup_vectors.json} contracts/voc/
```

`contract.test.ts` 會驗 bot 與這份契約是否還對得上;對不上就 CI 紅(逼你同步)。

## TODO — drift-guard 自動化

voc CI 改 `contracts/` 時自動對各 collector 開「vendor 更新 PR」。卡在跨 repo token(voc private),待解(設計 §4 fan-out)。在那之前靠這份 README 手動同步 + conformance 紅燈擋漂移。
