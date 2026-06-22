/**
 * 一次性對接驗證(唯讀):用 voc 的 service account 連 voc 表,
 * 列出分頁、確認「參考池」在、印參考池表頭(bot 直寫的目標)—— 不建分頁、不寫入。
 * 跑法:npx tsx scripts/verify-sheet.ts
 */
import { readFileSync } from "node:fs";
import { google } from "googleapis";

const SHEET_ID = "1V_CaTb4YgtsFP7HLrLK3QHrKCMr2gPCnU0Xe7y7Dse0";
const POOL = "參考池";

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
console.log("參考池存在:", tabs.includes(POOL), tabs.includes(POOL) ? "" : "(請先 voc init-sheet 建表)");

if (tabs.includes(POOL)) {
  const hdr = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${POOL}'!A1:E1`,
  });
  console.log("參考池表頭:", (hdr.data.values?.[0] ?? []).join(" / "), "(期望 id / 平台 / 連結 / 挑 / 加入日期)");
}
