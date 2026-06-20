/**
 * 一次性遷移:把線上「暫存區」從舊 14 欄 → 新 8 欄(第一性原理瘦身)。
 *
 * 安全順序:先把新表頭+資料寫進 A–H(critical 先落地),再清掉殘留舊欄(I 以後)。
 * 萬一清除失敗,A–H 已正確、bot 只讀到 H,殘留欄無害。寫完反向讀回驗證。
 *
 * 跑法:
 *   乾跑(只看計畫,不寫):  npx tsx scripts/migrate-staging-cols.ts
 *   真的執行:              npx tsx scripts/migrate-staging-cols.ts --execute
 */
import { readFileSync } from "node:fs";
import { google } from "googleapis";
import { STAGING_COLUMNS } from "../src/types.js";

const SHEET_ID = "1V_CaTb4YgtsFP7HLrLK3QHrKCMr2gPCnU0Xe7y7Dse0"; // voc 主表「短影音進度N」
const TAB = "暫存區";
const EXECUTE = process.argv.includes("--execute");

const sa = JSON.parse(readFileSync("./service_account.json", "utf-8")) as {
  client_email: string;
  private_key: string;
};
const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const range = (a1: string) => `'${TAB}'!${a1}`;

const newHeader = STAGING_COLUMNS as string[];

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: range("A1:ZZ"),
});
const values = (res.data.values ?? []).map((r) => r.map((c) => String(c ?? "")));
if (values.length === 0) {
  console.log("暫存區是空的(連表頭都沒有),不需遷移。");
  process.exit(0);
}

const oldHeader = values[0]!.map((h) => h.trim());
console.log("舊表頭:", oldHeader.join(" | "));
console.log("新表頭:", newHeader.join(" | "));

if (oldHeader.length === newHeader.length && newHeader.every((c, i) => oldHeader[i] === c)) {
  console.log("✅ 已經是新 8 欄,無需遷移。");
  process.exit(0);
}

// 用舊表頭名 → index,按新欄名挑值(缺的補空)。
const idx: Record<string, number> = {};
oldHeader.forEach((h, i) => (idx[h] = i));
const dataRows = values.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
const newRows = dataRows.map((r) => newHeader.map((col) => (idx[col] != null ? (r[idx[col]!] ?? "") : "")));

console.log(`\n資料列 ${dataRows.length} 筆,遷移後預覽(新 8 欄):`);
for (const nr of newRows) console.log("  ", nr.map((v) => (v.length > 24 ? v.slice(0, 24) + "…" : v)).join(" | "));

if (!EXECUTE) {
  console.log("\n[乾跑] 沒有 --execute,不寫。確認上面無誤後加 --execute 再跑。");
  process.exit(0);
}

// 1) 先寫新表頭+資料到 A1(覆蓋 A–H);critical data 先落地。
await sheets.spreadsheets.values.update({
  spreadsheetId: SHEET_ID,
  range: range("A1"),
  valueInputOption: "RAW",
  requestBody: { values: [newHeader, ...newRows] },
});
console.log("✅ 已寫入新表頭 + 資料(A–H)。");

// 2) 再清掉殘留舊欄(I 以後)。失敗也無害(bot 只讀到 H)。
await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: range("I1:ZZ1000") });
console.log("✅ 已清除殘留舊欄(I 以後)。");

// 3) 反向讀回驗證。
const back = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: range("A1:H") });
const bv = (back.data.values ?? []).map((r) => r.map((c) => String(c ?? "")));
console.log("\n讀回驗證:");
console.log("  表頭:", (bv[0] ?? []).join(" | "));
for (const r of bv.slice(1)) console.log("  ", r.join(" | "));
console.log(`\n完成。表頭 ${bv[0]?.length ?? 0} 欄,資料 ${Math.max(bv.length - 1, 0)} 筆。`);
