/**
 * 唯讀 dry-run:報告「暫存區」在某去重窗下會被 prune 掉幾列(不刪任何東西)。
 * 跑法:npx tsx scripts/prune-dry-run.ts [days]   (days 預設 14,= DEDUPE_PERIOD_DAYS 新預設)
 *
 * dryRun=true → pruneOlderThan 只讀、回「會刪幾筆」,在真刪前看 blast radius 用。
 */
import { readFileSync } from "node:fs";
import { GoogleSheetsStorage } from "../src/storage/googleSheets.js";
import { ageInDays } from "../src/utils/date.js";

const days = Number(process.argv[2] ?? 14);
if (!Number.isFinite(days) || days < 0) {
  console.error(`days 參數無效:${process.argv[2]}`);
  process.exit(1);
}

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
const broken = rows.filter((r) => !Number.isFinite(ageInDays(r.DATE))).length;
const willDelete = await storage.pruneOlderThan(days, { dryRun: true });

console.log(`暫存區總列數:${rows.length}`);
console.log(`DATE 解析不出(Infinity,一律保留):${broken}`);
console.log(`窗 = ${days} 天 → 會刪(年齡有限且 >${days}天):${willDelete}`);
console.log(`刪後剩:${rows.length - willDelete}`);
console.log("\n(這是 dry-run,沒有刪任何列。)");
