/** of 專屬：alreadyDone 沒有 updatedRange 時，不得把 rowNumber=0 假列號併進 videoIdCache。 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { GoogleSheetsStorage } from "../../src/engines/of/storage/googleSheets.js";
import type { HeaderLayout } from "@pei760730/collector-core";
import type { StagingRow } from "../../src/engines/of/types.js";

const LAYOUT: HeaderLayout = {
  indexOf: { PLATFORM: 0, DATE: 1, CLEAN_URL: 2, VIDEO_ID: 3, STATUS: 4 },
  width: 5,
};

const ROW: StagingRow = {
  PLATFORM: "TikTok",
  DATE: "2026-07-08",
  CLEAN_URL: "https://www.tiktok.com/@u/video/123",
  VIDEO_ID: "tt_123",
  STATUS: "pending_review",
};

/** ROW 對應的原始 cells(供 mock rawRows 回傳,讓護欄看到「已存在」)。 */
const ROW_CELLS = ["TikTok", "2026-07-08", ROW.CLEAN_URL, "tt_123", "pending_review"];

type RawRow = { rowNumber: number; cells: string[] };

/** 建一個 storage,預塞 layoutCache(append 內 await layout 不打網路),並可注入 append 行為。 */
function makeStorage(appendImpl: () => Promise<unknown>) {
  const s = new GoogleSheetsStorage({
    credentials: {
      client_email: "x@y.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
    },
    sheetId: "sid",
    sheetName: "暫存區",
    prodSheetName: "總表",
  });
  (s as unknown as { layoutCache?: HeaderLayout }).layoutCache = LAYOUT;
  const appendSpy = vi.fn(appendImpl);
  (s as unknown as { sheets: { spreadsheets: { values: { append: unknown } } } }).sheets = {
    spreadsheets: { values: { append: appendSpy } },
  } as never;
  return { s, appendSpy };
}

/** spy 私有 rawRows(護欄的全表讀來源)。 */
function spyRawRows(s: GoogleSheetsStorage) {
  return vi.spyOn(s as unknown as { rawRows: (l: HeaderLayout) => Promise<RawRow[]> }, "rawRows");
}

function fakeTimers() {
  vi.useFakeTimers();
  return async () => {
    await vi.runAllTimersAsync();
  };
}

function rateLimit(): Error & { code: number } {
  const e = new Error("rate limit") as Error & { code: number };
  e.code = 429;
  return e;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("of append 成功後快取", () => {
  it("alreadyDone 命中(拿不到 updatedRange)→ 不併去重快取(不塞 rowNumber=0 假列號)", async () => {
    // 舊 bug(runtime audit LOW):alreadyDone 命中時 withRetry 回 undefined、無 updatedRange,
    // 解析落 rowNumber=0 仍併進 videoIdCache → 假列號污染 DuplicateHit 契約(1-based)。
    const { s, appendSpy } = makeStorage(async () => {
      throw rateLimit();
    });
    // 第一次讀(建快取)= 空表;之後的讀(護欄 fresh 讀)= 該列已在表上(上次寫成功但回應遺失)。
    const rawRowsSpy = spyRawRows(s)
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ rowNumber: 2, cells: ROW_CELLS }]);

    const cacheBefore = await s.videoIdIndex(); // 先建實例級去重快取(空)
    expect(cacheBefore.size).toBe(0);

    const advance = fakeTimers();
    const p = s.append(ROW);
    await advance();
    await expect(p).resolves.toBeUndefined(); // alreadyDone 命中,視為完成
    vi.useRealTimers();

    expect(appendSpy).toHaveBeenCalledTimes(1);
    const cacheAfter = await s.videoIdIndex(); // 同一份實例快取(不重讀)
    expect(cacheAfter.get("tt_123")).toBeUndefined(); // 不併入假列號
    expect(rawRowsSpy).toHaveBeenCalledTimes(2); // 建快取 1 次 + 護欄 fresh 讀 1 次
  });

});
