import { describe, expect, it } from "vitest";
import { computeStats as poolStats } from "../src/storage/computeStats.js";
import { computeStats as ofStats } from "../src/engines/of/storage/computeStats.js";
import type { RefRow } from "../src/types.js";
import type { StagingRow } from "../src/engines/of/types.js";

describe("local statistics date bounds", () => {
  // Both UTC instants are July 8 in Asia/Taipei, on opposite sides of UTC midnight.
  for (const nowMs of [Date.UTC(2026, 6, 7, 16, 1), Date.UTC(2026, 6, 8, 15, 59)]) {
    it.each([
      ["2026-07-09", 0, 0], // future
      ["2026-07-08", 1, 1], // today
      ["2026-07-01", 1, 1], // inclusive age 7
      ["2026-06-30", 0, 1], // age 8
      ["2026-06-08", 0, 1], // inclusive age 30
      ["2026-06-07", 0, 0], // age 31
      ["", 0, 0],
      ["invalid", 0, 0],
    ])("%s at " + nowMs, (date, week, month) => {
      const pool: RefRow[] = [{ 平台: "x", 連結: "https://example.test/a", 挑: "", 加入日期: date }];
      const of: StagingRow[] = [{ PLATFORM: "TikTok", DATE: date.replaceAll("-", "/"), CLEAN_URL: "https://example.test/a", VIDEO_ID: "tt_a", STATUS: "pending_review" }];
      const originals = structuredClone({ pool, of });
      for (const stats of [poolStats(pool, { nowMs, recentLimit: 5 }), ofStats(of, { nowMs, recentLimit: 5 })]) {
        expect.soft(stats.addedThisWeek).toBe(week);
        expect.soft(stats.addedThisMonth).toBe(month);
        expect(stats.total).toBe(1);
        expect(Object.values(stats.byPlatform)).toEqual([1]);
        expect(stats.recent).toHaveLength(1);
      }
      expect(ofStats(of, { nowMs, recentLimit: 5 }).byStatus).toEqual({ pending_review: 1 });
      expect({ pool, of }).toEqual(originals);
    });
  }
});
