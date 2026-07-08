import { describe, expect, it } from "vitest";

import { computeStats } from "../src/storage/computeStats.js";
import type { RefRow } from "../src/types.js";

// 2026-07-08T01:00Z = 2026-07-08 09:00 台北。
const NOW = Date.UTC(2026, 6, 8, 1, 0, 0);

function row(平台: string, 加入日期: string): RefRow {
  return { 平台, 連結: `https://x/${平台}${加入日期}`, 挑: "", 加入日期 } as RefRow;
}

describe("computeStats", () => {
  it("總數 / 各平台 / 週月滾動窗 / 空日期不計 / recent 反序", () => {
    const rows = [
      row("tiktok", "2026-07-08"), // age 0 → 週+月
      row("youtube", "2026-07-01"), // age 7 → 週+月
      row("tiktok", "2026-06-30"), // age 8 → 只月
      row("x", "2026-05-01"), // age >30 → 都不計
      row("tiktok", ""), // 空日期 → ageInDays=Infinity,兩窗都不計
    ];
    const s = computeStats(rows, { recentLimit: 2, nowMs: NOW });
    expect(s.total).toBe(5);
    expect(s.byPlatform.tiktok).toBe(3);
    expect(s.byPlatform.youtube).toBe(1);
    expect(s.addedThisWeek).toBe(2); // age<=7:07-08、07-01
    expect(s.addedThisMonth).toBe(3); // age<=30:07-08、07-01、06-30
    expect(s.recent.map((r) => r.加入日期)).toEqual(["", "2026-05-01"]); // 檔尾 2 筆反序
  });

  it("空池 → 全 0", () => {
    const s = computeStats([], { recentLimit: 5, nowMs: NOW });
    expect(s.total).toBe(0);
    expect(s.addedThisWeek).toBe(0);
    expect(s.addedThisMonth).toBe(0);
    expect(s.recent).toEqual([]);
  });
});
