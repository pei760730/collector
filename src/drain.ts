/**
 * drain —— 一次性把 Telegram 這 24h 內囤的更新撈乾、處理、寫進「參考池」,然後結束。
 *
 * 取代常駐 long polling:給 GitHub Actions cron 週期呼叫,$0、不需常駐機器,
 * 也避開 Docker-on-WSL2 對 googleapis 大封包的 Premature close(Actions 跑 ubuntu 直連)。
 *
 * 為什麼「定時撈一次」不漏訊息:Telegram 會保留未領取的更新約 24h。只要 cron 間隔 < 24h,
 * 每次把待領更新領乾即可。用 getUpdates(offset) 逐批領 + ack(下一次帶新 offset 即確認上一批);
 * 處理走和常駐完全相同的 `bot.handleUpdate`,行為一致、不重寫邏輯。
 *
 * 失敗語意:中途崩潰沒 ack → 下次 cron 重領,storage 去重(連結 key)擋掉重複。
 * at-least-once,寧可重複看得到也不要遺失(對齊 voc move_row 的同款取捨)。
 */
import { createBot } from "./bot/router.js";
import { loadConfig } from "./config.js";
import { drainUpdates, exitCodeFor, type DrainResult, type PersistFlag } from "./drainLoop.js";
import { GoogleSheetsStorage } from "./storage/googleSheets.js";
import { MemoryStorage } from "./storage/memory.js";
import type { Storage } from "./storage/Storage.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<DrainResult> {
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
      sheetName: config.google.poolSheetName,
    });
  }
  await storage.ensureHeader();

  // persist.failed:某筆寫入參考池失敗(可重試)的 side-channel 旗標。每筆處理前歸零,
  // handleUpdate 內若觸發 onPersistError 會翻 true → 該筆「沒持久化」,不能 ack。
  const persist: PersistFlag = { failed: false };
  const bot = createBot(config, storage, {
    onPersistError: () => {
      persist.failed = true;
    },
  });
  // handleUpdate 要 botInfo 才能正確解析群組內的 /command@botname;先抓好(launch 平時會做)。
  bot.botInfo = await bot.telegram.getMe();
  // 確保沒有殘留 webhook(否則 getUpdates 回 409 Conflict);保留待領更新不丟。
  await bot.telegram.deleteWebhook({ drop_pending_updates: false });

  // 迴圈本體(getUpdates→handleUpdate→ack;abort 語意)抽到 drainLoop.ts,可注入假 bot 測試。
  const result = await drainUpdates(bot, persist);

  logger.info(
    `drain ${result.aborted ? "中止(寫入失敗,部分未處理)" : "完成"}:已處理 ${result.processed} 筆更新`,
  );
  // 不 prune:參考池是 voc 永久池,bot 只 append 不刪列(prune 已隨暫存區一起退役)。
  return result;
}

main()
  // 顯式退出:避免 telegraf/gaxios 殘留 keep-alive handle 讓 Actions job 卡到 timeout。
  // aborted → exit 2(非 0):舊版一律 exit 0 會讓 collect.yml 假綠、kai-notify(if: failure())
  // 永不觸發 —— Sheets 壞掉 + ERROR_CHAT_ID 沒設時就是靜默丟資料。ERROR_CHAT_ID 告警
  // 在 handleUpdate 內由 router notifyError await 送完才回來,main resolve 時已送出,
  // 這裡 exit 不會截斷告警。
  .then((result) => process.exit(exitCodeFor(result)))
  .catch((err) => {
    logger.error("drain 失敗", err);
    process.exit(1);
  });
