/**
 * 釘住:drain 用的 bot 不得存在「有限的 handler 逾時牆」。
 *
 * 為什麼這條要釘 —— telegraf 的 handleUpdate 在 middleware 逾時後仍會**正常 resolve**
 * (逾時錯誤只送進被覆寫成 log-only 的 bot.catch),於是 drainLoop 看不到例外、
 * persist.failed 仍是 false、offset 照樣前進 → 那筆更新被 ack 掉但從來沒寫進表。
 *
 * 為什麼釘不變式而不是釘數字:任何有限值都會重開這個洞,只是門檻高低不同。所以這裡用
 * 行為驗證(假計時器推進 10 分鐘後 handleUpdate 是否 settle),有人改成 300000
 * 「保險一點」照樣紅。
 *
 * ⚠️ 第一格是**控制組**:同樣的探針對 telegraf 預設值必須驗出「會 settle」。少了它,
 * 下面兩格的「沒 settle」有可能只是我的探針根本沒在動(假存活)。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Telegraf } from "telegraf";
import type { Update } from "@telegraf/types";
import { DRAIN_SAFE_TELEGRAF_OPTIONS } from "../../src/shared/telegramSafety.js";
import { createBot as createShellBot } from "../../src/bot/router.js";
import { createBot as createOfBot } from "../../src/engines/of/bot/router.js";
import { MemoryStorage as ShellMemoryStorage } from "../../src/storage/memory.js";
import { MemoryStorage as OfMemoryStorage } from "../../src/engines/of/storage/memory.js";
import type { Config as ShellConfig } from "../../src/config.js";
import type { Config as OfConfig } from "../../src/engines/of/config.js";

const BASE = {
  telegramToken: "TEST:TOKEN",
  storage: "memory",
  google: null,
  errorChatId: "",
  allowedChatIds: [],
  expandShortUrls: false,
  logLevel: "info",
} as const;
const shellConfig = { ...BASE, target: "voc" } as unknown as ShellConfig;
const ofConfig = { ...BASE } as unknown as OfConfig;

const UPDATE = {
  update_id: 1,
  message: {
    message_id: 10,
    date: 0,
    chat: { id: 123, type: "private", first_name: "Pei" },
    from: { id: 9, is_bot: false, first_name: "Pei" },
    text: "https://www.tiktok.com/@u/video/1111111111 note",
  },
} as unknown as Update;

/** telegraf 的 options 在型別上是 private;測試要看的是實際建構出來的執行期值。 */
function handlerTimeoutOf(bot: unknown): number | undefined {
  return (bot as { options: { handlerTimeout?: number } }).options.handlerTimeout;
}

function withBotInfo<T extends Telegraf>(bot: T): T {
  bot.botInfo = { id: 1, is_bot: true, first_name: "bot", username: "testbot" } as typeof bot.botInfo;
  return bot;
}

/** 掛一個永不 resolve 的 middleware,回答「推進 ms 之後 handleUpdate settle 了嗎」。 */
async function settlesWithin(bot: Telegraf, ms: number): Promise<boolean> {
  bot.catch(() => {}); // 與兩支 router 同款:只吞不 rethrow(這正是讓逾時變無聲的原因)
  bot.use(() => new Promise<void>(() => {})); // 永遠不完成
  let settled = false;
  const mark = () => {
    settled = true;
  };
  void bot.handleUpdate(UPDATE).then(mark, mark);
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}

const TEN_MINUTES = 10 * 60 * 1000; // 遠超過 telegraf 預設的 90 秒

afterEach(() => {
  vi.useRealTimers();
});

describe("drain 不得有有限的 telegraf handler 逾時牆", () => {
  it("控制組:telegraf 預設(90 秒)在同一支探針下會 settle —— 證明探針真的驗得出來", async () => {
    vi.useFakeTimers();
    const bot = withBotInfo(new Telegraf("TEST:TOKEN")); // 不帶 options = 預設 90000
    expect(handlerTimeoutOf(bot)).toBe(90_000);
    expect(await settlesWithin(bot, TEN_MINUTES)).toBe(true); // ← 這就是靜默 ack 的那條路
  });

  it("帶共用常數:推進十分鐘後 handleUpdate 仍未 settle(沒有牆)", async () => {
    vi.useFakeTimers();
    const bot = withBotInfo(new Telegraf("TEST:TOKEN", DRAIN_SAFE_TELEGRAF_OPTIONS));
    expect(await settlesWithin(bot, TEN_MINUTES)).toBe(false);
  });

  // 兩支 router 一起釘是刻意的:姊妹案例(collect.yml 的 notify-cancelled)就是
  // 「一邊修好、另一邊漂著」漂了半年沒人發現。
  const routers: [string, () => Telegraf][] = [
    ["shell(voc/tbvoc)", () => createShellBot(shellConfig, new ShellMemoryStorage())],
    ["of 引擎", () => createOfBot(ofConfig, new OfMemoryStorage())],
  ];
  for (const [name, make] of routers) {
    it(`${name} 建出的 bot 沒有有限牆`, () => {
      expect(Number.isFinite(handlerTimeoutOf(make()))).toBe(false);
    });
  }
});
