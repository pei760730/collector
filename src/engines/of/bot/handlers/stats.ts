/**
 * /stats handler —— 暫存區彙總(純文字,不依賴 Telegraf,好測試)。
 * 總筆數 + 各平台 + 各狀態 + 本週/本月新增 + 最近 N 筆。
 */
import { PLATFORM_ICON } from "@pei760730/collector-core";
import type { Storage } from "../../storage/Storage.js";

export interface StatsDeps {
  storage: Storage;
  recentLimit?: number;
  now?: () => number;
}

export async function runStats(deps: StatsDeps): Promise<string> {
  const recentLimit = deps.recentLimit ?? 5;
  const nowMs = (deps.now ?? Date.now)();
  const s = await deps.storage.stats({ recentLimit, nowMs });

  if (s.total === 0) {
    return "📊 暫存區目前是空的。";
  }

  // 限筆數,避免亂資料把分類撐爆(Telegram 單則 4096 字上限)。
  const capList = (obj: Record<string, number>, max = 15) => {
    const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    const head = entries.slice(0, max).map(([k, n]) => `  ${k}:${n}`);
    if (entries.length > max) head.push(`  …(其餘 ${entries.length - max} 類)`);
    return head;
  };

  const platformLines = capList(s.byPlatform);
  const statusLines = capList(s.byStatus);
  const recentLines = s.recent.map((r) => {
    // core 的 PLATFORM_ICON 以顯示名為鍵(feed PLATFORM 欄存顯示名);feed 專屬的 "Other"
    // 不在 core union(core 只有 "Unknown"→❓,無 "Other" 鍵)→ 索引回 undefined,退回 🔗
    // (還原 v0.3.0 採用前 feed 對 Other 桶的顯示;此 fallback 為 feed 專屬)。
    const icon = PLATFORM_ICON[r.PLATFORM as keyof typeof PLATFORM_ICON] ?? "🔗";
    return `  ${icon} ${r.VIDEO_ID}(${r.STATUS},${r.DATE})`;
  });

  const out = [
    `📊 暫存區統計(共 ${s.total} 筆)`,
    "",
    "各平台:",
    ...platformLines,
    "",
    "各狀態:",
    ...statusLines,
    "",
    `本週新增:${s.addedThisWeek}　本月新增:${s.addedThisMonth}`,
    "",
    `最近 ${s.recent.length} 筆:`,
    ...recentLines,
  ].join("\n");

  // Telegram 單則上限 4096;保險再硬切。
  // 用 code point 切,避免 String.slice 把 emoji 的 surrogate pair 切一半吐出壞字
  // (孤兒 surrogate 會讓 Telegram sendMessage 回 400)。svb stats 同款。
  return out.length > 3900 ? [...out].slice(0, 3900).join("") + "\n…(已截斷)" : out;
}
