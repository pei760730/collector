/** 唯讀讀回 voc 表「參考池」(確認 sync-pool 寫入)。跑法:npx tsx scripts/read-refs.ts */
import { readFileSync } from "node:fs";
import { google } from "googleapis";

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
const res = await sheets.spreadsheets.values.get({
  spreadsheetId: "1V_CaTb4YgtsFP7HLrLK3QHrKCMr2gPCnU0Xe7y7Dse0",
  range: "'參考池'!A1:J",
});
const rows = res.data.values ?? [];
console.log("參考池總列數(含表頭):", rows.length);
for (const r of rows) console.log(JSON.stringify(r));
