/**
 * drain 收尾「回條」:Owner 只看 Actions run 的紅綠與 Step Summary,要能分出
 *   - 完成:每一筆去哪了(寫入/重複/失敗未寫入/其他)
 *   - A 確認(下一次 getUpdates)失敗 → 印「N 筆已處理、M 筆的確認結果不明」,exit 非 0
 *   - B 沒寫入卻被確認收走:非暫態錯誤照舊 ack(政策不變),但摘要分項列出且 exit 非 0
 *   - 沒跑:第一次 getUpdates 就失敗 → 明講 0 筆已處理,跟 A 分得出來
 * 走真的 runDrain → createBot → runCollect → drainUpdates;只替換 Telegram.prototype.callApi 與 storage。
 * 全為合成資料。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "@telegraf/types";
import { logger } from "@pei760730/collector-core";
import { runDrain } from "../src/drainRun.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { VOC_TARGET, TBVOC_TARGET } from "../src/targets.js";
import type { Config } from "../src/config.js";
import type { RefRow } from "../src/types.js";

function memoryConfig(overrides: Partial<Config> = {}): Config {
  return {
    target: "voc",
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

// 腳本:getUpdates 每呼叫一次 shift 一個元素;Error = 丟出,陣列 = 回該批,耗盡 = 空批。
let script: Array<Update[] | Error> = [];
// 有狀態的 Telegram 伺服器 fake(不為 null 時優先於 script):自己持有待領更新與「已確認 offset」。
// loseAckResponse=true:收到 offset>0 的 getUpdates 時先「接受」(丟掉 < offset 的更新、記下已確認),
// 再丟傳輸錯誤(回應遺失)—— 模擬確認其實已生效、呼叫端卻不知道。
let server: null | { pending: Update[]; confirmedOffset: number; loseAckResponse: boolean } = null;
const getUpdatesOffsets: number[] = [];
const origCallApi = Telegram.prototype.callApi;
Telegram.prototype.callApi = async function (method: string, payload?: { offset?: number }) {
  if (method === "getMe") return { id: 1, is_bot: true, first_name: "bot", username: "testbot" } as never;
  if (method === "deleteWebhook") return true as never;
  if (method === "getUpdates") {
    getUpdatesOffsets.push(payload?.offset ?? 0);
    if (server) {
      const offset = payload?.offset ?? 0;
      if (offset > 0) {
        server.pending = server.pending.filter((u) => u.update_id >= offset);
        server.confirmedOffset = Math.max(server.confirmedOffset, offset);
        if (server.loseAckResponse) {
          throw Object.assign(new Error("fetch failed (synthetic response lost)"), { name: "FetchError" });
        }
      }
      return [...server.pending] as never;
    }
    const next = script.shift() ?? [];
    if (next instanceof Error) throw next;
    return next as never;
  }
  return {} as never;
} as typeof Telegram.prototype.callApi;
afterAll(() => {
  Telegram.prototype.callApi = origCallApi;
});

const logged: string[] = [];
beforeEach(() => {
  script = [];
  server = null;
  getUpdatesOffsets.length = 0;
  logged.length = 0;
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(logger, level).mockImplementation((m: string) => {
      logged.push(m);
    });
  }
});
afterEach(() => vi.restoreAllMocks());

const link = (n: number) => `https://www.tiktok.com/@synthetic_user/video/70000000000000000${n}`;
function textUpdate(updateId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 0,
      chat: { id: 123, type: "private", first_name: "Synthetic" },
      from: { id: 9, is_bot: false, first_name: "Synthetic" },
      text,
    },
  } as unknown as Update;
}
const conflict409 = () =>
  Object.assign(new Error("409: Conflict: terminated by other getUpdates request (synthetic)"), {
    response: { ok: false, error_code: 409 },
  });
/** 摘要行 = collect.yml Step Summary 用 grep '已處理' 抓的那一行。 */
const summaryLines = () => logged.filter((l) => l.includes("已處理"));

/** 第 n 次(1 起算)dedupIndex 丟「非暫態」錯(合成 400),其餘照常。 */
class IndexBrokenOnCall extends MemoryStorage {
  calls = 0;
  constructor(private readonly brokenCalls: Set<number>) {
    super();
  }
  override async dedupIndex(): Promise<Map<string, RefRow>> {
    this.calls += 1;
    if (this.brokenCalls.has(this.calls)) {
      throw Object.assign(new Error("Unable to parse range (synthetic non-transient 400)"), { code: 400 });
    }
    return super.dedupIndex();
  }
}

