/**
 * 訊息模板 —— 一律純文字(不用 MarkdownV2)。
 * 改進#2:n8n 版用 MarkdownV2 但沒跳脫,含 . - ( ) 會發送失敗;
 * 純文字最穩,emoji 照常顯示,不必跳脫。
 */
import { PLATFORM_CODE, type Platform, type RefRow } from "../types.js";
import { PLATFORM_ICON } from "@pei760730/collector-core";

/** 小寫平台碼 → emoji。row.平台 存的是碼(tiktok…),不是顯示名。 */
const ICON_BY_CODE: Record<string, string> = Object.fromEntries(
  (Object.keys(PLATFORM_CODE) as Platform[]).map((p) => [PLATFORM_CODE[p], PLATFORM_ICON[p]]),
);

function iconFor(code: string): string {
  return ICON_BY_CODE[code] ?? "•";
}

export function formatErrorMsg(): string {
  return [
    "⚠️ 看不懂這則訊息。",
    "",
    "請貼「短影音連結 + 備註」,例如:",
    "https://www.tiktok.com/@user/video/1234567890 健身梗很好笑",
    "",
    "支援:TikTok / YouTube / Facebook / Instagram / Threads / X / 抖音 / 小紅書",
  ].join("\n");
}

export function successMsg(
  row: RefRow,
  opts: { unsupported: boolean; isShortUrl: boolean; note?: string },
): string {
  const lines = [
    `${iconFor(row.平台)} 已收進參考池`,
    `平台:${row.平台}`,
    `連結:${row.連結}`,
  ];
  if (opts.note) lines.push(`備註:${opts.note}`);
  lines.push(`加入日期:${row.加入日期}`);
  if (opts.unsupported) {
    // 抓不到 video id(平台不支援 / fallback):去重退回連結路徑,仍會收;提醒可能不準。
    lines.push("⚠️ 這個平台抓不到 video ID,以連結本身去重收錄。");
  }
  if (opts.isShortUrl) {
    lines.push("🔗 偵測到短網址,已標記。");
  }
  return lines.join("\n");
}

export function duplicateMsg(existing: RefRow): string {
  return [
    "♻️ 這支已經收過了,沒有重複寫入。",
    `連結:${existing.連結}`,
    `首次加入:${existing.加入日期}`,
  ].join("\n");
}

export function saveErrorMsg(detail: string): string {
  return ["❌ 寫入失敗,沒有存進參考池。", `原因:${detail}`].join("\n");
}
