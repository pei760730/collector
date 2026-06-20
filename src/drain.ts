/**
 * drain —— 一次性把 Telegram 這 24h 內囤的更新撈乾、處理、寫表,然後結束。
 *
 * 取代常駐 long polling:給 GitHub Actions cron 週期呼叫,$0、不需常駐機器,
 * 也避開 Docker-on-WSL2 對 googleapis 大封包的 Premature close(Actions 跑 ubuntu 直連)。
 *
 * 為什麼「定時撈一次」不漏訊息:Telegram 會保留未領取的更新約 24h。只要 cron 間隔 < 24h,
 * 每次把待領更新領乾即可。用 getUpdates(offset) 逐批領 + ack(下一次帶新 offset 即確認上一批);
 * 處理走和常駐完全相同的 `bot.handleUpdate`,行為一致、不重寫邏輯。
 *
 * 失敗語意:中途崩潰沒 ack → 下次 cron 重領,storage 去重(VIDEO_ID)擋掉重複。
 * at-least-once,寧可重複看得到也不要遺失(對齊 voc move_row 的同款取捨)。
 */
import { createBot } from "./bot/router.js";
import { loadConfig } from "./config.js";
import { GoogleSheetsStorage } from "./storage/googleSheets.js";
import { MemoryStorage } from "./storage/memory.js";
import type { Storage } from "./storage/Storage.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  process.env.TZ = config.tz;

  let storage: Storage;
  if (config.storage === "memory") {
    storage = new MemoryStorage();
    logger.warn("STORAGE=memory 乾跑:不寫真表,只驗領取/處理流程");
  } else {
    if (!config.google) throw new Error("sheets 模式缺 Google 設定");
    storage = new GoogleSheetsStorage({
      credentials: config.google.credentials,
      sheetId: config.google.sheetId,
      sheetName: config.google.stagingSheetName,
    });
  }
  await storage.ensureHeader();

  const bot = createBot(config, storage);
  // handleUpdate 要 botInfo 才能正確解析群組內的 /command@botname;先抓好(launch 平時會做)。
  bot.botInfo = await bot.telegram.getMe();
  // 確保沒有殘留 webhook(否則 getUpdates 回 409 Conflict);保留待領更新不丟。
  await bot.telegram.deleteWebhook({ drop_pending_updates: false });

  let offset = 0;
  let processed = 0;
  for (;;) {
    // timeout=0 → 不長等:有就回、沒有立刻回空(一次性語意,不要 block 住 Actions)。
    const updates = await bot.telegram.getUpdates(0, 100, offset, undefined);
    if (updates.length === 0) break;
    for (const u of updates) {
      try {
        await bot.handleUpdate(u);
      } catch (err) {
        logger.error(`處理 update ${u.update_id} 失敗(跳過,下次重領)`, err);
      }
      offset = u.update_id + 1; // 帶到下一輪 getUpdates 即 ack 本批
      processed += 1;
    }
  }
  // 迴圈以空批結束時,最後一次 getUpdates(offset) 已 ack;這行只在「處理過但迴圈剛好
  // 沒再多領一輪」的邊角補一次 ack,確保下回 cron 不重領。offset===0 表示沒更新,免呼叫。
  if (offset > 0) await bot.telegram.getUpdates(0, 1, offset, undefined);

  logger.info(`drain 完成:處理 ${processed} 筆更新`);
}

main().catch((err) => {
  logger.error("drain 失敗", err);
  process.exit(1);
});
