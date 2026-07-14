/**
 * drain N+1 防護:單輪 drain 多筆 update 不該每筆都全表讀去重。
 *
 * 修法(finding: drain-n1-full-table-read-per-message):collect 去重改查
 * storage 實例的 in-memory 去重索引(`dedupIndex`,單輪只讀一次全表建好),append
 * 成功後把新 key 併入。本測 mock googleapis,數 `spreadsheets.values.get` 被呼叫的次數:
 * 一輪 N 筆收錄,資料讀(values.get 的 data range)應為 O(1)(只讀一次),而非 O(N)。
 *
 * 之所以要在 GoogleSheetsStorage 層測(不只 MemoryStorage):N+1 是「每筆打一次 Sheet
 * values.get」的問題,只有真正數 sheets 呼叫次數才守得住;純記憶體版沒有網路呼叫可數。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── 假 sheets client:記錄每種呼叫次數,values.get 依 range 分類(表頭列 vs 資料列) ──
const calls = { headerGet: 0, dataGet: 0, append: 0, metaGet: 0 };
// 模擬表上的資料列(append 會往這裡塞,讓 alreadyDone 之類的全表查能看到最新狀態)。
let dataRows: string[][] = [];

const fakeSheets = {
  spreadsheets: {
    get: vi.fn(async () => {
      calls.metaGet++;
      return { data: { sheets: [{ properties: { title: "參考池" } }] } };
    }),
    values: {
      get: vi.fn(async ({ range }: { range: string }) => {
        if (/!1:1$/.test(range)) {
          calls.headerGet++;
          return { data: { values: [["平台", "連結", "挑", "加入日期", "夯度"]] } };
        }
        // 資料 range(A2:E…)
        calls.dataGet++;
        return { data: { values: dataRows.map((r) => [...r]) } };
      }),
      append: vi.fn(async ({ requestBody }: { requestBody: { values: string[][] } }) => {
        calls.append++;
        dataRows.push(requestBody.values[0]!);
        return { data: {} };
      }),
      update: vi.fn(async () => ({ data: {} })),
    },
  },
};

vi.mock("googleapis", () => ({
  google: {
    auth: { JWT: class {} },
    sheets: () => fakeSheets,
  },
}));

// google mock 必須先於 import GoogleSheetsStorage(它 import googleapis)。
const { GoogleSheetsStorage } = await import("../src/storage/googleSheets.js");
const { runCollect } = await import("../src/bot/handlers/collect.js");
const { TBVOC_TARGET } = await import("../src/targets.js");

function makeStorage() {
  return new GoogleSheetsStorage({
    credentials: { client_email: "x@y", private_key: "k" },
    sheetId: "SID",
    sheetName: "參考池",
    columns: TBVOC_TARGET.columns, // 本檔沿用 clip 的 5 欄 fixture(tbvoc target)
    owner: TBVOC_TARGET.owner,
  });
}

beforeEach(() => {
  calls.headerGet = 0;
  calls.dataGet = 0;
  calls.append = 0;
  calls.metaGet = 0;
  dataRows = [];
});

describe("drain 單輪去重不 N+1(values.get 資料讀 O(1))", () => {
  it("一輪 5 筆不同連結收錄 → 資料 values.get 只打 1 次、append 5 次", async () => {
    const storage = makeStorage();
    const urls = [
      "https://www.tiktok.com/@u/video/1111111111",
      "https://www.tiktok.com/@u/video/2222222222",
      "https://www.tiktok.com/@u/video/3333333333",
      "https://www.tiktok.com/@u/video/4444444444",
      "https://www.tiktok.com/@u/video/5555555555",
    ];
    for (const url of urls) {
      const r = await runCollect({ text: `${url} note` }, { storage, expandShortUrls: false, target: TBVOC_TARGET });
      expect(r.error).toBeUndefined();
    }
    expect(calls.append).toBe(5); // 5 筆都寫進去
    // 關鍵斷言:去重的資料全表讀只在第一筆建索引時打一次,之後查 in-memory 索引。
    expect(calls.dataGet).toBe(1);
    // 表頭也只讀一次(layout 快取)。
    expect(calls.headerGet).toBe(1);
  });

  it("一輪 N 筆(N=3 與 N=8)資料讀次數都是 1 → 與 N 無關(非線性惡化)", async () => {
    async function readsForN(n: number): Promise<number> {
      calls.dataGet = 0;
      dataRows = [];
      const storage = makeStorage(); // 每輪新實例(= drain 每輪新建)
      for (let i = 0; i < n; i++) {
        await runCollect(
          { text: `https://www.tiktok.com/@u/video/90000000${i}0 n` },
          { storage, expandShortUrls: false, target: TBVOC_TARGET },
        );
      }
      return calls.dataGet;
    }
    expect(await readsForN(3)).toBe(1);
    expect(await readsForN(8)).toBe(1);
  });

  it("同輪稍後重複連結 → 命中 in-memory 索引、不再 append、仍不多打資料讀", async () => {
    const storage = makeStorage();
    const url = "https://www.tiktok.com/@u/video/7234567890";
    const r1 = await runCollect({ text: `${url} 第一次` }, { storage, expandShortUrls: false, target: TBVOC_TARGET });
    const r2 = await runCollect({ text: `${url} 又貼一次` }, { storage, expandShortUrls: false, target: TBVOC_TARGET });
    expect(r1.reply).toContain("已收進參考池");
    expect(r2.reply).toContain("已經收過"); // 命中快取(含剛 append 的那筆)
    expect(calls.append).toBe(1); // 沒有重寫
    expect(calls.dataGet).toBe(1); // 全程只讀一次全表
  });

  it("表上同 key 多列(歷史殘留)→ dedupIndex 保第一筆,重複回覆顯示最早的加入日期", async () => {
    // duplicateMsg 講「首次加入」;從前 dedupIndex 後蓋前,會把首次日期蓋成最新列的,語意反掉。
    const url = "https://www.tiktok.com/@u/video/7234567890";
    dataRows = [
      ["tiktok", url, "", "2026-01-01", ""],
      ["tiktok", url, "", "2026-06-30", ""],
    ];
    const storage = makeStorage();
    const r = await runCollect({ text: `${url} 又貼` }, { storage, expandShortUrls: false, target: TBVOC_TARGET });
    expect(r.reply).toContain("已經收過");
    expect(r.reply).toContain("2026-01-01"); // 首次加入 = 第一筆
    expect(r.reply).not.toContain("2026-06-30"); // 不是被後列蓋掉的日期
    expect(calls.append).toBe(0); // 重複不寫入
  });
});
