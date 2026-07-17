/**
 * 夯度 inline 按鈕鏈(tbvoc target;port 自 clip-collector tests/router.test.ts 夯度段)。
 * 共用路由行為(caption/白名單/stats)由 tests/router.test.ts 以 voc target 鎖住;
 * 本檔只鎖 tbvoc 專屬的按鈕掛載 + callback 回填 + 純函式,並鎖「voc 不掛按鈕」的零變更面。
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "@telegraf/types";
import { createBot, hotCbData, hotKeyFits, hotKeyboard } from "../src/bot/router.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { TBVOC_TARGET, TBVOC_HOT_VALUES, VOC_TARGET } from "../src/targets.js";
import type { RefRow } from "../src/types.js";
import { dedupKey } from "../src/pipeline/index.js";
import type { Config } from "../src/config.js";

const HOT = TBVOC_HOT_VALUES;

function memoryConfig(overrides: Partial<Config> = {}): Config {
  return {
    target: "tbvoc",
    telegramToken: "TEST:TOKEN",
    storage: "memory",
    google: null,
    errorChatId: "",
    allowedChatIds: [],
    expandShortUrls: false,
    logLevel: "info",
    ...overrides,
  };
}

// 攔截點必須在 Telegram.prototype.callApi(handleUpdate 每筆 new Telegram;CLAUDE.md 第三層)。
const sent: string[] = [];
const sentMarkups: unknown[] = [];
const cbAnswers: string[] = [];
const editedMarkups: unknown[] = [];
const origCallApi = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function (
  method: string,
  payload?: { text?: string; reply_markup?: unknown },
) {
  if (method === "sendMessage" && payload?.text) {
    sent.push(payload.text);
    sentMarkups.push(payload.reply_markup);
  }
  if (method === "answerCallbackQuery") cbAnswers.push((payload as { text?: string })?.text ?? "");
  if (method === "editMessageReplyMarkup") editedMarkups.push(payload?.reply_markup);
  return {} as never;
} as typeof Telegram.prototype.callApi;
afterAll(() => {
  Telegram.prototype.callApi = origCallApi;
});
beforeEach(() => {
  sent.length = 0;
  sentMarkups.length = 0;
  cbAnswers.length = 0;
  editedMarkups.length = 0;
});

function makeBot(storage: MemoryStorage) {
  const bot = createBot(memoryConfig(), storage, undefined, TBVOC_TARGET);
  bot.botInfo = { id: 1, is_bot: true, first_name: "bot", username: "testbot" } as typeof bot.botInfo;
  return bot;
}

function textFrom(chatId: number, fromId: number, text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 11,
      date: 0,
      chat: { id: chatId, type: "private", first_name: "X" },
      from: { id: fromId, is_bot: false, first_name: "X" },
      text,
    },
  } as unknown as Update;
}

function callbackUpdate(data: string): Update {
  return {
    update_id: 2,
    callback_query: {
      id: "cb1",
      from: { id: 9, is_bot: false, first_name: "Pei" },
      chat_instance: "ci",
      data,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 123, type: "private", first_name: "Pei" },
        from: { id: 1, is_bot: true, first_name: "bot" },
        text: "已收進參考池",
      },
    },
  } as unknown as Update;
}

function seedRow(連結: string): RefRow {
  return { 平台: "tiktok", 連結, 挑: "", 加入日期: "2026-06-26", 夯度: "" };
}

describe("router 夯度 callback(tbvoc)", () => {
  const link = "https://www.tiktok.com/@u/video/7234567890";

  it("(a) 正常點按 → setHot(key,值) 被呼叫、回「夯度:値 ✓」、按鈕列標 ✅", async () => {
    const storage = new MemoryStorage([seedRow(link)]);
    const setHot = vi.spyOn(storage, "setHot");
    const bot = makeBot(storage);
    const key = dedupKey(link);
    const idx = 0; // 夯爆了

    await bot.handleUpdate(callbackUpdate(hotCbData(idx, key)));

    expect(setHot).toHaveBeenCalledWith(key, HOT[idx]);
    expect(cbAnswers.some((t) => t === `夯度:${HOT[idx]} ✓`)).toBe(true);
    expect((await storage.readAll())[0]!.夯度).toBe(HOT[idx]);
    const mk = editedMarkups[0] as { inline_keyboard: { text: string }[][] };
    expect(mk.inline_keyboard[0]![idx]!.text).toBe(`✅ ${HOT[idx]}`);
  });

  it("(b) setHot 回 false(已挑走 / 不在池)→ 回「這支已不在參考池」、不重繪按鈕", async () => {
    const storage = new MemoryStorage(); // 空池 → 找不到 key
    const bot = makeBot(storage);

    await bot.handleUpdate(callbackUpdate(hotCbData(1, dedupKey(link))));

    expect(cbAnswers.some((t) => t.includes("這支已不在參考池"))).toBe(true);
    expect(editedMarkups).toHaveLength(0);
  });

  it("(c) idx 超界 → 回「未知選項」且不呼叫 setHot", async () => {
    const storage = new MemoryStorage([seedRow(link)]);
    const setHot = vi.spyOn(storage, "setHot");
    const bot = makeBot(storage);

    await bot.handleUpdate(callbackUpdate(`h:${HOT.length}:${dedupKey(link)}`));

    expect(setHot).not.toHaveBeenCalled();
    expect(cbAnswers.some((t) => t === "未知選項")).toBe(true);
  });

  it("(d) hotKeyFits 對超長 path key 回 false → 不掛按鈕(收錄回覆無 inline keyboard)", async () => {
    const storage = new MemoryStorage();
    const bot = makeBot(storage);
    const longUrl = `https://example.com/${"a".repeat(80)}`;
    expect(hotKeyFits(dedupKey(longUrl), HOT)).toBe(false);

    await bot.handleUpdate(textFrom(0, 0, `${longUrl} note`));
    expect(await storage.readAll()).toHaveLength(1);
    expect(sent.some((t) => t.includes("已收進參考池"))).toBe(true);
    expect(sentMarkups).toHaveLength(1);
    expect(sentMarkups[0]).toBeUndefined();
  });

  it("(d′) 正常長度 key → 收錄回覆有掛 inline keyboard(對照組)", async () => {
    const storage = new MemoryStorage();
    const bot = makeBot(storage);
    await bot.handleUpdate(textFrom(0, 0, `${link} note`));
    expect(sentMarkups).toHaveLength(1);
    const mk = sentMarkups[0] as { inline_keyboard?: unknown[] } | undefined;
    expect(mk?.inline_keyboard).toBeTruthy();
  });

  it("(e) setHot 丟「暫態」錯誤 → 翻 onPersistError(drain 停在 offset、下次重領;setHot 冪等可重試)", async () => {
    const storage = new MemoryStorage([seedRow(link)]);
    const transient = new Error("rate limit") as Error & { code: number };
    transient.code = 429;
    vi.spyOn(storage, "setHot").mockRejectedValue(transient);
    let persistFailed = false;
    const bot = createBot(
      memoryConfig(),
      storage,
      { onPersistError: () => (persistFailed = true) },
      TBVOC_TARGET,
    );
    bot.botInfo = { id: 1, is_bot: true, first_name: "bot", username: "testbot" } as typeof bot.botInfo;

    await bot.handleUpdate(callbackUpdate(hotCbData(0, dedupKey(link))));

    expect(persistFailed).toBe(true); // 夯度 tap 不因暫態故障被 ack 掉永久丟失
    expect(cbAnswers.some((t) => t === "標記失敗")).toBe(true);
  });

  it("(e′) setHot 丟「非暫態」錯誤 → 不翻 onPersistError(重領也沒用,照常 ack)", async () => {
    const storage = new MemoryStorage([seedRow(link)]);
    vi.spyOn(storage, "setHot").mockRejectedValue(new Error("表結構壞了(非暫態)"));
    let persistFailed = false;
    const bot = createBot(
      memoryConfig(),
      storage,
      { onPersistError: () => (persistFailed = true) },
      TBVOC_TARGET,
    );
    bot.botInfo = { id: 1, is_bot: true, first_name: "bot", username: "testbot" } as typeof bot.botInfo;

    await bot.handleUpdate(callbackUpdate(hotCbData(0, dedupKey(link))));

    expect(persistFailed).toBe(false);
    expect(cbAnswers.some((t) => t === "標記失敗")).toBe(true);
  });

  it("(voc 零變更鎖)voc target 收錄回覆不掛按鈕、不註冊 callback", async () => {
    const storage = new MemoryStorage();
    const bot = createBot(memoryConfig({ target: "voc" }), storage, undefined, VOC_TARGET);
    bot.botInfo = { id: 1, is_bot: true, first_name: "bot", username: "testbot" } as typeof bot.botInfo;

    await bot.handleUpdate(textFrom(0, 0, `${link} note`));
    expect(sentMarkups).toHaveLength(1);
    expect(sentMarkups[0]).toBeUndefined(); // 無 reply_markup = 與既有 short-video-bot 行為一致

    const setHot = vi.spyOn(storage, "setHot");
    await bot.handleUpdate(callbackUpdate(hotCbData(0, dedupKey(link))));
    expect(setHot).not.toHaveBeenCalled(); // 沒有 action handler,callback 靜默(bot.catch 兜底)
    expect(cbAnswers).toHaveLength(0);
  });
});

describe("夯度純函式單元測", () => {
  it("hotCbData 格式 = h:<idx>:<key>", () => {
    expect(hotCbData(0, "tiktok:123")).toBe("h:0:tiktok:123");
    expect(hotCbData(2, "https://x/y")).toBe("h:2:https://x/y");
  });

  it("hotKeyFits:短 key 放得下、超長 key 放不下(64 bytes 上限)", () => {
    expect(hotKeyFits("tiktok:7234567890", HOT)).toBe(true);
    expect(hotKeyFits("a".repeat(80), HOT)).toBe(false);
  });

  it("hotKeyboard:一排 HOT 顆,chosen 該顆標 ✅、其餘原樣", () => {
    const mk = hotKeyboard("tiktok:1", HOT, 1) as unknown as {
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    const row = mk.reply_markup.inline_keyboard[0]!;
    expect(row).toHaveLength(HOT.length);
    expect(row[1]!.text).toBe(`✅ ${HOT[1]}`);
    expect(row[0]!.text).toBe(HOT[0]);
    expect(row[0]!.callback_data).toBe(hotCbData(0, "tiktok:1"));
  });

  it("hotKeyboard 預設 chosen=-1 → 都不標 ✅", () => {
    const mk = hotKeyboard("tiktok:1", HOT) as unknown as {
      reply_markup: { inline_keyboard: { text: string }[][] };
    };
    for (const b of mk.reply_markup.inline_keyboard[0]!) {
      expect(b.text.startsWith("✅")).toBe(false);
    }
  });
});
