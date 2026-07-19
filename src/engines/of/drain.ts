/**
 * drain —— 一次性把 Telegram 這 24h 內囤的更新撈乾、處理、寫表,然後結束。
 *
 * 取代常駐 long polling:給 GitHub Actions cron 週期呼叫,$0、不需常駐機器,
 * 也避開 Docker-on-WSL2 對 googleapis 大封包的 Premature close(Actions 跑 ubuntu 直連)。
 *
 * 不漏訊息:Telegram 保留未領取更新約 24h。只要 cron 間隔 < 24h,每次把待領更新領乾即可。
 * 失敗語意:中途崩潰沒 ack → 下次 cron 重領,storage 去重(VIDEO_ID)擋掉重複。at-least-once。
 *
 * 寫入失敗(可重試)= 紅線:runIngest 內 append 失敗會觸發 onPersistError → 旗標翻 true,
 * 該筆「沒持久化」不可 ack。drain 停在當前 offset、結束本輪,留給下次 cron 重領(去重擋重複)。
 * 絕不把沒寫成功的訊息默默 ack 掉(= 靜默丟資料,CLAUDE.md 紅線)。
 *
 * 迴圈本體(getUpdates→handleUpdate→ack;abort 語意)與 exit code 對映抽在 shared/drainLoop.ts,
 * 可注入假 bot 測試(本檔是 entry,import 即執行,測試載不進來)。
 */
import { createBot } from "./bot/router.js";
import { loadConfig } from "./config.js";
import {
  drainUpdates,
  exitCodeFor,
  type DrainResult,
  type PersistFlag,
} from "../../shared/drainLoop.js";
import { makeGateAlerter } from "./drainLoop.js";
import { GoogleSheetsStorage } from "./storage/googleSheets.js";
import { MemoryStorage } from "./storage/memory.js";
import type { Storage } from "./storage/Storage.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<DrainResult> {
  const config = loadConfig();
  // DATE 一律 Asia/Taipei(utils/date.ts 寫死),不靠 process.env.TZ。

  // 總表 gate 失效告警:先宣告、bot 建立後才綁定(gate 只在 handleUpdate 期間觸發,屆時 bot 已在)。
  let sendGateAlert: (detail: string) => void = () => {};
  let flushGateAlert: () => Promise<void> = async () => {};

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
      prodSheetName: config.google.prodSheetName,
      onGateSkip: (detail) => sendGateAlert(detail),
    });
  }
  await storage.ensureHeader();

  // persist.failed:某筆寫入暫存區失敗(可重試)的 side-channel 旗標。每筆處理前歸零,
  // handleUpdate 內若觸發 onPersistError 會翻 true → 該筆「沒持久化」,不能 ack。
  const persist: PersistFlag = { failed: false };
  const bot = createBot(config, storage, {
    onPersistError: () => {
      persist.failed = true;
    },
  });
  const gateAlerter = makeGateAlerter(config.errorChatId, (chatId, text) =>
    bot.telegram.sendMessage(chatId, text),
  );
  sendGateAlert = gateAlerter.send;
  flushGateAlert = gateAlerter.flush;
  bot.botInfo = await bot.telegram.getMe(); // handleUpdate 解析群組 /command@botname 需要
  await bot.telegram.deleteWebhook({ drop_pending_updates: false }); // 清殘留 webhook,保留待領更新

  const result = await drainUpdates(bot, persist, "暫存區");

  // exit 前先等 gate 告警送完:bootstrap 是 process.exit(exitCodeFor),會砍在途 I/O;
  // 舊寫法 fire-and-forget(void sendMessage)在這裡就會被砍掉、告警靜默消失。
  await flushGateAlert();

  logger.info(
    `drain ${result.aborted ? "中止(寫入失敗,部分未處理)" : "完成"}:已處理 ${result.processed} 筆更新`,
  );
  return result;
}

main()
  // 顯式退出 + exit code 對映:aborted → exit 2(非 0)。舊版一律 exit 0 會讓 collect.yml
  // 假綠、kai-notify(if: failure())永不觸發 —— Sheets 壞掉 + ERROR_CHAT_ID 沒設時
  // 就是靜默丟資料。main resolve 前已 await flushGateAlert,這裡 exit 不會截斷告警。
  .then((result) => process.exit(exitCodeFor(result)))
  .catch((err) => {
    logger.error("drain 失敗", err);
    process.exit(1);
  });