describe("完成:摘要分項列出每一筆去哪了", () => {
  it("寫入 / 重複 / 失敗未寫入 / 其他 各自計數,exit 非 0(有訊息沒進表)", async () => {
    // dedupIndex 第 2 次呼叫失敗:link(1) 寫入、link(2) 失敗未寫入(非暫態→照舊 ack)、
    // link(1) 再來一次 → 重複;「沒有連結」的訊息 → 其他。
    const storage = new IndexBrokenOnCall(new Set([2]));
    script = [[textUpdate(1, link(1)), textUpdate(2, link(2)), textUpdate(3, link(1)), textUpdate(4, "沒有連結")]];
    const code = await runDrain(memoryConfig(), storage, VOC_TARGET);

    expect(await storage.readAll()).toHaveLength(1);
    // 確認/重領政策不變:非暫態錯誤照舊 ack(最後一次 getUpdates 帶 5)
    expect(getUpdatesOffsets).toEqual([0, 5]);
    const lines = summaryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("已處理 4 筆");
    expect(lines[0]).toContain("寫入 1");
    expect(lines[0]).toContain("重複 1");
    expect(lines[0]).toContain("失敗未寫入 1");
    expect(lines[0]).toContain("其他 1");
    expect(code).not.toBe(0);
  });

  it("全部正常 → 摘要照舊以「drain 完成:已處理 N 筆更新」開頭、exit 0", async () => {
    const storage = new MemoryStorage();
    script = [[textUpdate(1, link(1)), textUpdate(2, link(2))]];
    const code = await runDrain(memoryConfig(), storage, VOC_TARGET);
    expect(code).toBe(0);
    const lines = summaryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("drain 完成:已處理 2 筆更新");
    expect(lines[0]).toContain("寫入 2");
    expect(lines[0]).toContain("失敗未寫入 0");
  });
});

describe("A 已寫入但沒回條(確認那次 getUpdates 失敗)", () => {
  it("(voc)印出「已處理 2 筆、其中 2 筆的確認結果不明」,不承諾一定重領,仍 reject(exit 1)", async () => {
    const storage = new MemoryStorage();
    script = [[textUpdate(1, link(1)), textUpdate(2, link(2))], conflict409()];
    await expect(runDrain(memoryConfig(), storage, VOC_TARGET)).rejects.toThrow("409");

    expect(await storage.readAll()).toHaveLength(2); // 表上已多 2 列
    expect(getUpdatesOffsets).toEqual([0, 3]); // offset 3 從未被 Telegram 接受
    const lines = summaryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("已處理 2 筆");
    expect(lines[0]).toContain("2 筆的確認結果不明");
    expect(lines[0]).toContain("若未確認,下輪會重領");
    expect(lines[0]).toContain("若其實已確認,就不會再領");
    expect(lines[0]).toContain("去重通常會擋");
    expect(lines[0]).not.toContain("尚未被 Telegram 確認");
    expect(lines[0]).not.toContain("不會加倍");
  });

  it("(tbvoc)同一路徑,行為一致", async () => {
    const storage = new MemoryStorage();
    script = [[textUpdate(1, `${link(1)} note`)], conflict409()];
    await expect(runDrain(memoryConfig({ target: "tbvoc" }), storage, TBVOC_TARGET)).rejects.toThrow("409");
    const lines = summaryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("已處理 1 筆");
    expect(lines[0]).toContain("1 筆的確認結果不明");
  });

  it("先前批次已確認、只有最後一批沒回條 → M 只算最後一批", async () => {
    const storage = new MemoryStorage();
    script = [
      [textUpdate(1, link(1)), textUpdate(2, link(2))],
      [textUpdate(3, link(3))],
      conflict409(),
    ];
    await expect(runDrain(memoryConfig(), storage, VOC_TARGET)).rejects.toThrow("409");
    expect(getUpdatesOffsets).toEqual([0, 3, 4]);
    const lines = summaryLines();
    expect(lines[0]).toContain("已處理 3 筆");
    expect(lines[0]).toContain("1 筆的確認結果不明");
  });

  it("重跑不加倍:下一輪重領同批,表上列數不變、全判重複、摘要正常收尾", async () => {
    const storage = new MemoryStorage();
    script = [[textUpdate(1, link(1)), textUpdate(2, link(2))], conflict409()];
    await expect(runDrain(memoryConfig(), storage, VOC_TARGET)).rejects.toThrow("409");
    expect(await storage.readAll()).toHaveLength(2);

    logged.length = 0;
    script = [[textUpdate(1, link(1)), textUpdate(2, link(2))]];
    const code = await runDrain(memoryConfig(), storage, VOC_TARGET);
    expect(code).toBe(0);
    expect(await storage.readAll()).toHaveLength(2); // 沒加倍
    expect(summaryLines()[0]).toContain("重複 2");
    expect(summaryLines()[0]).toContain("寫入 0");
  });
});

