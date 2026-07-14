/**
 * drain 編排本體(從 drain.ts entry 抽出) —— 組 bot→撈乾→回傳進程退出碼。
 * drain.ts 是進程進入點(import 即跑 main + 真連線),測試無法直接 import;
 * 抽成可注入 config/storage/target 的函式後,tests/drainExit.test.ts 才能用
 * Telegram.prototype.callApi stub(CLAUDE.md 第三層攔截點)釘住退出碼與告警語意。
 * 迴圈本體(offset/abort/ack)仍在 drainLoop.ts(tests/drainLoop.test.ts 用假 bot 釘住)。
 */
import { createBot } from "./bot/router.js";
import type { Config } from "./config.js";
import type { Storage } from "./storage/Storage.js";
import { VOC_TARGET, type TargetSpec } from "./targets.js";
import { drainUpdates, exitCodeFor, type PersistFlag } from "./drainLoop.js";
import { logger } from "./utils/logger.js";

export async function runDrain(
  config: Config,
  storage: Storage,
  // 預設 voc:既有行為零變更。生產由 drain.ts 依 config.target 傳入。
  target: TargetSpec = VOC_TARGET,
): Promise<number> {
  await storage.ensureHeader();

  // persist.failed:某筆寫入參考池失敗(可重試)的 side-channel 旗標。每筆處理前歸零,
  // handleUpdate 內若觸發 onPersistError 會翻 true → 該筆「沒持久化」,不能 ack。
  const persist: PersistFlag = { failed: false };
  const bot = createBot(
    config,
    storage,
    {
      onPersistError: () => {
        persist.failed = true;
      },
    },
    target,
  );
  // handleUpdate 要 botInfo 才能正確解析群組內的 /command@botname;先抓好(launch 平時會做)。
  bot.botInfo = await bot.telegram.getMe();
  // 確保沒有殘留 webhook(否則 getUpdates 回 409 Conflict);保留待領更新不丟。
  await bot.telegram.deleteWebhook({ drop_pending_updates: false });

  const result = await drainUpdates(bot, persist);

  logger.info(
    `drain ${result.aborted ? "中止(寫入失敗,部分未處理)" : "完成"}:已處理 ${result.processed} 筆更新`,
  );
  // 不 prune:參考池是永久池,bot 只 append 不刪列(prune 已隨暫存區一起退役)。

  // (tbvoc 既有行為)中止時先送 Telegram 告警、再回非零碼:第一時間直達 ERROR_CHAT_ID;
  // 告警本身失敗不影響退出碼 —— 紅燈(exit 2 → collect.yml failure → kai-notify)是兜底,不能被吞。
  // voc 維持既有行為(drainAbortAlert=false,只靠 exit 2 紅燈 + router notifyError),零變更。
  if (result.aborted && target.drainAbortAlert && config.errorChatId) {
    await bot.telegram
      .sendMessage(
        config.errorChatId,
        `🐞 drain 中止:寫入參考池失敗(已成功 ${result.processed} 筆後停下),未 ack 段留待下次 cron 重領。詳見 Actions log。`,
      )
      .catch((e) => logger.error("通知 error chat 失敗", e));
  }
  return exitCodeFor(result);
}
