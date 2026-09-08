/**
 * 2026-08-01 突變測試倖存者 M11 回填:擋回流 gate 的抗規則漂移正規化。
 *
 * 總表歷史列是「當年的清理規則」寫進去的,可能帶追蹤參數;approvedKeySet 存入前
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

// ── 2026-09-08:閘門改比 groupKey,而不是原始 CLEAN_URL ────────────────────────
// CLEAN_URL 完全比對讓這道閘門對「參數」與「網址形態」都敏感:同一支影片只要換一種
// 分享形態(youtu.be vs watch?v=)或帶一個 TRACKING_PARAMS 還沒收錄的新參數,清出來的
// 字串就不同 → 已產出的片直接穿過閘門、重新收進暫存區。groupKey 是「同一支片同一把鍵」
// 的既有演算法(跨語言契約守著),拿它比對就把整個「參數/形態敏感」類別一次消掉。
//
// 安全性:這道閘門只在 `!ex.unsupported`(core 真的抽到 video id)時才會被查,所以
// 進來的鍵一定是 `平台_id` 形態,不會是 groupKey 的路徑 fallback(那個會砍掉 query、
// 有過度攔截風險)。歷史列即使算出路徑 key 也只是躺在集合裡 —— 路徑 key 以 http 開頭,
// 永遠不可能等於 id key。下面兩條負向測試把這個界線釘住。
describe("of 擋回流 gate:比 groupKey 不比字串(2026-09-08)", () => {
  it("同片不同形態(youtu.be ↔ watch?v=)必須擋得住", async () => {
    const s = makeStorage(["https://youtu.be/dQw4w9WgXcQ"]);
    await expect(
      s.findApprovedByUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).resolves.toBe(true);
  });

  it("同片帶「清單還沒收錄」的新分享參數也擋得住(參數敏感類別根除)", async () => {
    const s = makeStorage(["https://www.tiktok.com/@u/video/123"]);
    await expect(
      s.findApprovedByUrl("https://www.tiktok.com/@u/video/123?brand_new_share_param=zzz"),
    ).resolves.toBe(true);
  });

  it("跨平台同數字 id 不誤擋(groupKey 帶平台命名空間)", async () => {
    const s = makeStorage(["https://www.tiktok.com/@u/video/7234567890123456789"]);
    await expect(
      s.findApprovedByUrl("https://www.douyin.com/video/7234567890123456789"),
    ).resolves.toBe(false);
  });

  it("負向:歷史列是抽不到 id 的連結(退路徑 key)→ 不會誤擋別支有 id 的片", async () => {
    const s = makeStorage(["https://example.com/some/page"]);
    await expect(
      s.findApprovedByUrl("https://www.tiktok.com/@u/video/123"),
    ).resolves.toBe(false);
  });

  it("負向:同平台不同片仍然放行", async () => {
    const s = makeStorage(["https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    await expect(
      s.findApprovedByUrl("https://www.youtube.com/watch?v=AAAAAAAAAAA"),
    ).resolves.toBe(false);
  });
});
