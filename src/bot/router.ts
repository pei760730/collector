/**
 * Telegraf 指令路由 —— 把指令對到 handler,集中錯誤處理。
 * 指令解析框架留好:/stats、一般訊息。新指令在這裡掛。
 * (/pick 已退役 2026-06-23:挑片統一走 Sheet 勾「挑」checkbox → GAS 搬待拍;
 *  /pick 靠 R 號定位,但 bot 直寫的列 id 留空、定位不到,且本來就要打字,單人作業多餘。)
 */
import { Telegraf, Markup, type Context } from "telegraf";
import { message } from "telegraf/filters";
import { isTransient } from "@pei760730/collector-core";
import type { Config } from "../config.js";
import type { Storage } from "../storage/Storage.js";
import { runCollect } from "./handlers/collect.js";
import { runStats } from "./handlers/stats.js";
import { deniedMsg } from "../messages/templates.js";
import { VOC_TARGET, type TargetSpec } from "../targets.js";
import { logger } from "../utils/logger.js";

// ── 夯度 inline 按鈕(tbvoc;自 clip-collector 移植,值域改由 target.hotValues 注入)─────
// 收錄成功後在回覆下掛一排「夯爆了/NPC/拉完了」,分享者一鍵下標。
// callback_data = h:<idx>:<dedupKey>;Telegram 上限 64 bytes,放不下(罕見長路徑
// fallback key)就不掛按鈕(那種片直接在 Sheet 手標即可)。
export function hotCbData(idx: number, key: string): string {
  return `h:${idx}:${key}`;
}
export function hotKeyFits(key: string, values: readonly string[]): boolean {
  return Buffer.byteLength(hotCbData(values.length - 1, key), "utf8") <= 64;
}
export function hotKeyboard(key: string, values: readonly string[], chosen = -1) {
  const row = values.map((label, i) =>
    Markup.button.callback(i === chosen ? `✅ ${label}` : label, hotCbData(i, key)),
  );
  return Markup.inlineKeyboard([row]); // 一排 3 顆,滿手機寬
}

/** drain 模式注入的鉤子;常駐版不傳(undefined)。 */
export interface BotHooks {
  /** 某筆寫入參考池失敗時呼叫(drain 用來停在當前 offset、不 ack)。 */
  onPersistError?: () => void;
}

