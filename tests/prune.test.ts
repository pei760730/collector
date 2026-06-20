import { describe, it, expect } from "vitest";
import { MemoryStorage } from "../src/storage/memory.js";
import { GoogleSheetsStorage } from "../src/storage/googleSheets.js";
import { todayTaipei } from "../src/utils/date.js";
import type { StagingRow } from "../src/types.js";

function row(date: string, videoId: string): StagingRow {
  return {
    PLATFORM: "YouTube",
    DATE: date,
    NOTE: "",
    CLEAN_URL: `https://youtu.be/${videoId}`,
    VIDEO_ID: videoId,
  };
}

const TODAY = todayTaipei(); // 窗內(age 0)
const OLD = "2020/1/1"; // 窗外(age 數千天)
const BROKEN = "壞掉的日期"; // 解析不出 → Infinity

describe("MemoryStorage.pruneOlderThan", () => {
  it("窗外有限年齡列刪除、窗內列保留", async () => {
    const s = new MemoryStorage([row(TODAY, "keep1"), row(OLD, "old1")]);
    const n = await s.pruneOlderThan(14);
    expect(n).toBe(1);
    const left = await s.readAll();
    expect(left).toHaveLength(1);
    expect(left[0]!.VIDEO_ID).toBe("keep1");
  });

  it("DATE 解析不出(Infinity)的列一律保留(與去重一致)", async () => {
    const s = new MemoryStorage([row(BROKEN, "broken1"), row(OLD, "old1")]);
    const n = await s.pruneOlderThan(14);
    expect(n).toBe(1); // 只刪 old1
    const left = await s.readAll();
    expect(left.map((r) => r.VIDEO_ID)).toEqual(["broken1"]);
  });

  it("dryRun 不真刪、只回會刪幾筆", async () => {
    const s = new MemoryStorage([row(OLD, "old1"), row(OLD, "old2"), row(TODAY, "keep1")]);
    const n = await s.pruneOlderThan(14, { dryRun: true });
    expect(n).toBe(2);
    expect(await s.readAll()).toHaveLength(3); // 一筆都沒刪
  });
});

/** 假 sheets client:rawRows 讀 values.get、getSheetGid 讀 spreadsheets.get、刪列走 batchUpdate。 */
function fakeGoogleStorage(dataRows: string[][]) {
  const s = new GoogleSheetsStorage({
    credentials: { client_email: "x@y.z", private_key: "k" },
    sheetId: "SHEET",
    sheetName: "暫存區",
  });
  const batchCalls: unknown[][] = [];
  const fake = {
    spreadsheets: {
      get: async () => ({
        data: { sheets: [{ properties: { title: "暫存區", sheetId: 555 } }] },
      }),
      values: {
        get: async () => ({ data: { values: dataRows } }),
      },
      batchUpdate: async (req: { requestBody: { requests: unknown[] } }) => {
        batchCalls.push(req.requestBody.requests);
        return {};
      },
    },
  };
  (s as unknown as { sheets: unknown }).sheets = fake;
  return { storage: s, batchCalls };
}

// 欄序 PLATFORM, DATE, NOTE, CLEAN_URL, VIDEO_ID
const cells = (date: string, id: string): string[] => ["YouTube", date, "", `u/${id}`, id];

describe("GoogleSheetsStorage.pruneOlderThan", () => {
  it("窗外列刪除:非連續 victim 合併成區段、由下往上刪(列號不位移)", async () => {
    // 實體列:A2=old(刪) A3=today(留) A4=old(刪) A5=old(刪) A6=broken(留)
    const { storage, batchCalls } = fakeGoogleStorage([
      cells(OLD, "old2"), // row 2 → idx 1
      cells(TODAY, "keep3"), // row 3 → idx 2
      cells(OLD, "old4"), // row 4 → idx 3
      cells(OLD, "old5"), // row 5 → idx 4
      cells(BROKEN, "broken6"), // row 6 → idx 5(Infinity,保留)
    ]);
    const n = await storage.pruneOlderThan(14);
    expect(n).toBe(3);
    expect(batchCalls).toHaveLength(1);
    const reqs = batchCalls[0] as { deleteDimension: { range: { startIndex: number; endIndex: number; sheetId: number; dimension: string } } }[];
    // 區段:idx{1} 與 idx{3,4} → [1,2) 與 [3,5);由下往上 → [3,5) 先、[1,2) 後
    expect(reqs.map((r) => [r.deleteDimension.range.startIndex, r.deleteDimension.range.endIndex])).toEqual([
      [3, 5],
      [1, 2],
    ]);
    expect(reqs[0]!.deleteDimension.range.sheetId).toBe(555);
    expect(reqs[0]!.deleteDimension.range.dimension).toBe("ROWS");
  });

  it("全部窗內/壞日期 → 無刪除、不呼叫 batchUpdate", async () => {
    const { storage, batchCalls } = fakeGoogleStorage([cells(TODAY, "k1"), cells(BROKEN, "b1")]);
    const n = await storage.pruneOlderThan(14);
    expect(n).toBe(0);
    expect(batchCalls).toHaveLength(0);
  });

  it("dryRun:回會刪幾筆、不呼叫 batchUpdate", async () => {
    const { storage, batchCalls } = fakeGoogleStorage([cells(OLD, "o1"), cells(OLD, "o2")]);
    const n = await storage.pruneOlderThan(14, { dryRun: true });
    expect(n).toBe(2);
    expect(batchCalls).toHaveLength(0);
  });
});
