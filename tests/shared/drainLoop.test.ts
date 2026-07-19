/**
 * shell/of 共用 drain 的 at-least-once 紅線：
 * offset 只在成功處理後前進；persist 失敗停在當前 offset、不 ack、回 aborted；
 * aborted 對映 exit 2，正常對映 exit 0。
 */
import { describe, it, expect } from "vitest";
import type { Update } from "@telegraf/types";
import {
  drainUpdates,
  exitCodeFor,
  type DrainableBot,
  type PersistFlag,
} from "../../src/shared/drainLoop.js";

function upd(id: number): Update {
  return { update_id: id } as Update;
}

/**
 * 假 bot:getUpdates 依 offset 回「還沒 ack 的更新」(模擬 Telegram 累積語意；
 * 一次只回 1 筆，逼迴圈每筆都帶新 offset 重新領)。
 */
function makeFakeBot(opts: {
  updates: Update[];
  failOn?: Set<number>;
  persist: PersistFlag;
  throwOn?: Set<number>;
}) {
  const offsetsSeen: number[] = [];
  const handled: number[] = [];
  const bot: DrainableBot = {
    telegram: {
      async getUpdates(_timeout, _limit, offset, _allowed) {
        offsetsSeen.push(offset);
        return opts.updates.filter((u) => u.update_id >= offset).slice(0, 1);
      },
    },
    async handleUpdate(u) {
      handled.push(u.update_id);
      if (opts.throwOn?.has(u.update_id)) throw new Error("路由層例外");
      if (opts.failOn?.has(u.update_id)) opts.persist.failed = true;
    },
  };
  return { bot, offsetsSeen, handled };
}

describe("drainUpdates:abort / ack 語意", () => {
  it("全部成功 → offset 逐筆推進、processed=全數、aborted=false", async () => {
    const persist: PersistFlag = { failed: false };
    const { bot, offsetsSeen } = makeFakeBot({
      updates: [upd(10), upd(11), upd(12)],
      persist,
    });
    const result = await drainUpdates(bot, persist, "測試目的地");
    expect(result).toEqual({ processed: 3, aborted: false });
    expect(offsetsSeen).toEqual([0, 11, 12, 13]);
  });

  it("中途某筆 persist 失敗 → 停在該 offset、不 ack、回 aborted", async () => {
    const persist: PersistFlag = { failed: false };
    const { bot, offsetsSeen, handled } = makeFakeBot({
      updates: [upd(10), upd(11), upd(12)],
      failOn: new Set([11]),
      persist,
    });
    const result = await drainUpdates(bot, persist, "測試目的地");
    expect(result.aborted).toBe(true);
    expect(result.processed).toBe(1); // 只有 10 成功
    expect(handled).toEqual([10, 11]); // 12 沒被處理(提前結束)
    // 失敗筆 11 不前進 offset；中止後不再呼叫 getUpdates，所以 11 未被 ack。
    expect(offsetsSeen).toEqual([0, 11]);
  });

  it("路由層例外(非寫入失敗)→ 記錄後跳過、照常 ack、不 abort", async () => {
    const persist: PersistFlag = { failed: false };
    const { bot, handled } = makeFakeBot({
      updates: [upd(10), upd(11)],
      throwOn: new Set([10]),
      persist,
    });
    const result = await drainUpdates(bot, persist, "測試目的地");
    expect(result.aborted).toBe(false);
    expect(result.processed).toBe(2); // 例外筆也算處理(ack 掉,重領也沒用)
    expect(handled).toEqual([10, 11]);
  });

  it("每次呼叫各自持有 offset/result 狀態，不受前一輪 aborted 串味", async () => {
    const persist: PersistFlag = { failed: false };
    const first = makeFakeBot({
      updates: [upd(20)],
      failOn: new Set([20]),
      persist,
    });
    expect(await drainUpdates(first.bot, persist, "測試目的地")).toEqual({
      processed: 0,
      aborted: true,
    });

    const second = makeFakeBot({ updates: [upd(30)], persist });
    expect(await drainUpdates(second.bot, persist, "測試目的地")).toEqual({
      processed: 1,
      aborted: false,
    });
    expect(second.offsetsSeen).toEqual([0, 31]);
  });
});

describe("exitCodeFor:aborted 不得回 0(collect.yml 紅燈是底線告警)", () => {
  it("aborted → 2", () => {
    expect(exitCodeFor({ processed: 1, aborted: true })).toBe(2);
  });

  it("正常完成 → 0", () => {
    expect(exitCodeFor({ processed: 3, aborted: false })).toBe(0);
    expect(exitCodeFor({ processed: 0, aborted: false })).toBe(0);
  });
});
