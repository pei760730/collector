/**
 * Extract Video ID — 從乾淨網址抽出帶平台前綴的唯一 ID。
 * 抓不到 → unknown_<timestamp> 且標 unsupported。
 * `now` 可注入以利測試(預設 Date.now())。
 */
import type { Platform, VideoIdInfo } from "../types.js";

/** 依序試多個 pattern,回傳第一個命中的 capture group。 */
function firstMatch(url: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = url.match(re);
    if (m) {
      // 取最後一個非空 capture group(有些 pattern 第 2 組才是 id)
      for (let i = m.length - 1; i >= 1; i--) {
        if (m[i]) return m[i] as string;
      }
    }
  }
  return null;
}

const TIKTOK_PATTERNS = [
  /video\/(\d+)/,
  /item_id=(\d+)/,
  /discover\/(.*?)\?/,
  /(\d{19})/,
];
const INSTAGRAM_PATTERNS = [/\/(p|reel)\/([a-zA-Z0-9_-]+)/];
// 只認真正帶影片 id 的形態 —— 不要用裸 `/([11])`,否則 /channel/UC… 之類會被誤抓。
const YOUTUBE_PATTERNS = [
  /shorts\/([a-zA-Z0-9_-]{11})/,
  /[?&]v=([a-zA-Z0-9_-]{11})/,
  /youtu\.be\/([a-zA-Z0-9_-]{11})/,
  /\/embed\/([a-zA-Z0-9_-]{11})/,
  /\/live\/([a-zA-Z0-9_-]{11})/,
];
const XHS_PATTERNS = [/\/explore\/([a-zA-Z0-9]+)/];
const THREADS_PATTERNS = [/\/post\/([a-zA-Z0-9_-]+)/];

export function extractVideoId(
  platform: Platform,
  cleanUrl: string,
  now: () => number = Date.now,
): VideoIdInfo {
  const url = cleanUrl ?? "";
  let raw: string | null = null;
  let prefix = "";

  switch (platform) {
    case "TikTok":
      prefix = "tiktok";
      raw = firstMatch(url, TIKTOK_PATTERNS);
      break;
    case "Instagram":
      prefix = "ig";
      raw = firstMatch(url, INSTAGRAM_PATTERNS);
      break;
    case "YouTube":
      prefix = "yt";
      raw = firstMatch(url, YOUTUBE_PATTERNS);
      break;
    case "小紅書":
      prefix = "xhs";
      raw = firstMatch(url, XHS_PATTERNS);
      break;
    case "Threads":
      prefix = "threads";
      raw = firstMatch(url, THREADS_PATTERNS);
      break;
    // Facebook / X / 抖音:n8n 版沒有抽 ID 規則 → 視為不支援
    default:
      raw = null;
  }

  if (!raw) {
    return { videoId: `unknown_${now()}`, unsupported: true };
  }
  return { videoId: `${prefix}_${raw}`, unsupported: false };
}
