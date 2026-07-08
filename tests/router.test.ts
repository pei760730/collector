import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "@telegraf/types";
import { createBot } from "../src/bot/router.js";
import { MemoryStorage } from "../src/storage/memory.js";
import type { Config } from "../src/config.js";

function memoryConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegramToken: "TEST:TOKEN",
    storage: "memory",
    google: null, // memory 乾跑:pool=null,不碰真表
    errorChatId: "",
    allowedChatIds: [], // 預設不限制(乾跑);白名單測試在下方另傳
    expandShortUrls: false,
    logLevel: "info",
    ...overrides,
  };
}

// telegraf 的 handleUpdate 每筆更新會 new 一個 Telegram 實例(telegraf.js),
// 所以攔截點必須在 prototype.callApi(所有實例共用),不能 stub bot.telegram。
const sent: string[] = [];
const origCallApi = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function (method: string, payload?: { text?: string }) {
  if (method === "sendMessage" && payload?.text) sent.push(payload.text);
  return {} as never;
} as typeof Telegram.prototype.callApi;
afterAll(() => {
  Telegram.prototype.callApi = origCallApi;
});
beforeEach(() => {
  sent.length = 0;
});

function makeBot(storage: MemoryStorage) {
  const bot = createBot(memoryConfig(), storage);
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: "bot",
    username: "testbot",
  } as typeof bot.botInfo;
  return bot;
}

function photoWithCaption(caption: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: 0,
      chat: { id: 123, type: "private", first_name: "Pei" },
      from: { id: 9, is_bot: false, first_name: "Pei" },
      photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }],
      caption,
    },
  } as unknown as Update;
}

describe("router caption routing", () => {
  it("媒體 caption 裡的連結 → 走 collect 寫入(不再靜默丟失)", async () => {
    const storage = new MemoryStorage();
    const bot = makeBot(storage);

    await bot.handleUpdate(
      photoWithCaption("https://www.tiktok.com/@u/video/7234567890 轉傳的"),
    );

    const all = await storage.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.平台).toBe("tiktok");
    expect(all[0]!.連結).toBe("https://www.tiktok.com/@u/video/7234567890");
    expect(sent.some((t) => t.includes("已收進參考池"))).toBe(true);
    expect(sent.some((t) => t.includes("轉傳的"))).toBe(true); // 備註顯示在回覆
  });

  it("媒體 caption 沒有連結 → 回提示、不寫入(有回覆即非靜默)", async () => {
    const storage = new MemoryStorage();
    const bot = makeBot(storage);

    await bot.handleUpdate(photoWithCaption("純粹一張圖沒連結"));

    expect(await storage.readAll()).toHaveLength(0);
    expect(sent.some((t) => t.includes("看不懂"))).toBe(true);
  });
});

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

function makeBotWith(storage: MemoryStorage, allowedChatIds: number[]) {
  const bot = createBot(memoryConfig({ allowedChatIds }), storage);
  bot.botInfo = { id: 1, is_bot: true, first_name: "bot", username: "testbot" } as typeof bot.botInfo;
  return bot;
}

describe("router 來源白名單(公開防護)", () => {
  const link = "https://www.tiktok.com/@u/video/7234567890";

  it("名單內的 chat → 正常收錄", async () => {
    const storage = new MemoryStorage();
    const bot = makeBotWith(storage, [555]);
    await bot.handleUpdate(textFrom(555, 999, link));
    expect(await storage.readAll()).toHaveLength(1);
  });

  it("不在名單的陌生 chat/from → 丟棄、不寫入,但回一句無權限提示(含自己的 id)", async () => {
    const storage = new MemoryStorage();
    const bot = makeBotWith(storage, [555]);
    await bot.handleUpdate(textFrom(424242, 717171, link));
    expect(await storage.readAll()).toHaveLength(0); // 沒寫進池
    expect(sent).toHaveLength(1); // errorChatId 未設 → 只回被擋者、不通知管理員
    expect(sent[0]).toContain("你沒有使用權限"); // 不再靜默
    expect(sent[0]).toContain("717171"); // 回顯發訊者自己的 id(from.id),方便截圖給管理員自助上白名單
  });

  it("errorChatId 有設 → 被擋時同時通知管理員(含被擋 id)", async () => {
    const storage = new MemoryStorage();
    const bot = createBot(
      memoryConfig({ allowedChatIds: [555], errorChatId: "660156312" }),
      storage,
    );
    bot.botInfo = { id: 1, is_bot: true, first_name: "bot", username: "testbot" } as typeof bot.botInfo;
    await bot.handleUpdate(textFrom(424242, 717171, link));
    // 兩則:回被擋者(含其 id)+ 通知管理員(🔔 開頭、含被擋 id)。
    expect(sent).toHaveLength(2);
    expect(sent.some((t) => t.startsWith("🔔") && t.includes("717171"))).toBe(true);
  });

  it("同一個被擋 chat 連發多則 → 提示只回一次(防灌爆)", async () => {
    const storage = new MemoryStorage();
    const bot = makeBotWith(storage, [555]);
    await bot.handleUpdate(textFrom(424242, 717171, link));
    await bot.handleUpdate(textFrom(424242, 717171, `${link}2`));
    await bot.handleUpdate(textFrom(424242, 717171, "/start"));
    expect(await storage.readAll()).toHaveLength(0); // 全部沒寫進池
    expect(sent).toHaveLength(1); // 提示只有第一則回,後續靜默丟棄
  });

  it("from.id 命中(私訊以外場景)也放行", async () => {
    const storage = new MemoryStorage();
    const bot = makeBotWith(storage, [999]);
    await bot.handleUpdate(textFrom(-100200300, 999, link)); // chat 是某群、但 from 是我
    expect(await storage.readAll()).toHaveLength(1);
  });
});
