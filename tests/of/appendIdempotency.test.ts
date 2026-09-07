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
  it("alreadyDone 命中(拿不到 updatedRange)→ 作廢快取重讀,拿到真列號(絕不塞 rowNumber=0)", async () => {
    // 守的不變式一直是同一條:假列號 rowNumber=0 絕不進 DuplicateHit 契約(1-based)。
    // 舊 bug A(runtime audit LOW):alreadyDone 命中時解析落 0 仍併進快取 → 假列號污染契約。
    // 舊 bug B(本次稽核):為了避開 A 而改成「解析不到就不併」,結果同輪稍後的同一支影片
    //   查快取查不到 → 寫出第二列(fresh 讀只掛在 alreadyDone 上,而 alreadyDone 只在
    //   catch 裡跑,第一次就成功的 append 永遠不會問它)。
    // 現行解法:解析不到真列號就作廢整份快取,下次 videoIdIndex() 重讀拿真列號 —— 兩條都守住。
    // 這裡改成直接斷言不變式本體(列號是真的),而不是斷言它的副作用(key 不在快取裡);
    // 後者正好是 bug B 的長相,拿它當斷言等於把 bug 釘成規格。
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
    const cacheAfter = await s.videoIdIndex(); // 快取已作廢 → 這次會重讀全表
    expect(rawRowsSpy).toHaveBeenCalledTimes(3); // 建快取 1 + 護欄 fresh 讀 1 + 作廢後重讀 1
    const hit = cacheAfter.get("tt_123");
    expect(hit?.rowNumber).toBe(2); // 真列號(表上第 2 列),不是 0 —— 不變式本體
    expect(hit?.rowNumber).not.toBe(0);
  });

});