export function createBot(
  config: Config,
  storage: Storage,
  hooks?: BotHooks,
  // 預設 voc:既有呼叫端/測試零改動。生產由 drain 依 config.target 傳入。
  target: TargetSpec = VOC_TARGET,
): Telegraf {
  const bot = new Telegraf(config.telegramToken);

  // 來源白名單(公開 repo 防護):只處理名單內 chat/user 的訊息,其餘丟棄(不寫池、不進 handler),
  // 但回一句「沒有權限」提示 —— 完全靜默會讓誤加的自己人以為 bot 壞了
  // (2026-07-07:兩位協作者連 /start 都沒回應,查了一天才發現是被白名單擋下)。
  // 同一 chat 每次進程只提醒一次(drain=每輪一次),陌生人連發也不會被回覆灌爆。
  // 放在所有 handler 之前 → polling 與 drain(handleUpdate)兩條路都涵蓋。
  // 比對 chat.id(私訊=你的 user id;群組=群 id)或 from.id(發訊者),命中其一即放行。
  // 空名單=不限制(僅 memory 乾跑/開發;sheets 模式 config 已 fail-fast 強制要求設定)。
  if (config.allowedChatIds.length > 0) {
    const allowed = new Set(config.allowedChatIds);
    const deniedNotified = new Set<number>();
    bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id;
      const fromId = ctx.from?.id;
      if ((chatId != null && allowed.has(chatId)) || (fromId != null && allowed.has(fromId))) {
        return next();
      }
      // 丟棄但不報錯:drain 會照常 ack 推進 offset,避免垃圾訊息每輪重領卡住佇列。
      // id 遮蔽:public repo 的 Actions log 是公開的,不外洩陌生人原始 Telegram id(去識別),
      // 只留末 2 碼供粗略辨識重複來源。
      logger.warn(`擋下非授權來源:chat=${maskId(chatId)} from=${maskId(fromId)}(不在 ALLOWED_CHAT_IDS)`);
      // 提示是 best-effort:reply 失敗(被封鎖等)不能拋出,否則這筆會被 drain 記成處理例外。
      // 回覆帶上發訊者自己的 id、並(若有設 errorChatId)一併通知管理員 → 被擋的自己人可自助上白名單。
      // 提示走私訊/管理員 DM(非公開 log),故帶完整 id;公開 log 仍維持 maskId 去識別。
      if (chatId != null && !deniedNotified.has(chatId)) {
        deniedNotified.add(chatId);
        const denyId = fromId ?? chatId;
        await ctx.reply(deniedMsg(denyId)).catch((e) => {
          logger.warn(`回覆非授權來源提示失敗:chat=${maskId(chatId)}`, e);
        });
        // 通知管理員(errorChatId 有設才發):把被擋 id + username 推給管理員,一鍵決定放不放行。
        if (config.errorChatId) {
          const uname = ctx.from?.username ? ` @${ctx.from.username}` : "";
          await ctx.telegram
            .sendMessage(
              config.errorChatId,
              `🔔 有人想用 bot 但不在白名單：id=${denyId}${uname}。放行就把這 id 加進 ALLOWED_CHAT_IDS。`,
            )
            .catch((e) => logger.warn(`通知管理員被擋來源失敗:chat=${maskId(chatId)}`, e));
        }
      }
    });
  }

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
      // reply 包 catch:使用者封鎖 bot / chat 失效時 reply 會丟例外,不能讓它掉進下面的
      // catch 對 error chat 發假的「/stats 失敗」(統計本身是成功的);但也不全吞 ——
      // 至少留 warn,發送壞掉才查得到。對齊 feed router 同款護法。
      await ctx.reply(await runStats({ storage })).catch((e) => logger.warn("/stats 回覆發送失敗", e));
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
        { text },
        {
          storage,
          expandShortUrls: config.expandShortUrls,
          onPersistError: hooks?.onPersistError,
          target,
        },
      );
      // reply 包 catch:使用者封鎖 bot / chat 失效時 reply 會丟例外,
      // 不能因此吞掉 notifyError(寫表結果才是重點)。對齊 /stats 的護法。
      // (tbvoc)收錄成功且 key 放得下 → 掛夯度按鈕,分享者一鍵下標;voc 恆不掛(kb=undefined)。
      const hot = target.hotValues;
      const kb =
        hot && result.hotKey && hotKeyFits(result.hotKey, hot)
          ? hotKeyboard(result.hotKey, hot)
          : undefined;
      await ctx.reply(result.reply, kb).catch(() => {});
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

  // 夯度按鈕點擊 → 回填該列「夯度」(tbvoc 專屬;voc target 無 hotValues 整段不註冊)。
  // callback_data = h:<idx>:<dedupKey>(key 可能含 ":" 如 https://,故 (.+) 貪婪吃到尾;idx 在前不歧義)。
  if (target.hotValues) {
    const hotValues = target.hotValues;
    bot.action(/^h:(\d+):(.+)$/, async (ctx) => {
      try {
        const idx = Number(ctx.match[1]);
        const key = ctx.match[2];
        const value = hotValues[idx];
        if (key === undefined || value === undefined) {
          await ctx.answerCbQuery("未知選項").catch(() => {});
          return;
        }
        const ok = (await storage.setHot?.(key, value)) ?? false;
        if (ok) {
          await ctx.answerCbQuery(`夯度:${value} ✓`).catch(() => {});
          // 在按鈕列把選中的標 ✅(視覺回饋,可再點換)。
          await ctx.editMessageReplyMarkup(hotKeyboard(key, hotValues, idx).reply_markup).catch(() => {});
        } else {
          // 找不到 = 多半已勾「挑」搬去待拍了。
          await ctx.answerCbQuery("這支已不在參考池(可能已挑走)").catch(() => {});
        }
      } catch (err) {
        logger.error("夯度 callback 失敗", err);
        // setHot 是冪等單格寫(同格同值,重打不寫壞)→ 暫態錯誤(429/5xx/網路)翻 persist
        // 旗標讓 drain 停在此 offset、下次 cron 重領這筆 callback 重試,夯度 tap 才不會因
        // 一次暫態故障被 ack 掉永久丟失(舊版只 notifyError,update 照 ack)。
        // 非暫態(權限/表結構等真錯)重領也沒用,維持原行為:通知後照常 ack。
        if (isTransient(err)) hooks?.onPersistError?.();
        await ctx.answerCbQuery("標記失敗").catch(() => {});
        await notifyError(`夯度 callback 失敗:${errText(err)}`);
      }
    });
  }

  // 全域兜底
  bot.catch((err, ctx) => {
    logger.error(`Telegraf 未捕捉錯誤 (update ${ctx.updateType})`, err);
  });

  return bot;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 遮蔽 Telegram id:回傳末 2 碼(不足 3 碼全遮),不外洩完整 id 到公開 log。 */
function maskId(id: number | undefined): string {
  if (id == null) return "none";
  const s = String(Math.abs(id));
  return s.length <= 2 ? "**" : `***${s.slice(-2)}`;
}
