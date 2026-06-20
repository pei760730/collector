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
  // DATE / 去重窗一律 Asia/Taipei(utils/date.ts 寫死),不靠 process.env.TZ。

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

  // persistFailed:某筆寫入暫存區失敗(可重試)的 side-channel 旗標。每筆處理前歸零,
  // handleUpdate 內若觸發 onPersistError 會翻 true → 該筆「沒持久化」,不能 ack。
  let persistFailed = false;
  const bot = createBot(config, storage, {
    onPersistError: () => {
      persistFailed = true;
    },
  });
  // handleUpdate 要 botInfo 才能正確解析群組內的 /command@botname;先抓好(launch 平時會做)。
  bot.botInfo = await bot.telegram.getMe();
  // 確保沒有殘留 webhook(否則 getUpdates 回 409 Conflict);保留待領更新不丟。
  await bot.telegram.deleteWebhook({ drop_pending_updates: false });

  let offset = 0;
  let processed = 0;
  let aborted = false;
  outer: for (;;) {
    // timeout=0 → 不長等:有就回、沒有立刻回空(一次性語意,不要 block 住 Actions)。
    const updates = await bot.telegram.getUpdates(0, 100, offset, undefined);
    if (updates.length === 0) break;
    for (const u of updates) {
      persistFailed = false;
      try {
        await bot.handleUpdate(u);
      } catch (err) {
        // 解析/路由層的非預期例外(非寫入失敗):這類重領也沒用,記錄後跳過。
        logger.error(`處理 update ${u.update_id} 例外(跳過)`, err);
      }
      if (persistFailed) {
        // 寫入失敗(可重試):不前進 offset、結束整個 drain。前面成功的那段下次 cron 的
        // 第一次 getUpdates(offset) 會 ack;這筆與之後的會被重領,靠 storage VIDEO_ID 去重。
        // 這樣才真正 at-least-once,不會把沒寫成功的訊息默默 ack 掉(CLAUDE.md 紅線)。
        logger.error(`update ${u.update_id} 寫入暫存區失敗 → 停在此 offset,結束本輪讓下次 cron 重領`);
        aborted = true;
        break outer;
      }
      offset = u.update_id + 1; // 帶到下一輪 getUpdates 即 ack 本批(累積語意)
      processed += 1;
    }
  }
  // 正常結束時最後一次「空批」getUpdates(offset) 已 ack 最後一批,不需額外補 ack。
  // 中止結束時刻意不 ack 未處理段,留給下次 cron 重領。

  logger.info(`drain ${aborted ? "中止(寫入失敗,部分未處理)" : "完成"}:已處理 ${processed} 筆更新`);

  // 清窗外舊列:暫存區是 append-only,不清會無限長。去重本來就忽略窗外列(age > 窗),
  // 刪掉不影響去重(DATE 壞掉的列 prune 也保留,與去重一致)。prune 是清理、非關鍵路徑,
  // 失敗只記 error 不讓整個 drain 崩(這輪更新已成功入庫)。
  try {
    const pruned = await storage.pruneOlderThan(config.dedupePeriodDays);
    if (pruned > 0) {
      logger.info(`prune:刪除 ${pruned} 筆窗外(>${config.dedupePeriodDays} 天)舊列`);
    }
  } catch (err) {
    logger.error("prune 失敗(忽略,不影響本輪 drain 已入庫的更新)", err);
  }
}

main()
  .then(() => process.exit(0)) // 顯式退出:避免 telegraf/gaxios 殘留 keep-alive handle 讓 Actions job 卡到 timeout
  .catch((err) => {
    logger.error("drain 失敗", err);
    process.exit(1);
  });
