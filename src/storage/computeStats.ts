/**
 * 從資料列算統計 —— 純函式,memory / googleSheets 共用。
 */
import type { RefRow } from "../types.js";
import type { StatsSummary } from "./Storage.js";
import { ageInDays } from "../utils/date.js";

export function computeStats(
  rows: RefRow[],
  opts: { recentLimit: number; nowMs: number },
): StatsSummary {
  const byPlatform: Record<string, number> = {};
  let addedThisWeek = 0;
  let addedThisMonth = 0;

  for (const r of rows) {
    const p = r.平台 || "未知";
    byPlatform[p] = (byPlatform[p] ?? 0) + 1;

    const age = ageInDays(r.加入日期, opts.nowMs);
    if (age <= 7) addedThisWeek++;
    if (age <= 30) addedThisMonth++;
  }

  // 最近 N 筆 = 檔尾(append 在尾端,愈後面愈新)
  const recent = rows.slice(-opts.recentLimit).reverse();

  return {
    total: rows.length,
    byPlatform,
    addedThisWeek,
    addedThisMonth,
    recent,
  };
}
