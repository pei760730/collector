import { describe, expect, it } from "vitest";
import { runStats } from "../src/bot/handlers/stats.js";
import { MemoryStorage } from "../src/storage/memory.js";
import type { RefRow } from "../src/types.js";

function row(platform: string, link: string, date = "2026-08-18"): RefRow {
  return { 平台: platform, 連結: link, 挑: "", 加入日期: date };
}

describe("runStats — 參考池統計訊息", () => {
  it("空池使用預設時間與筆數，回空提示", async () => {
    await expect(runStats({ storage: new MemoryStorage() })).resolves.toBe("📊 參考池目前是空的。");
  });

  it("有資料時傳遞 recentLimit/now，並輸出平台、期間與最近資料", async () => {
    const now = Date.UTC(2026, 7, 18);
    const storage = new MemoryStorage([
      row("tiktok", "https://www.tiktok.com/@u/video/1"),
      row("unknown-code", "https://example.com/video/2", "2020-01-01"),
    ]);

    const reply = await runStats({ storage, recentLimit: 1, now: () => now });

    expect(reply).toContain("共 2 筆未挑");
    expect(reply).toContain("tiktok：1");
    expect(reply).toContain("unknown-code：1");
    expect(reply).toContain("本週新增：1　本月新增：1");
    expect(reply).toContain("最近 1 筆");
    expect(reply).toContain("• https://example.com/video/2（2020-01-01）");
  });

  it("平台超過 15 類會收合，超長訊息以 code point 安全截斷", async () => {
    const rows = Array.from({ length: 16 }, (_, i) =>
      row(`platform-${i}`, `https://example.com/${i}/${"😀".repeat(2_000)}`),
    );

    const reply = await runStats({
      storage: new MemoryStorage(rows),
      recentLimit: 1,
      now: () => Date.UTC(2026, 7, 18),
    });

    expect(reply).toContain("…(其餘 1 類)");
    expect([...reply].length).toBeGreaterThan(2_000);
    expect([...reply].length).toBeLessThanOrEqual(3_907);
    expect(reply.endsWith("\n…(已截斷)")).toBe(true);
    expect(reply).not.toMatch(/[\uD800-\uDFFF]/u);
  });
});
