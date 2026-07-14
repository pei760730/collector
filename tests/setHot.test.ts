/**
 * setHot:回填「夯度」的真表寫入路徑(找列號 + colLetter(夯度) + values.update A1)。
 * 原本只在 router 測試用 MemoryStorage 驗過,Sheets 實作零覆蓋;這裡用與 drainDedup 同款的
 * fake sheets client 補齊,斷言 update 打到正確 A1、找不到列時不打 update。
 *
 * 2026-07-13 追加(07-09 audit LOW):
 * - 讀放大修正:單輪內已有全表讀(dedupIndex / readRows)→ setHot 用列號快取,不再整表讀;
 *   快取 miss(本輪沒讀過 / 新列)才退回全表讀重建。
 * - 冪等護欄(append alreadyDone 同款):update「寫成功但回應遺失」觸發重試時,先讀目標單格,
 *   已是要寫的值就視為完成不重打;護欄回 false 照常重試。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const updateCalls: Array<{ range: string; values: string[][] }> = [];
let dataRows: string[][] = [];
/** 全表資料 range(A2:E)的 values.get 次數 —— 讀放大斷言就數這個。 */
let dataReads = 0;
/** update 被打的總次數(含失敗的嘗試;updateCalls 只記成功寫)。 */
let updateAttempts = 0;
/** 前 N 次 update「寫成功但回應遺失」:值已落表、仍丟暫態錯(冪等護欄要接住的情境)。 */
let lostResponses = 0;
/** 前 N 次 update「真失敗」:沒落表就丟暫態錯(護欄該回 false、照常重試)。 */
let hardFailures = 0;

/** A1 單欄字母 → 0-based index(測試表只有 A–E,單字母夠用)。 */
function colIdx(letters: string): number {
  return letters.charCodeAt(0) - 65;
}

const fakeSheets = {
  spreadsheets: {
    get: vi.fn(async () => ({ data: { sheets: [{ properties: { title: "參考池" } }] } })),
    values: {
      get: vi.fn(async ({ range }: { range: string }) => {
        if (/!1:1$/.test(range)) {
          return { data: { values: [["平台", "連結", "挑", "加入日期", "夯度"]] } };
        }
        const cell = /!([A-Z]+)(\d+)$/.exec(range);
        if (cell) {
          // 單格讀(setHot 冪等護欄走這裡)—— 不算全表讀。
          const v = dataRows[Number(cell[2]) - 2]?.[colIdx(cell[1]!)] ?? "";
          return { data: { values: v === "" ? [] : [[v]] } };
        }
        dataReads += 1;
        return { data: { values: dataRows.map((r) => [...r]) } };
      }),
      update: vi.fn(
        async ({ range, requestBody }: { range: string; requestBody: { values: string[][] } }) => {
          updateAttempts += 1;
          const apply = () => {
            const cell = /!([A-Z]+)(\d+)$/.exec(range);
            if (!cell) throw new Error(`update range 不是單格:${range}`);
            const row = dataRows[Number(cell[2]) - 2];
            if (row) row[colIdx(cell[1]!)] = requestBody.values[0]![0]!;
          };
          if (lostResponses > 0) {
            lostResponses -= 1;
            apply(); // 寫成功…
            throw new Error("socket hang up"); // …但回應遺失(isTransient → 觸發重試)
          }
          if (hardFailures > 0) {
            hardFailures -= 1;
            throw new Error("socket hang up"); // 真失敗:沒落表
          }
          apply();
          updateCalls.push({ range, values: requestBody.values });
          return { data: {} };
        },
      ),
      append: vi.fn(async () => ({ data: {} })),
    },
  },
};

vi.mock("googleapis", () => ({
  google: { auth: { JWT: class {} }, sheets: () => fakeSheets },
}));

const { GoogleSheetsStorage } = await import("../src/storage/googleSheets.js");
const { dedupKey } = await import("../src/pipeline/index.js");
const { TBVOC_TARGET } = await import("../src/targets.js");

function makeStorage() {
  return new GoogleSheetsStorage({
    credentials: { client_email: "x@y", private_key: "k" },
    sheetId: "SID",
    sheetName: "參考池",
    columns: TBVOC_TARGET.columns, // 夯度在第 5 欄(E);setHot 是 tbvoc 專屬路徑
    owner: TBVOC_TARGET.owner,
  });
}

