/**
 * dedupIndex 同 key 多列 → 保第一筆(audit LOW: dedup-index-last-wins):
 * 舊版建索引時後列覆蓋前列(保最後),但 duplicateMsg 文案寫「首次加入」——
 * 表上若有同 key 多列(歷史殘留/人工貼入),回覆顯示的日期會是最後一筆,與文案矛盾。
 * 釘住兩個實作(GoogleSheetsStorage / MemoryStorage)都保第一筆,行為一致。
 */
import { describe, it, expect, vi } from "vitest";
import { GoogleSheetsStorage } from "../src/storage/googleSheets.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { runCollect } from "../src/bot/handlers/collect.js";
import type { RefRow } from "../src/types.js";

const URL = "https://youtu.be/dQw4w9WgXcQ";
const FIRST: RefRow = { 平台: "youtube", 連結: URL, 挑: "", 加入日期: "2025-01-01" };
const LATER: RefRow = { 平台: "youtube", 連結: URL, 挑: "", 加入日期: "2026-06-30" };

describe("dedupIndex:同 key 多列保第一筆", () => {
  it("GoogleSheetsStorage:索引值 = 首列(不被後列覆蓋)", async () => {
    const s = new GoogleSheetsStorage({
      credentials: {
        client_email: "x@y.iam.gserviceaccount.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
      },
      sheetId: "sid",
      sheetName: "參考池",
    });
    // dedupIndex 走 readRows 建索引;mock 表上同 key 兩列(首列 2025、後列 2026)。
    vi.spyOn(s, "readRows").mockResolvedValue([
      { row: FIRST, rowNumber: 2 },
      { row: LATER, rowNumber: 3 },
    ]);
    const index = await s.dedupIndex();
    expect(index.size).toBe(1);
    expect([...index.values()][0]!.加入日期).toBe("2025-01-01");
  });

  it("MemoryStorage:同上(測試替身與 sheets 版行為一致)", async () => {
    const storage = new MemoryStorage([FIRST, LATER]);
    const index = await storage.dedupIndex();
    expect(index.size).toBe(1);
    expect([...index.values()][0]!.加入日期).toBe("2025-01-01");
  });

  it("端到端:重貼同連結 → duplicateMsg 顯示的「首次加入」= 第一筆的日期", async () => {
    const storage = new MemoryStorage([FIRST, LATER]);
    const r = await runCollect({ text: `${URL} 又貼一次` }, { storage, expandShortUrls: false });
    expect(r.reply).toContain("已經收過");
    expect(r.reply).toContain("首次加入");
    expect(r.reply).toContain("2025-01-01"); // 首列的日期
    expect(r.reply).not.toContain("2026-06-30"); // 不是最後一筆的

  });
});
