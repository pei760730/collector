/**
 * shell/of 共用 drain 的 at-least-once 紅線：
 * offset 只在成功處理後前進；persist 失敗停在當前 offset、不 ack、回 aborted；
 * aborted 對映 exit 2，正常對映 exit 0。
 */
import { describe, it, expect } from "vitest";
import type { Update } from "@telegraf/types";
import {
  drainHooks,
  drainUpdates,
  exitCodeFor,
  newDrainTally,
  type DrainableBot,
  type PersistFlag,
  type UpdateOutcome,
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
  /** 每筆處理時模擬 handler 經 hooks 回報的去向。 */
  outcomes?: Map<number, UpdateOutcome[]>;
}) {
  const offsetsSeen: number[] = [];
  const handled: number[] = [];
  const bot: DrainableBot = {
    telegram: {
      async getUpdates(_timeout, _limit, offset, _allowed) {
        offsetsSeen.push(offset);
        // 2026-08-01 M5 回填:ack off-by-one(offset 少 +1)會讓同一批被永久
        // 重領——真實症狀是測試 worker 吃到 heap-OOM 而不是斷言紅。這裡把
        // 「offset 卡住」直接變成可讀的失敗訊息。
        if (offsetsSeen.filter((o) => o === offset).length > 3) {
          throw new Error(
            `offset ${offset} 重複領取超過 3 次 — ack off-by-one?(offset 必須是 last update_id + 1)`,
          );
        }
        return opts.updates.filter((u) => u.update_id >= offset).slice(0, 1);
      },
    },
    async handleUpdate(u) {
      handled.push(u.update_id);
      const hooks = drainHooks(opts.persist);
      for (const o of opts.outcomes?.get(u.update_id) ?? []) hooks.onOutcome(o);
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

describe("drain 回條帳本(tally):每筆去向與確認進度", () => {
  it("handler 回報的去向分項累計;沒回報 = 其他;ack 後 acked 追上 processed", async () => {
    const persist: PersistFlag = { failed: false };
    const { bot } = makeFakeBot({
      updates: [upd(1), upd(2), upd(3), upd(4)],
      persist,
      outcomes: new Map<number, UpdateOutcome[]>([
        [1, ["saved"]],
        [2, ["duplicate"]],
        [3, ["unwritten"]],
      ]),
    });
    const tally = newDrainTally();
    await drainUpdates(bot, persist, "測試目的地", tally);
    expect(tally).toEqual({
      processed: 4,
      saved: 1,
      duplicate: 1,
      unwritten: 1,
      acked: 4,
      ackedUnwritten: 1,
    });
  });

  it("先到先贏:已回報 saved 之後的 unwritten 不得改判(回覆階段的雜訊例外)", async () => {
    const persist: PersistFlag = { failed: false };
    const { bot } = makeFakeBot({
      updates: [upd(1)],
      persist,
      outcomes: new Map<number, UpdateOutcome[]>([[1, ["saved", "unwritten"]]]),
    });
    const tally = newDrainTally();
    await drainUpdates(bot, persist, "測試目的地", tally);
    expect(tally.saved).toBe(1);
    expect(tally.unwritten).toBe(0);
  });

  it("每筆處理前 outcome 歸零:前一筆的去向不會串到下一筆", async () => {
    const persist: PersistFlag = { failed: false };
    const { bot } = makeFakeBot({
      updates: [upd(1), upd(2)],
      persist,
      outcomes: new Map<number, UpdateOutcome[]>([[1, ["saved"]]]),
    });
    const tally = newDrainTally();
    await drainUpdates(bot, persist, "測試目的地", tally);
    expect(tally.saved).toBe(1);
    expect(tally.processed).toBe(2); // 第二筆沒回報 → 其他
  });

  it("handleUpdate 丟例外且沒回報去向 → 算失敗未寫入(照舊 ack)", async () => {
    const persist: PersistFlag = { failed: false };
    const { bot } = makeFakeBot({ updates: [upd(1)], throwOn: new Set([1]), persist });
    const tally = newDrainTally();
    const result = await drainUpdates(bot, persist, "測試目的地", tally);
    expect(result).toEqual({ processed: 1, aborted: false });
    expect(tally.unwritten).toBe(1);
    expect(tally.ackedUnwritten).toBe(1);
  });

  it("中止:失敗批內已處理的筆數留在 processed 但沒被確認(acked 落後)", async () => {
    const persist: PersistFlag = { failed: false };
    // 一次回 3 筆的 bot:第 3 筆寫入失敗 → 前 2 筆已處理但整批沒 ack
    const bot: DrainableBot = {
      telegram: { getUpdates: async (_t, _l, offset) => (offset === 0 ? [upd(1), upd(2), upd(3)] : []) },
      handleUpdate: async (u) => {
        if (u.update_id === 3) persist.failed = true;
        else drainHooks(persist).onOutcome("saved");
      },
    };
    const tally = newDrainTally();
    const result = await drainUpdates(bot, persist, "測試目的地", tally);
    expect(result).toEqual({ processed: 2, aborted: true });
    expect(tally.saved).toBe(2);
    expect(tally.acked).toBe(0);
  });

  it("確認用的 getUpdates 失敗 → reject 但 tally 保留(呼叫端據此印回條)", async () => {
    const persist: PersistFlag = { failed: false };
    const bot: DrainableBot = {
      telegram: {
        getUpdates: async (_t, _l, offset) => {
          if (offset === 0) return [upd(1), upd(2)];
          throw Object.assign(new Error("409 synthetic"), { response: { error_code: 409 } });
        },
      },
      handleUpdate: async () => drainHooks(persist).onOutcome("saved"),
    };
    const tally = newDrainTally();
    await expect(drainUpdates(bot, persist, "測試目的地", tally)).rejects.toThrow("409");
    expect(tally.processed).toBe(2);
    expect(tally.saved).toBe(2);
    expect(tally.acked).toBe(0);
  });
});

describe("exitCodeFor:有訊息被確認收走卻沒寫進表 → 非 0", () => {
  it("ackedUnwritten > 0 → 3;aborted 仍優先 → 2;不傳 tally 行為如舊", () => {
    const t = { ...newDrainTally(), processed: 3, unwritten: 3, acked: 3, ackedUnwritten: 3 };
    expect(exitCodeFor({ processed: 3, aborted: false }, t)).toBe(3);
    expect(exitCodeFor({ processed: 3, aborted: true }, t)).toBe(2);
    expect(exitCodeFor({ processed: 3, aborted: false })).toBe(0);
  });
});