describe("沒跑:第一次 getUpdates 就失敗", () => {
  it("明講已處理 0 筆,且不出現「確認結果不明」(與 A 分得出來),仍 reject", async () => {
    const storage = new MemoryStorage();
    script = [conflict409()];
    await expect(runDrain(memoryConfig(), storage, VOC_TARGET)).rejects.toThrow("409");
    expect(await storage.readAll()).toHaveLength(0);
    const lines = summaryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("已處理 0 筆");
    expect(lines[0]).not.toContain("確認結果不明");
  });
});

describe("寫入失敗中止:摘要也帶分項與未確認筆數", () => {
  it("第 1 筆寫入、第 2 筆 append 失敗 → 「drain 中止」、1 筆因中止沒送出確認、exit 2", async () => {
    class SecondAppendFails extends MemoryStorage {
      n = 0;
      override async append(row: RefRow): Promise<void> {
        this.n += 1;
        if (this.n === 2) throw new Error("quota exceeded (synthetic)");
        return super.append(row);
      }
    }
    const storage = new SecondAppendFails();
    script = [[textUpdate(1, link(1)), textUpdate(2, link(2))]];
    const code = await runDrain(memoryConfig(), storage, VOC_TARGET);
    expect(code).toBe(2);
    const lines = summaryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("drain 中止");
    expect(lines[0]).toContain("已處理 1 筆");
    expect(lines[0]).toContain("寫入 1");
    expect(lines[0]).toContain("1 筆因中止沒送出確認");
  });
});

/** 多批:批 1 有一則碰到非暫態錯誤(被確認收走、沒寫入),之後才出事 —— 兩件事都要看得到。 */
const LOST_NOTE = "1 筆失敗未寫入、已被確認收走、不會重領";
const REDO_HINT = "需重新操作(請重貼連結)";

describe("多批:先前批次有「已確認收走但沒寫入」,後面又中斷/中止 → 摘要兩件事都帶", () => {
  it("(voc)批 2 的確認 getUpdates 失敗 → 中斷行同時有「1 筆確認結果不明」與「1 筆失敗未寫入、已被確認收走」", async () => {
    const storage = new IndexBrokenOnCall(new Set([1])); // 批 1 的 link(1) 非暫態失敗
    script = [[textUpdate(1, link(1))], [textUpdate(2, link(2))], conflict409()];
    await expect(runDrain(memoryConfig(), storage, VOC_TARGET)).rejects.toThrow("409");

    expect(getUpdatesOffsets).toEqual([0, 2, 3]);
    expect(await storage.readAll()).toHaveLength(1);
    const lines = summaryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("drain 中斷");
    expect(lines[0]).toContain("已處理 2 筆");
    expect(lines[0]).toContain("1 筆的確認結果不明");
    expect(lines[0]).toContain(LOST_NOTE);
    expect(lines[0]).toContain(REDO_HINT);
  });

  it("(voc)批 2 某筆 append 暫時失敗而中止 → 中止行同時有「1 筆沒送出確認」與「1 筆失敗未寫入、已被確認收走」,exit 2", async () => {
    class BrokenIndexThenAppendFails extends IndexBrokenOnCall {
      appends = 0;
      override async append(row: RefRow): Promise<void> {
        this.appends += 1;
        if (this.appends === 2) throw new Error("quota exceeded (synthetic)");
        return super.append(row);
      }
    }
    const storage = new BrokenIndexThenAppendFails(new Set([1]));
    script = [[textUpdate(1, link(1))], [textUpdate(2, link(2)), textUpdate(3, link(3))]];
    const code = await runDrain(memoryConfig(), storage, VOC_TARGET);

    expect(code).toBe(2);
    expect(getUpdatesOffsets).toEqual([0, 2]);
    const lines = summaryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("drain 中止");
    expect(lines[0]).toContain("1 筆因中止沒送出確認");
    expect(lines[0]).toContain(LOST_NOTE);
    expect(lines[0]).toContain(REDO_HINT);
  });

  it("單批 B 的說法:需重新操作(請重貼連結)", async () => {
    const storage = new IndexBrokenOnCall(new Set([1]));
    script = [[textUpdate(1, link(1))]];
    expect(await runDrain(memoryConfig(), storage, VOC_TARGET)).toBe(3);
    expect(summaryLines()[0]).toContain(REDO_HINT);
    expect(summaryLines()[0]).not.toContain("需重貼");
  });
});

