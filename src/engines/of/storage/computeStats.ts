/**
 * 從暫存區列算統計 —— 純函式,memory / googleSheets 共用,好測試。
 */
import type { StagingRow } from "../types.js";
import type { StatsSummary } from "./Storage.js";
import { ageInDays } from "../utils/date.js";

export function computeStats(
  rows: StagingRow[],
  opts: { recentLimit: number; nowMs: number },
): StatsSummary {
  const byPlatform: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let addedThisWeek = 0;
  let addedThisMonth = 0;

  for (const r of rows) {
    const p = r.PLATFORM?.trim() || "未知";
    byPlatform[p] = (byPlatform[p] ?? 0) + 1;

    const s = r.STATUS?.trim() || "未知";
    byStatus[s] = (byStatus[s] ?? 0) + 1;

    const age = ageInDays(r.DATE, opts.nowMs);
    if (age <= 7) addedThisWeek++;
    if (age <= 30) addedThisMonth++;
  }

  // 最近 N 筆 = 檔尾(append 在尾端,愈後面愈新),反轉成由新到舊。
  const recent = rows.slice(-opts.recentLimit).reverse();

  return {
    total: rows.length,
    byPlatform,
    byStatus,
    addedThisWeek,
    addedThisMonth,
    recent,
  };
}
