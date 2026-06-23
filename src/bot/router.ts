/**
 * Telegraf 指令路由 —— 把指令對到 handler,集中錯誤處理。
 * 指令解析框架留好:/stats、一般訊息。新指令在這裡掛。
 * (/pick 已退役 2026-06-23:挑片統一走 Sheet 勾「挑」checkbox → GAS 搬待拍;
 *  /pick 靠 R 號定位,但 bot 直寫的列 id 留空、定位不到,且本來就要打字,單人作業多餘。)
 */
import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import type { Config } from "../config.js";
import type { Storage } from "../storage/Storage.js";
import { runCollect } from "./handlers/collect.js";
import { runStats } from "./handlers/stats.js";
import { logger } from "../utils/logger.js";

/** drain 模式注入的鉤子;常駐版不傳(undefined)。 */
export interface BotHooks {
  /** 某筆寫入參考池失敗時呼叫(drain 用來停在當前 offset、不 ack)。 */
  onPersistError?: () => void;
}

export function createBot(config: Config, storage: Storage, hooks?: BotHooks): Telegraf {
  const bot = new Telegraf(config.telegramToken);

  const notifyError = async (text: string) => {
    if (!config.errorChatId) return;
    try {
      await bot.telegram.sendMessage(config.errorChatId, `🐞 ${text}`);
    } catch (e) {
      logger.error("通知 error chat 失敗", e);
    }
  };

  // /start /help —— 簡短說明
  bot.start((ctx) =>
    ctx.reply("貼「短影音連結 + 備註」我就幫你收進參考池。挑片在 Sheet 勾「挑」。指令:/stats"),
  );
  bot.help((ctx) =>
    ctx.reply(
      "貼連結收錄;/stats 看統計。挑片:到「參考池」勾「挑」欄,GAS 自動搬進待拍。",
    ),
  );

  // /stats
  bot.command("stats", async (ctx) => {
    try {
      await ctx.reply(await runStats({ storage }));
    } catch (err) {
      logger.error("/stats 失敗", err);
      await ctx.reply("❌ 取統計失敗。").catch(() => {});
      await notifyError(`/stats 失敗:${errText(err)}`);
    }
  });

  // 文字 / caption 共用的收集流程。已被上面 command 攔截的不會進來。
  const handleCollectText = async (ctx: Context, text: string) => {
    // 未知指令(以 / 開頭但沒對到)→ 提示,不要當連結處理
    if (text.startsWith("/")) {
      await ctx.reply("不認得這個指令。可用:/stats,或直接貼連結。").catch(() => {});
      return;
    }
    try {
      const result = await runCollect(
        { text, senderName: ctx.from?.first_name },
        {
          storage,
          expandShortUrls: config.expandShortUrls,
          onPersistError: hooks?.onPersistError,
        },
      );
      // reply 包 catch:使用者封鎖 bot / chat 失效時 reply 會丟例外,
      // 不能因此吞掉 notifyError(寫表結果才是重點)。對齊 /stats 的護法。
      await ctx.reply(result.reply).catch(() => {});
      if (result.error) await notifyError(result.error);
    } catch (err) {
      logger.error("collect 例外", err);
      await ctx.reply("❌ 處理時發生未預期錯誤。").catch(() => {});
      await notifyError(`collect 例外:${errText(err)}`);
    }
  };

  // 一般文字訊息 → 收集 pipeline。
  bot.on(message("text"), (ctx) => handleCollectText(ctx, ctx.message.text));

  // 媒體訊息的 caption → 同一條 pipeline。轉傳/分享影片貼文時連結常在 caption 而非 text,
  // 只接 text 會讓這類訊息被靜默 ack 掉、不收錄也不回覆(漏資料)。caption 走 collect:
  // 有連結就收,沒連結則回「看不懂」提示,不再無聲丟失。
  bot.on(message("caption"), (ctx) => handleCollectText(ctx, ctx.message.caption ?? ""));

  // 全域兜底
  bot.catch((err, ctx) => {
    logger.error(`Telegraf 未捕捉錯誤 (update ${ctx.updateType})`, err);
  });

  return bot;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
