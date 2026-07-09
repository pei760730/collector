/**
 * /stats handler。預設版(邊做邊修):
 * 總筆數 + 各平台筆數 + 本週/本月新增 + 最近 5 筆。
 * 來源 = 參考池(2026-06-22 起;暫存區已退役)。已挑走的素材會搬離參考池,
 * 故此統計反映「目前池中(還沒挑)」的素材,不含已挑/已拍。
 */
import type { Storage } from "../../storage/Storage.js";
import { iconFor } from "../../platformIcon.js";

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
    return "📊 參考池目前是空的。";
  }

  // 限筆數,避免亂資料把分類撐爆(Telegram 4096 字上限)
  const capList = (obj: Record<string, number>, max = 15) => {
    const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
    const head = entries.slice(0, max).map(([k, n]) => `  ${k}：${n}`);
    if (entries.length > max) head.push(`  …(其餘 ${entries.length - max} 類)`);
    return head;
  };
  const platformLines = capList(s.byPlatform);

  // iconFor 內建「認不得的碼 → •」fallback,不再手工重做 ICON_BY_CODE[...] ?? "•"。
  const recentLines = s.recent.map((r) => `  ${iconFor(r.平台)} ${r.連結}（${r.加入日期}）`);

  const out = [
    `📊 參考池統計（共 ${s.total} 筆未挑）`,
    "",
    "各平台：",
    ...platformLines,
    "",
    `本週新增：${s.addedThisWeek}　本月新增：${s.addedThisMonth}`,
    "",
    `最近 ${s.recent.length} 筆:`,
    ...recentLines,
  ].join("\n");

  // Telegram 單則上限 4096;保險再硬切
  // 用 code point 切,避免 String.slice 把 emoji 的 surrogate pair 切一半吐出壞字。
  return out.length > 3900 ? [...out].slice(0, 3900).join("") + "\n…(已截斷)" : out;
}
