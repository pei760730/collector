/**
 * shell(voc/tbvoc) 與 of 共用的 Telegram 安全／錯誤處理水電。
 *
 * 這些規則不依賴任何 target 的資料模型；集中在這裡避免單邊修正後另一邊漂移。
 */
import type { Context, Telegraf } from "telegraf";
import { logger } from "@pei760730/collector-core";

/**
 * drain 用的 Telegraf 建構選項 —— 關掉 telegraf 的 handler 逾時牆。
 *
 * telegraf 的預設 `handlerTimeout` 是 90000ms,而那個預設會**靜默吃掉資料**:
 * `handleUpdate` 用 pTimeout 包住 middleware,逾時錯誤交給 `handleError`(= 被我們
 * 覆寫掉的 `bot.catch`)之後,`handleUpdate` 仍然**正常 resolve**
 * (node_modules/telegraf/lib/telegraf.js:233-236)。
 *
 * telegraf 內建的預設 handleError 會 `process.exitCode = 1` 並 rethrow(telegraf.js:84-90);
 * 兩支 router 都把它覆寫成「只記一行 log」,於是那兩個訊號一起消失。結果是:
 * 單筆處理超過 90 秒 → drainLoop 看不到任何例外 → `persist.failed` 仍是 false →
 * offset 前進 → 下一次 getUpdates 就把這筆 **ack 掉**,而那一列從來沒寫進表。
 * job 綠燈、失敗通知不響、Step Summary 還寫「已處理 N 筆」。
 * 這正是 drainLoop.ts 註解引用的 CLAUDE.md 紅線「絕不把沒寫成功的訊息默默 ack 掉」,
 * 被一個沒人設定過的預設值繞過去(repo 從未出現過 handlerTimeout 這個字)。
 *
 * 真正該當 wall clock 的是 collect.yml 的 `timeout-minutes: 10`:逾時 → job cancelled →
 * 這批 offset 從未回報給 Telegram → 下次 cron 整段重領 → 各 target 的去重吸收重複。
 * 那條路是 at-least-once;90 秒這條是 at-most-once 而且無聲。
 *
 * Infinity 是 p-timeout 官方的停用值(node_modules/p-timeout/index.js:17-20 直接 resolve
 * 原 promise),不是傳 0(0 會被當成「立刻逾時」)。
 *
 * ⚠️ 兩支 router 必須共用這一份。分兩處各寫各的,就是下一個「一邊修好、另一邊漂著」。
 */
export const DRAIN_SAFE_TELEGRAF_OPTIONS = {
  handlerTimeout: Number.POSITIVE_INFINITY,
};

export interface TelegramSafetyConfig {
  /** 來源白名單。空名單只允許用於不寫真表的乾跑／開發模式。 */
  allowedChatIds: readonly number[];
  /** 選配的管理員錯誤通知 chat id。 */
  errorChatId: string;
}

/**
 * 在所有業務 handler 前安裝來源白名單。
 *
 * 未授權更新會被視為已處理而不呼叫 next，讓 drain 正常 ack、避免垃圾訊息卡住
 * offset；同一 chat 每個進程只提示一次，且公開 log 只留下遮蔽後的 id。
 */
export function installSourceAllowlist(
  bot: Telegraf<Context>,
  config: TelegramSafetyConfig,
): void {
  if (config.allowedChatIds.length === 0) return;

  const allowed = new Set(config.allowedChatIds);
  const deniedNotified = new Set<number>();
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    const fromId = ctx.from?.id;
    if ((chatId != null && allowed.has(chatId)) || (fromId != null && allowed.has(fromId))) {
      return next();
    }

    logger.warn(
      `擋下非授權來源:chat=${maskId(chatId)} from=${maskId(fromId)}(不在 ALLOWED_CHAT_IDS)`,
    );

    // reply / 管理員通知都是 best-effort；發送失敗不能讓 drain 把本筆誤判成處理例外。
    if (chatId != null && !deniedNotified.has(chatId)) {
      deniedNotified.add(chatId);
      const denyId = fromId ?? chatId;
      await ctx.reply(deniedMessage(denyId)).catch((error) => {
        logger.warn(`回覆非授權來源提示失敗:chat=${maskId(chatId)}`, error);
      });

      if (config.errorChatId) {
        const username = ctx.from?.username ? ` @${ctx.from.username}` : "";
        await ctx.telegram
          .sendMessage(
            config.errorChatId,
            `🔔 有人想用 bot 但不在白名單：id=${denyId}${username}。放行就把這 id 加進 ALLOWED_CHAT_IDS。`,
          )
          .catch((error) => {
            logger.warn(`通知管理員被擋來源失敗:chat=${maskId(chatId)}`, error);
          });
      }
    }
  });
}

/** 建立共用錯誤通知器；沒設 ERROR_CHAT_ID 時維持 no-op。 */
export function createErrorNotifier(
  bot: Telegraf<Context>,
  errorChatId: string,
): (text: string) => Promise<void> {
  return async (text: string) => {
    if (!errorChatId) return;
    try {
      await bot.telegram.sendMessage(errorChatId, `🐞 ${text}`);
    } catch (error) {
      logger.error("通知 error chat 失敗", error);
    }
  };
}

export function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 遮蔽 Telegram id：回傳末 2 碼(不足 3 碼全遮)，不外洩完整 id 到公開 log。 */
export function maskId(id: number | undefined): string {
  if (id == null) return "none";
  const text = String(Math.abs(id));
  return text.length <= 2 ? "**" : `***${text.slice(-2)}`;
}

/** 被擋者私訊提示可帶完整 id，方便本人交給管理員加入白名單。 */
export function deniedMessage(id?: number): string {
  const base = "你沒有使用權限，請聯絡管理員";
  return id == null ? base : `${base}。\n你的 ID：${id}（把這串傳給管理員加進白名單即可）`;
}
