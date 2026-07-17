/**
 * append 冪等護欄(alreadyDone)讀放大防護:
 * 非冪等寫入(values.append)在「寫成功但回應遺失」時會觸發重試,withRetry 重試前先問
 * alreadyDone「上次其實成功了嗎?」(feed 以 VIDEO_ID 為穩定鍵)。舊版每次重試都對既有
 * VIDEO_ID 集合做一次全表讀(rawRows),故障時(連環 429 / 暫態網路錯)讀放大成 N 次。
 *
 * 修法:在單次 append 的重試窗內,護欄查詢「成功」就快取結果只讀一次;查詢「本身失敗」不快取,
 * 照常重試(降級保留)。本測釘住三態:成功快取只讀一次 / 查到已存在提早收手 / 失敗不快取。
 *
 * 註:護欄讀的是「當下 fresh 全表」(freshVideoIds→rawRows),不是實例級去重快取 videoIdCache
 * (那是凍結快照,偵測不到「上次寫成功但回應遺失」)。此處 videoIdCache 未建 → append 尾端併入為 no-op。
 */
import { describe, it, expect, vi } from "vitest";
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

describe("append 冪等護欄:重試不放大全表讀", () => {
  it("護欄查詢成功 → 整個 append 重試窗內 rawRows 至多讀一次(不隨重試 N 倍放大)", async () => {
    let calls = 0;
    const { s } = makeStorage(async () => {
      calls += 1;
      if (calls < 3) throw rateLimit();
      return { data: {} };
    });
    // 護欄查的既有 VIDEO_ID 集合「不含」本片 → alreadyDone 回 false,append 照常重試到成功。
    const rawRowsSpy = spyRawRows(s).mockResolvedValue([]);

    const advance = fakeTimers();
    const p = s.append(ROW);
    await advance();
    await p;
    vi.useRealTimers();

    expect(rawRowsSpy).toHaveBeenCalledTimes(1); // 快取於重試窗,非每次重試各讀一次
  });

  it("護欄查到本 VIDEO_ID 已存在 → 視為已完成,提早收手不再重打 append", async () => {
    let calls = 0;
    const { s, appendSpy } = makeStorage(async () => {
      calls += 1;
      throw rateLimit();
    });
    // 護欄回報:這片已在表上(上次寫成功但回應遺失)。
    const rawRowsSpy = spyRawRows(s).mockResolvedValue([{ rowNumber: 2, cells: ROW_CELLS }]);

    const advance = fakeTimers();
    const p = s.append(ROW);
    await advance();
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();

    expect(appendSpy).toHaveBeenCalledTimes(1); // 第一次失敗 → 護欄查到已存在 → 不再重試
    expect(rawRowsSpy).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
  });

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

  it("降級保留:護欄查詢本身失敗 → 不快取失敗、照常重試(不因護欄掛了就放棄寫入)", async () => {
    let calls = 0;
    const { s, appendSpy } = makeStorage(async () => {
      calls += 1;
      if (calls < 3) throw rateLimit();
      return { data: {} };
    });
    const rawRowsSpy = spyRawRows(s).mockRejectedValue(new Error("guard read failed"));

    const advance = fakeTimers();
    const p = s.append(ROW);
    await advance();
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();

    expect(appendSpy).toHaveBeenCalledTimes(3); // 仍重試到成功
    // 失敗不快取:兩次重試各問一次護欄(成功那次無重試、不問)。
    expect(rawRowsSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
