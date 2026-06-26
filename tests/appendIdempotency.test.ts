/**
 * append 冪等護欄(alreadyDone)讀放大防護:
 * 非冪等寫入(values.append)在「寫成功但回應遺失」時會觸發重試,withRetry 重試前先問
 * alreadyDone「上次其實成功了嗎?」。舊版每次重試都對既有 key 集合做一次全表讀(readRows),
 * 故障時(連環 429 / 暫時性網路錯)讀放大成 N 次。
 *
 * 修法:在單次 append 的重試窗內,護欄查詢「成功」就快取結果只讀一次;查詢「本身失敗」不快取,
 * 照常重試(降級保留)。本測試釘住「重試 3 次時 readRows 不被呼叫 3 次」。
 */
import { describe, it, expect, vi } from "vitest";
import { GoogleSheetsStorage } from "../src/storage/googleSheets.js";
import type { HeaderLayout } from "../src/storage/googleSheets.js";
import type { RefRow } from "../src/types.js";

const LAYOUT: HeaderLayout = { indexOf: { 平台: 0, 連結: 1, 挑: 2, 加入日期: 3 }, width: 4 };

const ROW: RefRow = {
  平台: "youtube",
  連結: "https://youtu.be/dQw4w9WgXcQ",
  挑: "",
  加入日期: "2026-06-26",
};

/** 建一個 storage,跳過 layout 網路(預塞 layoutCache),並可注入 append 行為。 */
function makeStorage(appendImpl: () => Promise<unknown>) {
  const s = new GoogleSheetsStorage({
    credentials: {
      client_email: "x@y.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
    },
    sheetId: "sid",
    sheetName: "參考池",
  });
  // 預塞表頭快取 → append 內 await this.layout() 不打網路。
  (s as unknown as { layoutCache?: HeaderLayout }).layoutCache = LAYOUT;
  // 攔 values.append:由 appendImpl 決定每次成功/失敗。
  const appendSpy = vi.fn(appendImpl);
  (s as unknown as { sheets: { spreadsheets: { values: { append: unknown } } } }).sheets = {
    spreadsheets: { values: { append: appendSpy } },
  } as never;
  return { s, appendSpy };
}

/** 退避 setTimeout 不要真的等(0.5s/1s/2s)。 */
function fakeTimers() {
  vi.useFakeTimers();
  return async () => {
    await vi.runAllTimersAsync();
  };
}

describe("append 冪等護欄:重試不放大全表讀", () => {
  it("護欄查詢成功 → 整個 append 重試窗內 readRows 至多讀一次(不隨重試次數 N 倍放大)", async () => {
    // append 連環 429(可重試),逼出多次重試;最後一次才成功。
    let calls = 0;
    const { s } = makeStorage(async () => {
      calls += 1;
      if (calls < 3) {
        const e = new Error("rate limit") as Error & { code: number };
        e.code = 429;
        throw e;
      }
      return { data: {} };
    });

    // 護欄查的既有 key 集合「不含」本連結 → alreadyDone 回 false,append 會照常重試到成功。
    const readRowsSpy = vi
      .spyOn(s, "readRows")
      .mockResolvedValue([]);

    const advance = fakeTimers();
    const p = s.append(ROW);
    await advance();
    await p;
    vi.useRealTimers();

    // 重試發生了(append 被打 3 次:2 次 429 + 1 次成功)。
    // 但護欄全表讀只該發生一次(快取於重試窗),不是每次重試各讀一次。
    expect(readRowsSpy.mock.calls.length).toBeLessThan(3);
    expect(readRowsSpy).toHaveBeenCalledTimes(1);
  });

  it("護欄查到本連結已存在 → 視為已完成,提早收手不再重打 append", async () => {
    let calls = 0;
    const { s, appendSpy } = makeStorage(async () => {
      calls += 1;
      const e = new Error("rate limit") as Error & { code: number };
      e.code = 429;
      throw e;
    });
    // 護欄回報:這連結已在表上(上次寫成功但回應遺失)。
    const readRowsSpy = vi
      .spyOn(s, "readRows")
      .mockResolvedValue([{ row: ROW, rowNumber: 2 }]);

    const advance = fakeTimers();
    const p = s.append(ROW);
    await advance();
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();

    // 第一次 append 失敗 → 護欄查到已存在 → 不再重試。append 只被打 1 次。
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(readRowsSpy).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
  });

  it("降級保留:護欄查詢本身失敗 → 不快取失敗、照常重試(不因為護欄掛了就放棄寫入)", async () => {
    let calls = 0;
    const { s, appendSpy } = makeStorage(async () => {
      calls += 1;
      if (calls < 3) {
        const e = new Error("rate limit") as Error & { code: number };
        e.code = 429;
        throw e;
      }
      return { data: {} };
    });
    // 護欄查詢每次都丟錯 → withRetry catch 後吞掉、照常重試。
    const readRowsSpy = vi
      .spyOn(s, "readRows")
      .mockRejectedValue(new Error("guard read failed"));

    const advance = fakeTimers();
    const p = s.append(ROW);
    await advance();
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();

    // append 仍重試到成功(3 次)。護欄查詢失敗不快取 → 每次重試前都重問一次。
    expect(appendSpy).toHaveBeenCalledTimes(3);
    // 失敗不快取:兩次重試各問一次護欄(成功那次無重試、不問)。
    expect(readRowsSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
