/**
 * 對接驗證(唯讀):用 voc 的 service account 連 voc 表,確認「參考池」在、
 * 且表頭與 bot 的 POOL_COLUMNS(= voc schema.REFS)**完全對上**,不符就 exit 1。
 * 期望欄從 POOL_COLUMNS 推導(不寫死),所以改契約不會讓這支過時。
 * 跑法:npx tsx scripts/verify-sheet.ts   (需 ./service_account.json + GOOGLE_SHEET_ID 或預設表)
 *
 * 註:正式的跨 repo 契約守衛是 drain 每次跑的 ensureHeader(對 live 表斷言,不符拒寫);
 * 這支是同款檢查的手動唯讀版,方便人工複查。
 */
import { readFileSync } from "node:fs";
import { google } from "googleapis";
import { colLetter } from "@pei760730/collector-core";
import { POOL_COLUMNS } from "../src/types.js";

const SHEET_ID = process.env.GOOGLE_SHEET_ID ?? "<SHEET_ID>";
const POOL = "參考池";
const expected = POOL_COLUMNS as string[];

// colLetter 已由 collector-core export(sheets/headerMap),不再手寫副本。
const LAST_COL = colLetter(expected.length - 1);

const sa = JSON.parse(readFileSync("./service_account.json", "utf-8")) as {
  client_email: string;
  private_key: string;
};
const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key.replace(/\\n/g, "\n"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

const meta = await sheets.spreadsheets.get({
  spreadsheetId: SHEET_ID,
  fields: "properties.title,sheets.properties.title",
});
const tabs = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? "");
console.log("表名:", meta.data.properties?.title);
console.log("現有分頁:", tabs.join(" / "));

if (!tabs.includes(POOL)) {
  console.error(`✗ 找不到「${POOL}」分頁(請先 voc init-sheet 建表)。`);
  process.exit(1);
}

const hdr = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: `'${POOL}'!A1:${LAST_COL}1`,
});
const header = (hdr.data.values?.[0] ?? []).map((c) => String(c ?? ""));
const aligned = header.length === expected.length && expected.every((c, i) => header[i] === c);
console.log("參考池表頭:", header.join(" / "));
console.log("期望(POOL_COLUMNS):", expected.join(" / "));
if (!aligned) {
  console.error("✗ 表頭與 POOL_COLUMNS 不一致(跨 repo 契約漂移?對齊 voc schema.REFS)。");
  process.exit(1);
}
console.log("✓ 表頭對齊。");
