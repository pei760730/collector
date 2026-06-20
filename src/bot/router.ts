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
import { runPick } from "./handlers/pick.js";
import { GoogleSheetsPool, type PoolStore } from "../storage/poolPick.js";
import { logger } from "../utils/logger.js";

/** drain 模式注入的鉤子;常駐版不傳(undefined)。 */
export interface BotHooks {
  /** 某筆寫入暫存區失敗時呼叫(drain 用來停在當前 offset、不 ack)。 */
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

  // 參考池打勾器(/pick 用);memory 乾跑模式沒有真表 → null。
  const pool: PoolStore | null = config.google
    ? new GoogleSheetsPool({
        credentials: config.google.credentials,
        sheetId: config.google.sheetId,
        poolSheetName: config.google.poolSheetName,
      })
    : null;

  // /start /help —— 簡短說明
  bot.start((ctx) =>
    ctx.reply("貼「短影音連結 + 備註」我就幫你收進暫存區。指令:/stats /move /pick"),
  );
  bot.help((ctx) =>
    ctx.reply(
      "貼連結收錄;/stats 看統計;/move 把 active 標成 moved;/pick R#### 把參考池編碼打勾(交 voc 搬待拍)。",
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

  // /pick R#### [R#### …] —— 在參考池打勾,交 voc pick 搬進待拍
  bot.command("pick", async (ctx) => {
    const arg = commandArg(ctx, "pick");
    if (!pool) {
      await ctx.reply("memory 乾跑模式不支援 /pick(需接真表)。").catch(() => {});
      return;
    }
    try {
      await ctx.reply((await runPick(arg, { pool })).reply).catch(() => {});
    } catch (err) {
      logger.error("/pick 失敗", err);
      await ctx.reply("❌ 打勾失敗。").catch(() => {});
      await notifyError(`/pick 失敗:${errText(err)}`);
    }
  });

  // 一般文字訊息 → 收集 pipeline。已被上面 command 攔截的不會進來。
  bot.on(message("text"), async (ctx) => {
    const text = ctx.message.text;
    // 未知指令(以 / 開頭但沒對到)→ 提示,不要當連結處理
    if (text.startsWith("/")) {
      return ctx.reply("不認得這個指令。可用:/stats /move /pick,或直接貼連結。");
    }
    try {
      const result = await runCollect(
        { text, senderName: ctx.from?.first_name },
        {
          storage,
          dedupePeriodDays: config.dedupePeriodDays,
          expandShortUrls: config.expandShortUrls,
          onPersistError: hooks?.onPersistError,
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
