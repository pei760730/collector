/**
 * drain N+1 防護:單輪 drain 多筆收錄不該每筆都全表讀去重。
 *
 * 修法(finding: drain-n1-full-table-read-per-message):ingest 去重改查 storage 實例的
 * in-memory 索引 —— `videoIdIndex()`(暫存區,單輪只讀一次全表建好,append 成功併入新 key)
 * 與 `approvedUrlSet()`(總表 URL 欄,單輪只讀一次)。本測 mock googleapis,數
 * `spreadsheets.values.get` 被呼叫次數:一輪 N 筆收錄,暫存區資料讀 / 總表表頭讀 / 總表資料讀
 * 都應是 O(1)(各一次),而非 O(N)。
 *
 * 舊版每筆 = findByVideoId(1 次暫存區全表讀)+ findApprovedByUrl(總表表頭 + 總表整欄 = 2 次讀),
 * 共 ~3N 次全欄讀;修法後降為固定 3 次(與 N 無關)。
 *
 * 之所以要在 GoogleSheetsStorage 層測(不只 MemoryStorage):N+1 是「每筆打一次 Sheet
 * values.get」的問題,只有真正數 sheets 呼叫次數才守得住。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── 假 sheets client:依 range 分類 values.get(暫存區/總表 × 表頭/資料) ──
const calls = { stagingHeaderGet: 0, stagingDataGet: 0, prodHeaderGet: 0, prodDataGet: 0, append: 0, metaGet: 0 };
let stagingRows: string[][] = [];

const fakeSheets = {
  spreadsheets: {
    get: vi.fn(async () => {
      calls.metaGet++;
      return { data: { sheets: [{ properties: { title: "暫存區" } }, { properties: { title: "總表" } }] } };
    }),
    values: {
      get: vi.fn(async ({ range }: { range: string }) => {
        const isStaging = range.includes("暫存區");
        const isHeader = /!1:1$/.test(range);
        if (isStaging && isHeader) {
          calls.stagingHeaderGet++;
          return { data: { values: [["PLATFORM", "DATE", "CLEAN_URL", "VIDEO_ID", "STATUS"]] } };
        }
        if (isStaging) {
          calls.stagingDataGet++;
          return { data: { values: stagingRows.map((r) => [...r]) } };
        }
        // 總表(prod)
        if (isHeader) {
          calls.prodHeaderGet++;
          return { data: { values: [["影片連結", "狀態"]] } };
        }
        calls.prodDataGet++;
        return { data: { values: [] } }; // 總表無已收錄 URL
      }),
      append: vi.fn(async ({ requestBody }: { requestBody: { values: string[][] } }) => {
        calls.append++;
        stagingRows.push(requestBody.values[0]!);
        return { data: { updates: { updatedRange: `'暫存區'!A${stagingRows.length + 1}:E${stagingRows.length + 1}` } } };
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
const { GoogleSheetsStorage } = await import("../../src/engines/of/storage/googleSheets.js");
const { runIngest } = await import("../../src/engines/of/bot/handlers/ingest.js");

const FIXED = () => 1_700_000_000_000;

function makeStorage() {
  return new GoogleSheetsStorage({
    credentials: { client_email: "x@y", private_key: "k" },
    sheetId: "SID",
    sheetName: "暫存區",
    prodSheetName: "總表",
  });
}

beforeEach(() => {
  calls.stagingHeaderGet = 0;
  calls.stagingDataGet = 0;
  calls.prodHeaderGet = 0;
  calls.prodDataGet = 0;
  calls.append = 0;
  calls.metaGet = 0;
  stagingRows = [];
});

describe("drain 單輪去重不 N+1(暫存區/總表 values.get 皆 O(1))", () => {
  it("一輪 5 筆不同連結收錄 → 各類全表讀各只 1 次、append 5 次", async () => {
    const storage = makeStorage();
    const urls = [
      "https://www.tiktok.com/@u/video/1111111111",
      "https://www.tiktok.com/@u/video/2222222222",
      "https://www.tiktok.com/@u/video/3333333333",
      "https://www.tiktok.com/@u/video/4444444444",
      "https://www.tiktok.com/@u/video/5555555555",
    ];
    for (const url of urls) {
      const r = await runIngest({ text: `${url} note` }, { storage, expandShortUrls: false, now: FIXED });
      expect(r.error).toBeUndefined();
    }
    expect(calls.append).toBe(5); // 5 筆都寫進去
    // 關鍵斷言:去重的全表讀只在第一筆建索引時各打一次,之後查 in-memory 快取。
    expect(calls.stagingDataGet).toBe(1);
    expect(calls.prodHeaderGet).toBe(1);
    expect(calls.prodDataGet).toBe(1);
    // 表頭/分頁檢查也只一次(layout 快取)。
    expect(calls.stagingHeaderGet).toBe(1);
    expect(calls.metaGet).toBe(1);
  });

  it("一輪 N 筆(N=3 與 N=8)暫存區資料讀次數都是 1 → 與 N 無關(非線性惡化)", async () => {
    async function readsForN(n: number): Promise<number> {
      calls.stagingDataGet = 0;
      stagingRows = [];
      const storage = makeStorage(); // 每輪新實例(= drain 每輪新建)
      for (let i = 0; i < n; i++) {
        await runIngest(
          { text: `https://www.tiktok.com/@u/video/90000000${i}0 n` },
          { storage, expandShortUrls: false, now: FIXED },
        );
      }
      return calls.stagingDataGet;
    }
    expect(await readsForN(3)).toBe(1);
    expect(await readsForN(8)).toBe(1);
  });

  it("raw_ 護欄:abort 重領(新實例、同日、新 timestamp)→ 不雙寫 unsupported 列", async () => {
    // 情境(runtime audit MED):unsupported 列 VIDEO_ID=raw_<當下ts>,某輪 drain 寫入成功後
    // 因後續筆失敗 abort → 整段未 ack,下次 cron(新 storage 實例)重領同訊息;此時 raw_ 帶
    // 「新的」timestamp,append 的 VIDEO_ID 冪等護欄擋不住 → 舊版長出重複列。
    const url = "https://example.com/some/page"; // 非支援平台 → raw_
    const r1 = await runIngest(
      { text: `${url} 第一輪` },
      { storage: makeStorage(), expandShortUrls: false, now: FIXED },
    );
    expect(r1.reply).toContain("unsupported");
    expect(calls.append).toBe(1);

    // 下次 cron:全新 storage 實例(快取全空,靠讀回真表)、時間前進 5 分鐘(同一天)。
    const nextCron = () => FIXED() + 5 * 60_000;
    const r2 = await runIngest(
      { text: `${url} 第一輪` },
      { storage: makeStorage(), expandShortUrls: false, now: nextCron },
    );
    expect(r2.reply).toContain("已經存在"); // 護欄命中:同日 + 同 CLEAN_URL + 既有列 raw_
    expect(calls.append).toBe(1); // 沒有第二列
    expect(stagingRows).toHaveLength(1);
  });

  it("同輪稍後重複連結 → 命中 in-memory 索引(含剛 append 的那筆)、不再 append、仍不多打資料讀", async () => {
    const storage = makeStorage();
    const url = "https://www.tiktok.com/@u/video/7234567890";
    const r1 = await runIngest({ text: `${url} 第一次` }, { storage, expandShortUrls: false, now: FIXED });
    const r2 = await runIngest({ text: `${url} 又貼一次` }, { storage, expandShortUrls: false, now: FIXED });
    expect(r1.reply).toContain("已收進暫存區");
    expect(r2.reply).toContain("已經存在暫存區"); // 命中快取(含剛 append 的那筆)
    expect(calls.append).toBe(1); // 沒有重寫
    expect(calls.stagingDataGet).toBe(1); // 全程只讀一次暫存區全表
  });
});