describe("多批:K(已被確認收走沒寫入)不等於 N(失敗未寫入總數)、M(未確認)另算", () => {
  it("(R5 中斷)批 1 未寫入 1 筆;批 2 未寫入 1 + 寫入 1,之後確認失敗 → N=2、K=1、M=2", async () => {
    const storage = new IndexBrokenOnCall(new Set([1, 2])); // u1、u2 的 dedupIndex 非暫態失敗
    script = [[textUpdate(1, link(1))], [textUpdate(2, link(2)), textUpdate(3, link(3))], conflict409()];
    await expect(runDrain(memoryConfig(), storage, VOC_TARGET)).rejects.toThrow("409");

    expect(getUpdatesOffsets).toEqual([0, 2, 4]);
    const line = summaryLines()[0]!;
    expect(line).toContain("已處理 3 筆");
    expect(line).toContain("失敗未寫入 2"); // N
    expect(line).toContain("其中 2 筆的確認結果不明"); // M(批 2 全部)
    expect(line).toContain("其中 1 筆失敗未寫入、已被確認收走"); // K(只有批 1 那筆)
    expect(line).not.toContain("其中 2 筆失敗未寫入");
  });

  it("(R5 中止)批 1 未寫入 1 筆;批 2 先未寫入 1 筆、再有一筆 append 暫時失敗 → N=2、K=1、M=1,exit 2", async () => {
    class FirstAppendFails extends IndexBrokenOnCall {
      override async append(row: RefRow): Promise<void> {
        throw new Error(`quota exceeded (synthetic) ${row.平台}`);
      }
    }
    const storage = new FirstAppendFails(new Set([1, 2]));
    script = [[textUpdate(1, link(1))], [textUpdate(2, link(2)), textUpdate(3, link(3))]];
    const code = await runDrain(memoryConfig(), storage, VOC_TARGET);

    expect(code).toBe(2);
    const line = summaryLines()[0]!;
    expect(line).toContain("drain 中止");
    expect(line).toContain("已處理 2 筆");
    expect(line).toContain("失敗未寫入 2"); // N
    expect(line).toContain("其中 1 筆因中止沒送出確認"); // M(批 2 的 u2)
    expect(line).toContain("其中 1 筆失敗未寫入、已被確認收走"); // K(批 1 的 u1)
    expect(line).not.toContain("其中 2 筆失敗未寫入");
  });

  it("(R10 同一批)最後一批裡的未寫入還沒被確認 → 算「確認結果不明」那段的 U,不得寫成已被確認收走的 K", async () => {
    const storage = new IndexBrokenOnCall(new Set([2])); // u2(批 2 內)非暫態失敗
    script = [[textUpdate(1, link(1))], [textUpdate(2, link(2)), textUpdate(3, link(3))], conflict409()];
    await expect(runDrain(memoryConfig(), storage, VOC_TARGET)).rejects.toThrow("409");

    expect(getUpdatesOffsets).toEqual([0, 2, 4]);
    const line = summaryLines()[0]!;
    expect(line).toContain("已處理 3 筆");
    expect(line).toContain("失敗未寫入 1");
    expect(line).toContain("其中 2 筆的確認結果不明");
    // 同批未寫入還沒被確認:不是 K。但屬於「確認結果不明」那段,要被點名(U=1)。
    expect(line).not.toContain("筆失敗未寫入、已被確認收走、不會重領");
    expect(line).toContain("有 1 筆未寫入");
    expect(line).toContain("請核對表上有沒有");
  });
});

