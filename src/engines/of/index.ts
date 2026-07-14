/**
 * 進入點 —— 載設定、接 storage、起 bot。
 * 正式部署建議走 GitHub Actions cron drain($0,見 src/drain.ts)。
 */
import { loadConfig } from "./config.js";
import { GoogleSheetsStorage } from "./storage/googleSheets.js";
import { MemoryStorage } from "./storage/memory.js";
import type { Storage } from "./storage/Storage.js";
import { createBot } from "./bot/router.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // 注:DATE 欄一律 Asia/Taipei,由 utils/date.ts 的 dayjs.tz 寫死,不靠 process.env.TZ。

  let storage: Storage;
  if (config.storage === "memory") {
    storage = new MemoryStorage();
    logger.warn("STORAGE=memory 乾跑模式:不寫真表,資料只存記憶體");
  } else {
    if (!config.google) throw new Error("sheets 模式缺 Google 設定");
    storage = new GoogleSheetsStorage({
      credentials: config.google.credentials,
      sheetId: config.google.sheetId,
      sheetName: config.google.stagingSheetName,
      prodSheetName: config.google.prodSheetName,
    });
  }

  await storage.ensureHeader(); // 啟動先確保表頭(冪等;memory 版 noop)

  const bot = createBot(config, storage);

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  // long polling —— 本機開發用(生產走 Actions cron drain);webhook 線已於 2026-07-03 解散
  void bot.launch(() => logger.info("bot 已啟動(long polling)"));
}

main().catch((err) => {
  logger.error("啟動失敗", err);
  process.exit(1);
});
