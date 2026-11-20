/**
 * of / ofgay 與 voc/tbvoc 共用 shared/drainLoop.ts 的迴圈與回條;of 自己的 router/ingest
 * 要把「寫入/重複/失敗未寫入」回報進同一個 side-channel。這裡用 of 真的 createBot 驗證:
 *   - B:去重索引讀取丟非暫態錯 → 被確認收走但沒寫進暫存區 → 摘要分項、exit 非 0
 *   - A:確認那次 getUpdates 失敗 → 印「已處理 N 筆、M 筆的確認結果不明」、仍 reject
 *   - 沒跑:第一次 getUpdates 就失敗 → 已處理 0 筆
 * of drain.ts 是 entry(import 即執行),所以走它用的同一組共用函式。全為合成資料。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "@telegraf/types";
import { logger } from "@pei760730/collector-core";
import { createBot } from "../../src/engines/of/bot/router.js";
import { MemoryStorage } from "../../src/engines/of/storage/memory.js";
import type { Config } from "../../src/engines/of/config.js";
import {
  drainHooks,
  drainWithTally,
  logDrainSummary,
  exitCodeFor,
  type PersistFlag,
} from "../../src/shared/drainLoop.js";

const config: Config = {
  telegramToken: "TEST:TOKEN",
  storage: "memory",
  google: null,
  errorChatId: "",
  allowedChatIds: [],
  expandShortUrls: false,
  logLevel: "info",
};

const origCallApi = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function () {
  return {} as never;
} as typeof Telegram.prototype.callApi;
afterAll(() => {
  Telegram.prototype.callApi = origCallApi;
});

const logged: string[] = [];
beforeEach(() => {
  logged.length = 0;
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation((m: string) => {
      logged.push(m);
    });
  }
});
afterEach(() => vi.restoreAllMocks());

const link = (n: number) => `https://www.tiktok.com/@synthetic_user/video/70000000000000000${n}`;
function textUpdate(id: number, text: string): Update {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 0,
      chat: { id: 123, type: "private", first_name: "Synthetic" },
      from: { id: 9, is_bot: false, first_name: "Synthetic" },
      text,
    },
  } as unknown as Update;
}
const conflict409 = () =>
  Object.assign(new Error("409: Conflict (synthetic)"), { response: { ok: false, error_code: 409 } });

function harness(storage: MemoryStorage, script: Array<Update[] | Error>) {
  const persist: PersistFlag = { failed: false };
  const bot = createBot(config, storage as never, drainHooks(persist));
  bot.botInfo = { id: 1, is_bot: true, first_name: "bot", username: "testbot" } as typeof bot.botInfo;
  const offsets: number[] = [];
  const fake = {
    telegram: {
      async getUpdates(_t: number, _l: number, offset: number) {
        offsets.push(offset);
        const next = script.shift() ?? [];
        if (next instanceof Error) throw next;
        return next;
      },
    },
    handleUpdate: (u: Update) => bot.handleUpdate(u),
  };
  return { persist, fake, offsets };
}
const summaryLines = () => logged.filter((l) => l.includes("已處理"));

describe("of 引擎:共用迴圈回條", () => {
  it("B:去重索引讀取丟非暫態錯 → 照舊 ack,但摘要列「失敗未寫入」且 exit 非 0", async () => {
    class IndexBroken extends MemoryStorage {
      override async videoIdIndex(): Promise<never> {
        throw Object.assign(new Error("Unable to parse range (synthetic non-transient 400)"), { code: 400 });
      }
    }
    const storage = new IndexBroken();
    const h = harness(storage, [[textUpdate(11, link(3)), textUpdate(12, link(4)), textUpdate(13, link(5))]]);
    const { result, tally } = await drainWithTally(h.fake as never, h.persist, "暫存區");
    logDrainSummary(result, tally);

    expect(h.offsets).toEqual([0, 14]); // 確認政策不變:3 則全 ack
    expect(result).toEqual({ processed: 3, aborted: false });
    const lines = summaryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("已處理 3 筆");
    expect(lines[0]).toContain("寫入 0");
    expect(lines[0]).toContain("失敗未寫入 3");
    expect(exitCodeFor(result, tally)).not.toBe(0);
  });

  it("寫入 / 重複 / 其他 分項正確,全正常 exit 0", async () => {
    const storage = new MemoryStorage();
    const h = harness(storage, [
      [textUpdate(1, link(1)), textUpdate(2, link(1)), textUpdate(3, "沒有連結")],
    ]);
    const { result, tally } = await drainWithTally(h.fake as never, h.persist, "暫存區");
    logDrainSummary(result, tally);
    const lines = summaryLines();
    expect(lines[0]).toContain("drain 完成:已處理 3 筆更新");
    expect(lines[0]).toContain("寫入 1");
    expect(lines[0]).toContain("重複 1");
    expect(lines[0]).toContain("失敗未寫入 0");
    expect(lines[0]).toContain("其他 1");
    expect(exitCodeFor(result, tally)).toBe(0);
  });

  it("A:確認那次 getUpdates 失敗 → 印「2 筆的確認結果不明」並照舊 reject;重跑不加倍", async () => {
    const storage = new MemoryStorage();
    const h = harness(storage, [[textUpdate(1, link(1)), textUpdate(2, link(2))], conflict409()]);
    await expect(drainWithTally(h.fake as never, h.persist, "暫存區")).rejects.toThrow("409");
    const lines = summaryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("已處理 2 筆");
    expect(lines[0]).toContain("2 筆的確認結果不明");
    expect(lines[0]).toContain("去重通常會擋");
    expect(lines[0]).not.toContain("不會加倍");

    // 下一輪重領同批:不加倍
    const h2 = harness(storage, [[textUpdate(1, link(1)), textUpdate(2, link(2))]]);
    const again = await drainWithTally(h2.fake as never, h2.persist, "暫存區");
    expect(again.tally.duplicate).toBe(2);
    expect(again.tally.saved).toBe(0);
    expect(await storage.videoIdIndex()).toHaveProperty("size", 2);
  });

  it("多批:批 1 有「已確認收走但沒寫入」,批 2 的確認失敗 → 中斷行兩件事都帶", async () => {
    class FirstIndexBroken extends MemoryStorage {
      n = 0;
      override async videoIdIndex(): Promise<Awaited<ReturnType<MemoryStorage["videoIdIndex"]>>> {
        this.n += 1;
        if (this.n === 1) {
          throw Object.assign(new Error("Unable to parse range (synthetic non-transient 400)"), { code: 400 });
        }
        return super.videoIdIndex();
      }
    }
    const h = harness(new FirstIndexBroken(), [[textUpdate(1, link(1))], [textUpdate(2, link(2))], conflict409()]);
    await expect(drainWithTally(h.fake as never, h.persist, "暫存區")).rejects.toThrow("409");
    const lines = summaryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("drain 中斷");
    expect(lines[0]).toContain("1 筆的確認結果不明");
    expect(lines[0]).toContain("1 筆失敗未寫入、已被確認收走、不會重領");
    expect(lines[0]).toContain("需重新操作(連結請重貼、夯度請重按)");
  });

  it("raw_ 同日重領(findRawReplay 命中)與已核准閘門命中,都記成「重複」而不是「其他」", async () => {
    const unsupported = "https://synthetic.example.invalid/some/page";
    const storage = new MemoryStorage([], { approvedUrls: [link(9)] });
    const h = harness(storage, [
      [textUpdate(1, unsupported), textUpdate(2, unsupported), textUpdate(3, link(9))],
    ]);
    const { result, tally } = await drainWithTally(h.fake as never, h.persist, "暫存區");
    logDrainSummary(result, tally);
    expect(tally.saved).toBe(1); // 第一次 raw_ 寫入
    expect(tally.duplicate).toBe(2); // raw_ 重領 + 已核准閘門
    const line = summaryLines()[0]!;
    expect(line).toContain("寫入 1");
    expect(line).toContain("重複 2");
    expect(line).toContain("其他 0");
  });

  it("沒跑:第一次 getUpdates 就失敗 → 已處理 0 筆,且不含「確認結果不明」", async () => {
    const h = harness(new MemoryStorage(), [conflict409()]);
    await expect(drainWithTally(h.fake as never, h.persist, "暫存區")).rejects.toThrow("409");
    const lines = summaryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("已處理 0 筆");
    expect(lines[0]).not.toContain("確認結果不明");
  });
});
