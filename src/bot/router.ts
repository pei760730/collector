/**
 * Telegraf 指令路由 —— 把指令對到 handler,集中錯誤處理。
 * 指令解析框架留好:/stats、/move、一般訊息。新指令在這裡掛。
 */
import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import type { Config } from "../config.js";
import type { Storage } from "../storage/Storage.js";
import { runCollect } from "./handlers/collect.js";
import { runStats } from "./handlers/stats.js";
import { runMove } from "./handlers/move.js";
import { logger } from "../utils/logger.js";

export function createBot(config: Config, storage: Storage): Telegraf {
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
    ctx.reply("貼「短影音連結 + 備註」我就幫你收進暫存區。指令:/stats /move"),
  );
  bot.help((ctx) => ctx.reply("貼連結收錄;/stats 看統計;/move 把 active 標成 moved。"));

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

  // /move [VIDEO_ID]
  bot.command("move", async (ctx) => {
    const arg = commandArg(ctx, "move");
    try {
      await ctx.reply(await runMove(arg, { storage }));
    } catch (err) {
      logger.error("/move 失敗", err);
      await ctx.reply("❌ 搬移失敗。").catch(() => {});
      await notifyError(`/move 失敗:${errText(err)}`);
    }
  });

  // 一般文字訊息 → 收集 pipeline。已被上面 command 攔截的不會進來。
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text;
    // 未知指令(以 / 開頭但沒對到)→ 提示,不要當連結處理
    if (text.startsWith("/")) {
      return ctx.reply("不認得這個指令。可用:/stats /move,或直接貼連結。");
    }
    try {
      const result = await runCollect(
        { text, senderName: ctx.from?.first_name },
        {
          storage,
          dedupePeriodDays: config.dedupePeriodDays,
          expandShortUrls: config.expandShortUrls,
        },
      );
      // reply 包 catch:使用者封鎖 bot / chat 失效時 reply 會丟例外,
      // 不能因此吞掉 notifyError(寫表結果才是重點)。對齊 /stats、/move 的護法。
      await ctx.reply(result.reply).catch(() => {});
      if (result.error) await notifyError(result.error);
    } catch (err) {
      logger.error("collect 例外", err);
      await ctx.reply("❌ 處理時發生未預期錯誤。").catch(() => {});
      await notifyError(`collect 例外:${errText(err)}`);
    }
  });

  // 全域兜底
  bot.catch((err, ctx) => {
    logger.error(`Telegraf 未捕捉錯誤 (update ${ctx.updateType})`, err);
  });

  return bot;
}

/** 取指令參數:`/move abc` → `abc`。 */
function commandArg(ctx: Context, command: string): string {
  const text =
    ctx.message && "text" in ctx.message ? (ctx.message.text as string) : "";
  const re = new RegExp(`^/${command}(?:@\\S+)?\\s*`, "i");
  return text.replace(re, "").trim();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