describe("確認結果不明 vs 因中止沒送出確認:兩種「未確認」各說各的", () => {
  it("(a)伺服器已接受 offset 但回應遺失、重試也失敗 → 不承諾重領、點名未寫入那筆;下一輪真的領不到它", async () => {
    vi.useFakeTimers();
    try {
      // u1 非暫態未寫入(dedupIndex 讀失敗);確認那次 getUpdates(offset=2)伺服器已接受、回應遺失,
      // 4 次重試全是傳輸失敗。呼叫端分不出伺服器到底確認了沒 → 摘要不得說「一定重領」。
      const storage = new IndexBrokenOnCall(new Set([1]));
      server = { pending: [textUpdate(1, link(1))], confirmedOffset: 0, loseAckResponse: true };
      const settled = runDrain(memoryConfig(), storage, VOC_TARGET).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ error }),
      );
      await vi.runAllTimersAsync();
      expect("error" in (await settled)).toBe(true);

      expect(getUpdatesOffsets).toEqual([0, 2, 2, 2, 2]);
      // 伺服器端事實:確認其實已生效,u1 已不在待領佇列
      expect(server.confirmedOffset).toBe(2);
      expect(server.pending).toEqual([]);
      const lines = summaryLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("已處理 1 筆");
      expect(lines[0]).toContain("1 筆的確認結果不明");
      expect(lines[0]).toContain("若未確認,下輪會重領");
      expect(lines[0]).toContain("若其實已確認,就不會再領");
      expect(lines[0]).toContain("有 1 筆未寫入");
      expect(lines[0]).toContain("請核對表上有沒有");
      expect(lines[0]).not.toContain("尚未被 Telegram 確認");
      expect(lines[0]).not.toContain("不會加倍");
      expect(lines[0]).not.toContain("筆失敗未寫入、已被確認收走、不會重領"); // 這筆不確定,不是 K

      // 下一輪 drain 用同一個伺服器:那則真的不會再被領到,表上也沒有 → 正是摘要要 Owner 去核對的情況
      logged.length = 0;
      server.loseAckResponse = false;
      const code = await runDrain(memoryConfig(), storage, VOC_TARGET);
      expect(code).toBe(0);
      expect(summaryLines()[0]).toContain("drain 完成:已處理 0 筆更新");
      expect(await storage.readAll()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("(b)中止而根本沒送出確認的那段 → 可以肯定地說下輪會重領", async () => {
    class SecondAppendFails extends MemoryStorage {
      n = 0;
      override async append(row: RefRow): Promise<void> {
        this.n += 1;
        if (this.n === 2) throw new Error("quota exceeded (synthetic)");
        return super.append(row);
      }
    }
    script = [[textUpdate(1, link(1)), textUpdate(2, link(2))]];
    await runDrain(memoryConfig(), new SecondAppendFails(), VOC_TARGET);
    const lines = summaryLines();
    expect(lines[0]).toContain("1 筆因中止沒送出確認,尚未確認,下輪會重領");
    expect(lines[0]).not.toContain("確認結果不明");
    expect(lines[0]).not.toContain("不會加倍");
  });
});

describe("夯度按鈕(tbvoc)的寫入結果不在回條分項內", () => {
  const hotUpdate = (updateId: number, key: string): Update =>
    ({
      update_id: updateId,
      callback_query: {
        id: `cb${updateId}`,
        from: { id: 9, is_bot: false, first_name: "Synthetic" },
        chat_instance: "ci",
        data: `h:0:${key}`,
        message: {
          message_id: 10,
          date: 0,
          chat: { id: 123, type: "private", first_name: "Synthetic" },
          from: { id: 1, is_bot: true, first_name: "bot" },
          text: "已收進參考池",
        },
      },
    }) as unknown as Update;

  it("非暫態失敗:exit 不變 3、「失敗未寫入」不增加(算「其他」),摘要仍是「drain 完成」", async () => {
    class HotBroken extends MemoryStorage {
      override async setHot(): Promise<boolean> {
        throw new Error("表結構壞了(synthetic 非暫態)");
      }
    }
    script = [[hotUpdate(1, "tiktok:7000000000000000001")]];
    const code = await runDrain(memoryConfig({ target: "tbvoc" }), new HotBroken(), TBVOC_TARGET);
    expect(code).toBe(0);
    const lines = summaryLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("drain 完成:已處理 1 筆");
    expect(lines[0]).toContain("失敗未寫入 0");
    expect(lines[0]).toContain("其他 1");
    expect(lines[0]).not.toContain("已被確認收走");
  });
});
