/**
 * 訊息模板 —— 一律純文字(不用 MarkdownV2)。
 * 改進 #2:n8n 版用 MarkdownV2 但沒跳脫,含 . - ( ) 會發送失敗;純文字最穩。
 */
import type { StagingRow } from "../types.js";

export function formatErrorMsg(): string {
  return [
    "⚠️ 看不懂這則訊息,沒有抓到網址。",
    "",
    "請貼一則含影片連結的訊息,例如:",
    "https://www.instagram.com/reel/CxYz123",
    "",
    "支援:Instagram / TikTok / YouTube / Facebook / X / 小紅書 / Threads / 抖音",
  ].join("\n");
}

// core 在解析邊界截斷超長連結/備註(fanout-safety)。收錄回覆要明講,
// 別讓分享者以為存進暫存區的是完整值。
const TRUNCATED_LINE = "⚠️ 原訊息的連結或備註過長,已截斷處理(存的可能不是完整值)。";

/** 新收錄(pending_review)成功。 */
export function savedMsg(row: StagingRow, opts?: { truncated?: boolean }): string {
  const lines = [
    "✅ 已收進暫存區,待處理。",
    `平台:${row.PLATFORM}`,
    `VIDEO_ID:${row.VIDEO_ID}`,
    `狀態:${row.STATUS}`,
    `日期:${row.DATE}`,
  ];
  if (opts?.truncated) lines.push(TRUNCATED_LINE);
  return lines.join("\n");
}

/** 無法解析(unsupported)但仍存檔。 */
export function unsupportedMsg(row: StagingRow, opts?: { truncated?: boolean }): string {
  const lines = [
    "⚠️ 這個連結抓不到 video ID,已以 unsupported 收錄(待人工看)。",
    `平台:${row.PLATFORM}`,
    `連結:${row.CLEAN_URL}`,
    `狀態:${row.STATUS}`,
  ];
  if (opts?.truncated) lines.push(TRUNCATED_LINE);
  return lines.join("\n");
}

export function duplicateMsg(existing: StagingRow): string {
  return [
    "♻️ 這支已經存在暫存區,跳過,沒有重複寫入。",
    `VIDEO_ID:${existing.VIDEO_ID}`,
    `首次日期:${existing.DATE}`,
  ].join("\n");
}

export function approvedDuplicateMsg(cleanUrl: string): string {
  return [
    "♻️ 這支已經存在總表/待拍池,跳過,沒有重複寫入暫存區。",
    `連結:${cleanUrl.trim()}`,
  ].join("\n");
}

export function saveErrorMsg(detail: string): string {
  return ["❌ 寫入失敗,沒有存進暫存區。", `原因:${detail}`].join("\n");
}

export function deniedMsg(id?: number): string {
  // 帶上發訊者自己的 id → 被擋的自己人截圖給管理員,管理員直接把這串加進白名單即可,
  // 免得像 2026-07-07 那樣要翻 Actions log 才撈得到 id。id 不明(理論上不會)時退回原句。
  const base = "你沒有使用權限，請聯絡管理員";
  return id == null ? base : `${base}。\n你的 ID：${id}（把這串傳給管理員加進白名單即可）`;
}
