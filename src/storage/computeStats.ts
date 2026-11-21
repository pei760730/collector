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
  // Sheet 的預填勾選框或殘留欄位可能讓空白列出現在 API 回應；沒有連結就不是參考素材。
  const pool = rows.filter((row) => row.連結.trim() !== "");
  const byPlatform: Record<string, number> = {};
  let addedThisWeek = 0;
  let addedThisMonth = 0;

  for (const r of pool) {
    const p = r.平台 || "未知";
    byPlatform[p] = (byPlatform[p] ?? 0) + 1;

    const age = ageInDays(r.加入日期, opts.nowMs);
    if (age >= 0 && age <= 7) addedThisWeek++;
    if (age >= 0 && age <= 30) addedThisMonth++;
  }

  // 最近 N 筆 = 檔尾(append 在尾端,愈後面愈新)
  const recent = opts.recentLimit > 0 ? pool.slice(-opts.recentLimit).reverse() : [];

  return {
    total: pool.length,
    byPlatform,
    addedThisWeek,
    addedThisMonth,
    recent,
  };
}
