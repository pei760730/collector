/**
 * Telegraf 指令路由 —— 把訊息對到 handler,集中錯誤處理。
 */
import { Telegraf, type Context } from "telegraf";
import { message } from "telegraf/filters";
import { isTransient } from "@pei760730/collector-core";
import type { Config } from "../config.js";
import type { Storage } from "../storage/Storage.js";
import { runIngest } from "./handlers/ingest.js";
import { runStats } from "./handlers/stats.js";
import { logger } from "../utils/logger.js";
import {
  createErrorNotifier,
  errText,
  installSourceAllowlist,
} from "../../../shared/telegramSafety.js";

/** drain 模式注入的鉤子;常駐版不傳(undefined)。 */
export interface BotHooks {
  /** 某筆寫入暫存區失敗時呼叫(drain 用來停在當前 offset、不 ack)。 */
  onPersistError?: () => void;
}

export function createBot(config: Config, storage: Storage, hooks?: BotHooks): Telegraf {
  const bot = new Telegraf(config.telegramToken);

  // 必須先於所有業務 handler，讓 polling 與 drain(handleUpdate)共用同一個來源 guard。
  installSourceAllowlist(bot, config);
  const notifyError = createErrorNotifier(bot, config.errorChatId);

  bot.start((ctx) =>
    ctx.reply("貼一則含影片連結的訊息,我就幫你收進暫存區。指令:/stats 看統計。"),
  );
  bot.help((ctx) =>
    ctx.reply(
      "貼影片連結即收錄;/stats 看暫存區統計。支援:Instagram / TikTok / YouTube / Facebook / X / 小紅書 / Threads / 抖音。",
    ),
  );

  // /stats —— 暫存區彙總。註冊在 message handler 之前,/stats 才會被指令攔截。
  bot.command("stats", async (ctx) => {
    try {
      // reply 包 catch:使用者封鎖 bot / chat 失效時 reply 丟例外,不該把「發送失敗」誤報成
      // 「取統計失敗」還驚動 error chat;但也不全吞 —— 至少留 warn,發送壞掉才查得到。
      await ctx.reply(await runStats({ storage })).catch((e) => logger.warn("/stats 回覆發送失敗", e));
    } catch (err) {
      logger.error("/stats 失敗", err);
      await ctx.reply("❌ 取統計失敗。").catch(() => {});
      await notifyError(`/stats 失敗:${errText(err)}`);
    }
  });

  // 文字 / caption 共用的收集流程。已被上面 command 攔截的不會進來。
  const handleIngestText = async (ctx: Context, text: string) => {
    // 未知指令(以 / 開頭但沒對到)→ 提示,不要當連結處理
    if (text.startsWith("/")) {
      await ctx.reply("不認得這個指令。可用:/stats,或直接貼影片連結。").catch(() => {});
      return;
    }
    try {
      const result = await runIngest(
        { text },
        {
          storage,
          expandShortUrls: config.expandShortUrls,
          onPersistError: hooks?.onPersistError,
        },
      );
      // reply 包 catch:使用者封鎖 bot / chat 失效時 reply 會丟例外,不能因此吞掉
      // notifyError(寫表結果才是重點)。
      await ctx.reply(result.reply).catch(() => {});
      if (result.error) await notifyError(result.error);
    } catch (err) {
      logger.error("ingest 例外", err);
      // videoIdIndex() 全表讀在 inner try 之外:暫態失敗照常 ack 會讓這則訊息從佇列
      // 永久消失。比照主 router 夯度 callback 翻 persist 旗標,drain 停在此 offset 下輪重領。
      if (isTransient(err)) hooks?.onPersistError?.();
      await ctx.reply("❌ 處理時發生未預期錯誤。").catch(() => {});
      await notifyError(`ingest 例外:${errText(err)}`);
    }
  };

  // 一般文字訊息 → 收集 pipeline。
  bot.on(message("text"), (ctx) => handleIngestText(ctx, ctx.message.text));

  // 媒體訊息的 caption → 同一條 pipeline。轉傳/分享影片貼文時連結常在 caption 而非 text,
  // 只接 text 會讓這類訊息被靜默 ack 掉、不收錄也不回覆(漏資料)。caption 走 ingest:
  // 有連結就收,沒連結則回「看不懂」提示,不再無聲丟失。
  bot.on(message("caption"), (ctx) => handleIngestText(ctx, ctx.message.caption ?? ""));

  bot.catch((err, ctx: Context) => {
    logger.error(`Telegraf 未捕捉錯誤 (update ${ctx.updateType})`, err);
  });

  return bot;
}
