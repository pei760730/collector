/** 讀回 voc 表「暫存區」現有資料列(唯讀,確認 bot 寫入)。跑法:npx tsx scripts/read-staging.ts */
import { readFileSync } from "node:fs";
import { GoogleSheetsStorage } from "../src/storage/googleSheets.js";

const sa = JSON.parse(readFileSync("./service_account.json", "utf-8")) as {
  client_email: string;
  private_key: string;
};
const storage = new GoogleSheetsStorage({
  credentials: { client_email: sa.client_email, private_key: sa.private_key.replace(/\\n/g, "\n") },
  sheetId: "1V_CaTb4YgtsFP7HLrLK3QHrKCMr2gPCnU0Xe7y7Dse0",
  sheetName: "暫存區",
});

const rows = await storage.readAll();
console.log("暫存區資料列數:", rows.length);
for (const r of rows) {
  console.log(
    `[${r.PLATFORM}] vid=${r.VIDEO_ID} | url=${r.CLEAN_URL} | note=${r.NOTE} | by=${r.SENDER} | ${r.DATE} | conf=${r.PLATFORM_CONFIDENCE}`,
  );
}
