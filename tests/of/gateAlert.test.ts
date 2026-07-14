/**
 * 總表去重 gate 失效告警(onGateSkip)。
 *
 * gate 是 fail-soft(失效照常收錄),但它是全 pipeline 唯一「下游改變收集行為」的
 * 跨系統閉環——斷了不能無聲。本檔釘住:三個失效路徑(讀表頭失敗/找不到 URL 欄/讀資料失敗)
 * 都會觸發 onGateSkip 且維持 return false(行為不變);正常路徑不觸發;不給 callback 不炸。
 *
 * 測試用非暫態錯誤({ code: 400 }):core withRetry 對非暫態 fail-fast 直接丟,不退避,測試快。
 */
import { describe, expect, it, vi } from "vitest";

import { GoogleSheetsStorage } from "../../src/engines/of/storage/googleSheets.js";

const DUMMY_CREDS = { client_email: "t@t.iam", private_key: "k" };

function makeStorage(getImpl: (req: { range: string }) => Promise<unknown>, onGateSkip?: (d: string) => void) {
  const storage = new GoogleSheetsStorage({
    credentials: DUMMY_CREDS,
    sheetId: "sheet-id",
    sheetName: "暫存區",
    prodSheetName: "總表",
    onGateSkip,
  });
  // 注入假 sheets client(不打網路)。private 欄位,測試專用繞道。
  (storage as unknown as { sheets: unknown }).sheets = {
    spreadsheets: { values: { get: getImpl } },
  };
  return storage;
}

describe("findApprovedByUrl gate 失效告警", () => {
  it("讀表頭失敗:return false + 觸發 onGateSkip(無法讀取分頁)", async () => {
    const onGateSkip = vi.fn();
    const storage = makeStorage(() => Promise.reject({ code: 400 }), onGateSkip);
    await expect(storage.findApprovedByUrl("https://x.test/v/1")).resolves.toBe(false);
    expect(onGateSkip).toHaveBeenCalledTimes(1);
    expect(onGateSkip).toHaveBeenCalledWith(expect.stringContaining("無法讀取分頁 總表"));
  });

  it("表頭缺「影片連結」欄:return false + 觸發 onGateSkip(找不到欄)", async () => {
    const onGateSkip = vi.fn();
    const storage = makeStorage(
      () => Promise.resolve({ data: { values: [["狀態", "備註"]] } }),
      onGateSkip,
    );
    await expect(storage.findApprovedByUrl("https://x.test/v/1")).resolves.toBe(false);
    expect(onGateSkip).toHaveBeenCalledTimes(1);
    expect(onGateSkip).toHaveBeenCalledWith(expect.stringContaining("找不到「影片連結」欄"));
  });

  it("讀資料欄失敗:return false + 觸發 onGateSkip(無法讀取欄)", async () => {
    const onGateSkip = vi.fn();
    const storage = makeStorage((req) => {
      if (req.range.includes("1:1")) {
        return Promise.resolve({ data: { values: [["影片連結", "狀態"]] } });
      }
      return Promise.reject({ code: 400 });
    }, onGateSkip);
    await expect(storage.findApprovedByUrl("https://x.test/v/1")).resolves.toBe(false);
    expect(onGateSkip).toHaveBeenCalledTimes(1);
    expect(onGateSkip).toHaveBeenCalledWith(expect.stringContaining("無法讀取 總表 的「影片連結」欄"));
  });

  it("正常路徑(命中/未命中)不觸發 onGateSkip", async () => {
    const onGateSkip = vi.fn();
    const storage = makeStorage((req) => {
      if (req.range.includes("1:1")) {
        return Promise.resolve({ data: { values: [["影片連結"]] } });
      }
      return Promise.resolve({ data: { values: [["https://x.test/v/1"]] } });
    }, onGateSkip);
    await expect(storage.findApprovedByUrl("https://x.test/v/1")).resolves.toBe(true);
    await expect(storage.findApprovedByUrl("https://x.test/v/2")).resolves.toBe(false);
    expect(onGateSkip).not.toHaveBeenCalled();
  });

  it("不給 onGateSkip:失效路徑照舊 fail-soft,不炸", async () => {
    const storage = makeStorage(() => Promise.reject({ code: 400 }));
    await expect(storage.findApprovedByUrl("https://x.test/v/1")).resolves.toBe(false);
  });
});
