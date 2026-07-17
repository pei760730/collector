/**
 * drain abort 語意 + exit code 對映(三胞胎對齊:svb #63 / cc #44 同型修復):
 * 舊版 aborted(寫入失敗中止)也 exit 0 → collect.yml 綠燈、kai-notify(if: failure())
 * 永不觸發;Sheets 壞掉 + ERROR_CHAT_ID 沒設 = 靜默丟資料。
 * 本測釘住:aborted → exitCodeFor = 2(非 0),正常 → 0;
 * 迴圈的 ack 語意 —— 失敗筆不前進 offset(下次 cron 重領)、成功段照常 ack;
 * 以及 feed 專屬的 gate 告警追蹤器 —— flush 會等告警送完(process.exit 前不砍在途訊息)、
 * 每輪至多一則、送失敗不拋出。
 */
import { describe, it, expect, vi } from "vitest";
import type { Update } from "@telegraf/types";
import {
  drainUpdates,
  exitCodeFor,
  makeGateAlerter,
  type DrainableBot,
  type PersistFlag,
} from "../../src/engines/of/drainLoop.js";

function upd(id: number): Update {
  return { update_id: id } as Update;
}

/**
 * 假 bot:getUpdates 依 offset 回「還沒 ack 的更新」(模擬 Telegram 累積語意;
 * 一次只回 1 筆,逼迴圈每筆都帶新 offset 重新領 → offset 前進/停住的語意才驗得到),
 * handleUpdate 時對指定 update_id 翻 persist.failed(模擬寫入暫存區失敗)。
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
  it("全部成功 → processed=全數、aborted=false", async () => {
    const persist: PersistFlag = { failed: false };
    const { bot } = makeFakeBot({ updates: [upd(10), upd(11), upd(12)], persist });
    const r = await drainUpdates(bot, persist);
    expect(r).toEqual({ processed: 3, aborted: false });
  });

  it("中途某筆寫入失敗 → aborted=true、失敗筆與之後的不 ack(下次重領)", async () => {
    const persist: PersistFlag = { failed: false };
    const { bot, offsetsSeen, handled } = makeFakeBot({
      updates: [upd(10), upd(11), upd(12)],
      failOn: new Set([11]),
      persist,
    });
    const r = await drainUpdates(bot, persist);
    expect(r.aborted).toBe(true);
    expect(r.processed).toBe(1); // 只有 10 成功
    expect(handled).toEqual([10, 11]); // 12 沒被處理(提前結束)
    // 失敗筆(11)不前進 offset,且中止後不再發 getUpdates → 11 未被 ack(10 已被第二次
    // getUpdates(offset=11) ack)。下次 cron 從 offset=0 起重領未確認段:與失敗筆「同批」的
    // 已成功筆也會一併重領(本假件一批 1 筆,故只重領 11),由 storage 去重吸收(可解析列=
    // VIDEO_ID 索引;raw_ 列=同日同 CLEAN_URL 護欄)、副作用 = 再回一次「已存在」——
    // 不是「被下次 cron ack」。
    expect(offsetsSeen).toEqual([0, 11]);
  });

  it("路由層例外(非寫入失敗)→ 記錄後跳過、照常 ack、不 abort", async () => {
    const persist: PersistFlag = { failed: false };
    const { bot, handled } = makeFakeBot({
      updates: [upd(10), upd(11)],
      throwOn: new Set([10]),
      persist,
    });
    const r = await drainUpdates(bot, persist);
    expect(r.aborted).toBe(false);
    expect(r.processed).toBe(2); // 例外筆也算處理(ack 掉,重領也沒用)
    expect(handled).toEqual([10, 11]);
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

describe("makeGateAlerter:gate 告警要活過 process.exit(flush 等送完)", () => {
  it("send 同步觸發、flush 等 sendMessage resolve 完才回(exit 前不砍在途告警)", async () => {
    let resolveSend!: () => void;
    let sent = false;
    const sendMessage = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveSend = () => {
            sent = true;
            res();
          };
        }),
    );
    const alerter = makeGateAlerter("424242", sendMessage);
    alerter.send("總表去重跳過:gate 失效");
    expect(sendMessage).toHaveBeenCalledWith("424242", "🐞 總表去重跳過:gate 失效");

    const flushed = vi.fn();
    const flushing = alerter.flush().then(flushed);
    await Promise.resolve(); // 讓 microtask 跑:sendMessage 未 resolve,flush 不得先完成
    expect(flushed).not.toHaveBeenCalled();
    resolveSend();
    await flushing;
    expect(sent).toBe(true); // flush 回來時告警已真的送出
  });

  it("每輪至多一則:第二次 send 不再發", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const alerter = makeGateAlerter("424242", sendMessage);
    alerter.send("第一則");
    alerter.send("第二則(同輪,應吞掉)");
    await alerter.flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("errorChatId 空 → no-op,不發也不炸", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const alerter = makeGateAlerter("", sendMessage);
    alerter.send("gate 失效");
    await alerter.flush();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sendMessage 失敗 → flush 不拋出(告警失敗不影響 exit code)", async () => {
    const alerter = makeGateAlerter("424242", () => Promise.reject(new Error("blocked")));
    alerter.send("gate 失效");
    await expect(alerter.flush()).resolves.toBeUndefined();
  });
});