beforeEach(() => {
  updateCalls.length = 0;
  dataRows = [];
  dataReads = 0;
  updateAttempts = 0;
  lostResponses = 0;
  hardFailures = 0;
});

const URL = "https://www.tiktok.com/@u/video/7234567890";
const URL_B = "https://youtu.be/dQw4w9WgXcQ";

describe("setHot", () => {
  it("找到列 → 更新夯度欄正確 A1(E2)、回 true", async () => {
    dataRows = [["tiktok", URL, "", "2026-07-08", ""]]; // sheet 第 2 列(row 1 是表頭)
    const storage = makeStorage();
    const ok = await storage.setHot(dedupKey(URL), "5");
    expect(ok).toBe(true);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.range).toMatch(/E2$/); // 夯度=第5欄(E),資料在 sheet 第2列
    expect(updateCalls[0]!.values).toEqual([["5"]]);
  });

  it("找不到列(已挑走)→ 不打 update、回 false", async () => {
    dataRows = [];
    const storage = makeStorage();
    const ok = await storage.setHot("nonexistent-key", "5");
    expect(ok).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });
});

describe("setHot 讀放大修正:列號快取", () => {
  it("單輪內已全表讀過(dedupIndex)→ setHot 命中快取,不再整表讀", async () => {
    dataRows = [["tiktok", URL, "", "2026-07-08", ""]];
    const storage = makeStorage();
    await storage.dedupIndex(); // 模擬 drain 單輪:collect 去重已讀過一次全表
    expect(dataReads).toBe(1);
    const ok = await storage.setHot(dedupKey(URL), "5");
    expect(ok).toBe(true);
    expect(dataReads).toBe(1); // 快取命中 → 沒有第二次全表讀(舊版這裡會 +1)
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.range).toMatch(/E2$/);
  });

  it("快取 miss(快取建好後才出現的列)→ 退回全表讀重建、仍定位到正確列", async () => {
    dataRows = [["tiktok", URL, "", "2026-07-08", ""]];
    const storage = makeStorage();
    await storage.dedupIndex(); // 快取只含 URL(第 2 列)
    dataRows.push(["youtube", URL_B, "", "2026-07-08", ""]); // 快取後才出現的新列(第 3 列)
    const ok = await storage.setHot(dedupKey(URL_B), "3");
    expect(ok).toBe(true);
    expect(dataReads).toBe(2); // miss → 恰好再一次全表讀,不多不少
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.range).toMatch(/E3$/); // 新列在 sheet 第 3 列
  });

  it("全表讀重建後仍找不到 → 回 false、不打 update", async () => {
    dataRows = [["tiktok", URL, "", "2026-07-08", ""]];
    const storage = makeStorage();
    await storage.dedupIndex();
    const ok = await storage.setHot("nonexistent-key", "5");
    expect(ok).toBe(false);
    expect(dataReads).toBe(2); // miss → 有退回全表讀確認過
    expect(updateCalls).toHaveLength(0);
  });
});

describe("setHot 冪等護欄(append alreadyDone 同款)", () => {
  it("寫成功但回應遺失 → 重試前讀單格發現已是目標值,視為完成不重打", async () => {
    dataRows = [["tiktok", URL, "", "2026-07-08", ""]];
    lostResponses = 1; // 第 1 次 update:值落表、回應遺失
    const storage = makeStorage();
    const ok = await storage.setHot(dedupKey(URL), "5");
    expect(ok).toBe(true);
    expect(updateAttempts).toBe(1); // 護欄擋下重打:update 只被打 1 次
    expect(dataRows[0]![4]).toBe("5"); // 值確實在表上
    expect(dataReads).toBe(1); // 護欄走「單格讀」,沒有多出全表讀(讀放大修正不被護欄抵銷)
  });

  it("真失敗(值沒落表)→ 護欄回 false、照常退避重試到成功", async () => {
    dataRows = [["tiktok", URL, "", "2026-07-08", ""]];
    hardFailures = 1; // 第 1 次 update 真失敗
    const storage = makeStorage();
    vi.useFakeTimers(); // 退避 setTimeout 不要真的等
    const p = storage.setHot(dedupKey(URL), "5");
    await vi.runAllTimersAsync();
    const ok = await p;
    vi.useRealTimers();
    expect(ok).toBe(true);
    expect(updateAttempts).toBe(2); // 失敗 1 次 + 重試成功 1 次
    expect(updateCalls).toHaveLength(1);
    expect(dataRows[0]![4]).toBe("5");
  });
});
