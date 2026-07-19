import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Telegram, Telegraf } from "telegraf";
import type { Update } from "@telegraf/types";
import {
  createErrorNotifier,
  deniedMessage,
  errText,
  installSourceAllowlist,
  maskId,
} from "../../src/shared/telegramSafety.js";
import { logger } from "../../src/utils/logger.js";

interface SentMessage {
  chatId: string | number | undefined;
  text: string;
}

const sent: SentMessage[] = [];
const originalCallApi = Telegram.prototype.callApi;
const captureCallApi = async function (
  method: string,
  payload?: { chat_id?: string | number; text?: string },
) {
  if (method === "sendMessage" && payload?.text) {
    sent.push({ chatId: payload.chat_id, text: payload.text });
  }
  return {} as never;
} as typeof Telegram.prototype.callApi;

Telegram.prototype.callApi = captureCallApi;
afterAll(() => {
  Telegram.prototype.callApi = originalCallApi;
});
beforeEach(() => {
  sent.length = 0;
  Telegram.prototype.callApi = captureCallApi;
  vi.restoreAllMocks();
});

function textUpdate(chatId: number, fromId: number, updateId = 1): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chatId, type: "private", first_name: "X" },
      from: { id: fromId, is_bot: false, first_name: "X", username: "guest" },
      text: "hello",
    },
  } as unknown as Update;
}

function guardedBot(allowedChatIds: number[], errorChatId = "") {
  const bot = new Telegraf("TEST:TOKEN");
  installSourceAllowlist(bot, { allowedChatIds, errorChatId });
  const handled = { count: 0 };
  bot.use(async () => {
    handled.count += 1;
  });
  bot.botInfo = {
    id: 1,
    is_bot: true,
    first_name: "bot",
    username: "testbot",
  } as typeof bot.botInfo;
  return { bot, handled };
}

describe("installSourceAllowlist", () => {
  it("空名單不限制，更新會交給後續 handler", async () => {
    const { bot, handled } = guardedBot([]);

    await bot.handleUpdate(textUpdate(424242, 717171));

    expect(handled.count).toBe(1);
  });

  it("chat.id 或 from.id 任一命中就放行", async () => {
    const { bot, handled } = guardedBot([555, 999]);

    await bot.handleUpdate(textUpdate(555, 111, 1));
    await bot.handleUpdate(textUpdate(-100200300, 999, 2));

    expect(handled.count).toBe(2);
    expect(sent).toHaveLength(0);
  });

  it("陌生來源不進 handler；私訊回完整本人 id，公開 log 只留遮蔽 id", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { bot, handled } = guardedBot([555]);

    await bot.handleUpdate(textUpdate(424242, 717171));

    expect(handled.count).toBe(0);
    expect(sent).toEqual([
      {
        chatId: 424242,
        text: "你沒有使用權限，請聯絡管理員。\n你的 ID：717171（把這串傳給管理員加進白名單即可）",
      },
    ]);
    expect(String(warn.mock.calls[0]?.[0])).toContain("chat=***42 from=***71");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("424242");
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("717171");
  });

  it("設 errorChatId 時同步通知管理員，沿用 PR #78 對齊的全形標點", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { bot } = guardedBot([555], "999000999");

    await bot.handleUpdate(textUpdate(424242, 717171));

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      chatId: "999000999",
      text: "🔔 有人想用 bot 但不在白名單：id=717171 @guest。放行就把這 id 加進 ALLOWED_CHAT_IDS。",
    });
  });

  it("同一個被擋 chat 連發多則只提示一次，但每筆都不進 handler", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { bot, handled } = guardedBot([555]);

    await bot.handleUpdate(textUpdate(424242, 717171, 1));
    await bot.handleUpdate(textUpdate(424242, 717171, 2));
    await bot.handleUpdate(textUpdate(424242, 717171, 3));

    expect(handled.count).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it("被擋者回覆失敗仍吞掉例外並留下遮蔽 warn", async () => {
    const failure = new Error("Forbidden");
    Telegram.prototype.callApi = vi.fn(async () => {
      throw failure;
    }) as typeof Telegram.prototype.callApi;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const { bot, handled } = guardedBot([555]);

    await expect(bot.handleUpdate(textUpdate(424242, 717171))).resolves.toBeUndefined();

    expect(handled.count).toBe(0);
    expect(warn).toHaveBeenCalledWith("回覆非授權來源提示失敗:chat=***42", failure);
  });
});

describe("createErrorNotifier", () => {
  it("未設 errorChatId 時 no-op；有設時加 🐞 前綴送達指定 chat", async () => {
    const bot = new Telegraf("TEST:TOKEN");

    await createErrorNotifier(bot, "")("不該送");
    await createErrorNotifier(bot, "999000999")("寫入失敗");

    expect(sent).toEqual([{ chatId: "999000999", text: "🐞 寫入失敗" }]);
  });

  it("通知失敗不外拋，改記 logger.error", async () => {
    const failure = new Error("Telegram down");
    Telegram.prototype.callApi = vi.fn(async () => {
      throw failure;
    }) as typeof Telegram.prototype.callApi;
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const bot = new Telegraf("TEST:TOKEN");

    await expect(createErrorNotifier(bot, "999000999")("寫入失敗")).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith("通知 error chat 失敗", failure);
  });
});

describe("Telegram 安全純函式", () => {
  it("errText 保留 Error.message，非 Error 走 String", () => {
    expect(errText(new Error("boom"))).toBe("boom");
    expect(errText({ code: 500 })).toBe("[object Object]");
  });

  it("maskId 處理 undefined、短 id、負群組 id，永不輸出完整長 id", () => {
    expect(maskId(undefined)).toBe("none");
    expect(maskId(9)).toBe("**");
    expect(maskId(-100200300)).toBe("***00");
  });

  it("deniedMessage 的完整 id 只供私訊提示，並釘住全形標點", () => {
    expect(deniedMessage()).toBe("你沒有使用權限，請聯絡管理員");
    expect(deniedMessage(717171)).toBe(
      "你沒有使用權限，請聯絡管理員。\n你的 ID：717171（把這串傳給管理員加進白名單即可）",
    );
  });
});
