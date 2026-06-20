/**
 * /stats handler。預設版(邊做邊修):
 * 總筆數 + 各平台筆數 + 本週/本月新增 + 狀態分布 + 最近 5 筆。
 */
import type { Storage } from "../../storage/Storage.js";
import type { Platform } from "../../types.js";
import { PLATFORM_ICON } from "../../pipeline/detectPlatform.js";

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

  // 限筆數,避免亂資料把分類撐爆(Telegram 4096 字上限)
  const capList = (obj: Record<string, number>, max = 15) => {
    const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    const head = entries.slice(0, max).map(([k, n]) => `  ${k}：${n}`);
    if (entries.length > max) head.push(`  …(其餘 ${entries.length - max} 類)`);
    return head;
  };
  const platformLines = capList(s.byPlatform);
  const statusLines = capList(s.byStatus);

  const recentLines = s.recent.map((r) => {
    const note = r.NOTE ? ` — ${r.NOTE}` : "";
    const icon = PLATFORM_ICON[r.PLATFORM as Platform] ?? "•";
    return `  ${icon} ${r.VIDEO_ID}${note}（${r.DATE}）`;
  });

  const out = [
    `📊 暫存區統計（共 ${s.total} 筆）`,
    "",
    "各平台：",
    ...platformLines,
    "",
    `本週新增：${s.addedThisWeek}　本月新增：${s.addedThisMonth}`,
    "",
    "狀態：",
    ...statusLines,
    "",
    `最近 ${s.recent.length} 筆：`,
    ...recentLines,
  ].join("\n");

  // Telegram 單則上限 4096;保險再硬切
  return out.length > 3900 ? out.slice(0, 3900) + "\n…(已截斷)" : out;
}
