/**
 * 2026-08-01 突變測試倖存者 M11 回填:擋回流 gate 的抗規則漂移正規化。
 *
 * 總表歷史列是「當年的清理規則」寫進去的,可能帶追蹤參數;approvedUrlSet 存入前
 * 必須過現行 core cleanUrl,否則乾淨的新進連結對不上舊列 → 已上總表的影片
 * 被重複收錄(of pipeline 唯一的跨系統閉環靜默失效)。此行為此前零覆蓋。
 */
import { describe, expect, it, vi } from "vitest";
import { GoogleSheetsStorage } from "../../src/engines/of/storage/googleSheets.js";

function makeStorage(prodUrls: string[]) {
  const s = new GoogleSheetsStorage({
    credentials: {
      client_email: "x@y.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
    },
    sheetId: "sid",
    sheetName: "暫存區",
    prodSheetName: "總表",
  });
  const get = vi.fn(async ({ range }: { range: string }) => {
    if (range.includes("1:1")) {
      return { data: { values: [["日期", "影片連結", "狀態"]] } };
    }
    return { data: { values: prodUrls.map((u) => [u]) } };
  });
  (s as unknown as { sheets: { spreadsheets: { values: { get: unknown } } } }).sheets = {
    spreadsheets: { values: { get } },
  } as never;
  return s;
}

describe("of 擋回流 gate 抗規則漂移(M11)", () => {
  it("歷史列帶追蹤參數 → 乾淨網址查詢仍命中", async () => {
    const s = makeStorage(["https://www.tiktok.com/@u/video/123?utm_source=x&utm_medium=share"]);
    await expect(
      s.findApprovedByUrl("https://www.tiktok.com/@u/video/123"),
    ).resolves.toBe(true);
  });

  it("未上總表的影片不誤擋", async () => {
    const s = makeStorage(["https://www.tiktok.com/@u/video/123?utm_source=x"]);
    await expect(
      s.findApprovedByUrl("https://www.tiktok.com/@u/video/999"),
    ).resolves.toBe(false);
  });
});
