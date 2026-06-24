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
  // 只認「路徑段」的 19 位純數字 video id(如 vt.tiktok.com/<19位>):前面要有 `/`、
  // 後面不接數字。否則 ?sec_uid=<19位>(query)、20 位數字截前 19 位 會被偽造成假影片 id。
  // discover/ 搜尋頁不是影片,移除其規則 → 落到 unknown_*/unsupported,不混進真影片。
  /\/(\d{19})(?!\d)/,
];
const INSTAGRAM_PATTERNS = [/\/(p|reel)\/([a-zA-Z0-9_-]+)/];
// 只認真正帶影片 id 的形態 —— 不要用裸 `/([11])`,否則 /channel/UC… 之類會被誤抓。
// 結尾 (?![a-zA-Z0-9_-]) 右邊界:YouTube ID 恰 11 碼。沒邊界時非 11 碼(如 12 碼)
// 會被「靜默吃前 11 碼」造出截斷的錯 id;有邊界 → 非 11 碼整段不命中 → 落 unknown_*(同 TikTok 19 碼邊界的教訓)。
const YOUTUBE_PATTERNS = [
  /shorts\/([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/,
  /[?&]v=([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/,
  /youtu\.be\/([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/,
  /\/embed\/([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/,
  /\/live\/([a-zA-Z0-9_-]{11})(?![a-zA-Z0-9_-])/,
];
// 小紅書筆記兩種正規路徑:/explore/<id> 與 /discovery/item/<id>(分享連結常見後者)。
const XHS_PATTERNS = [/\/explore\/([a-zA-Z0-9]+)/, /\/discovery\/item\/([a-zA-Z0-9]+)/];
const THREADS_PATTERNS = [/\/post\/([a-zA-Z0-9_-]+)/];

/**
 * Facebook 抽 ID(port 自 OF-DOG;比 n8n 版「Facebook 一律 unknown」強)。
 * 四種形態依序試,各帶不同前綴讓 dedup key 不互撞(前綴只進去重 key,不寫 Sheet):
 *   A. fb.watch/<code>            → fbw_
 *   B. /(reel|reels|videos)/<n>   → fb_
 *   C. /share/[rvp]/<code>        → fbs_
 *   D. query story_fbid 或 v      → fb_
 * 四種都不中(如純個人頁 / 社團)→ 回 null,退 unknown_ + 連結路徑去重(行為同舊版)。
 */
function extractFacebook(url: string): string | null {
  const fbw = url.match(/fb\.watch\/([A-Za-z0-9_-]+)/);
  if (fbw) return `fbw_${fbw[1]}`;
  const vids = url.match(/\/(?:reel|reels|videos)\/(\d+)/);
  if (vids) return `fb_${vids[1]}`;
  const share = url.match(/\/share\/[rvp]\/([A-Za-z0-9_-]+)/);
  if (share) return `fbs_${share[1]}`;
  try {
    const u = new URL(url);
    const story = u.searchParams.get("story_fbid") ?? u.searchParams.get("v");
    if (story) return `fb_${story}`;
  } catch {
    /* 非合法 URL → 跳過 query 形態 */
  }
  return null;
}

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
    case "Facebook": {
      // FB id 已自帶前綴(fbw_/fb_/fbs_)→ 直接回,不再套 `${prefix}_`。
      const fbId = extractFacebook(url);
      if (fbId) return { videoId: fbId, unsupported: false };
      raw = null; // 四形態皆不中 → 退 unknown_
      break;
    }
    // X / 抖音:n8n 版沒有抽 ID 規則 → 視為不支援
    default:
      raw = null;
  }

  if (!raw) {
    return { videoId: `unknown_${now()}`, unsupported: true };
  }
  return { videoId: `${prefix}_${raw}`, unsupported: false };
}
