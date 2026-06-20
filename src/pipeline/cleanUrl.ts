/**
 * Clean URL — 移除追蹤參數、格式清理、行動版轉桌面版、短網址偵測。
 * 純函式(不發網路請求);短網址展開另外用 expandShortUrl(opt-in)。
 */
import type { CleanedUrl } from "../types.js";

/** 要移除的追蹤參數。 */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  // Meta / Instagram / Threads 分享追蹤碼
  "igsh",
  "igshid",
  "xmt",
  "slof",
]);

/** 行動版 → 桌面版 host 對照。 */
const MOBILE_TO_DESKTOP: Record<string, string> = {
  "m.tiktok.com": "www.tiktok.com",
  "m.facebook.com": "www.facebook.com",
  "m.youtube.com": "www.youtube.com",
  "mobile.twitter.com": "twitter.com",
};

/** 已知短網址服務 host。 */
const SHORT_URL_HOSTS = new Set([
  "bit.ly",
  "tinyurl.com",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "t.co",
  "short.link",
]);

/** 是否為已知短網址服務(供 collect 決定要不要展開)。 */
export function hasShortHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return SHORT_URL_HOSTS.has(host);
}

/**
 * 清理網址。傳回乾淨網址 + 是否為短網址。
 * 解析失敗(非合法 URL)時退回字串層級清理,盡量不丟資料。
 */
export function cleanUrl(input: string): CleanedUrl {
  let raw = (input ?? "").trim();
  // 確保有 https:// 前綴
  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw}`;
  }

  const isShortUrl = hasShortHost(raw);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // 不是合法 URL → 走純字串清理
    return { cleanUrl: stringCleanup(raw), isShortUrl };
  }

  // 行動版轉桌面版
  const desktopHost = MOBILE_TO_DESKTOP[url.hostname.toLowerCase()];
  if (desktopHost) {
    url.hostname = desktopHost;
  }

  // 移除追蹤參數
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }

  let out = url.toString();
  out = stringCleanup(out);
  return { cleanUrl: out, isShortUrl };
}

/**
 * 字串層級清理:去尾斜線、去空 `?`、合併多個 `&`、修正 `?&` → `?`。
 * URL 物件正規化後通常已乾淨,這層是保險(含非標準 URL)。
 */
function stringCleanup(s: string): string {
  let out = s;
  out = out.replace(/\?&/g, "?"); // ?& → ?
  out = out.replace(/&{2,}/g, "&"); // 多個 & 合併
  out = out.replace(/[?&]+$/g, ""); // 去尾端孤立的 ? 或 &
  out = out.replace(/\/(\?)/g, "$1"); // path 與 query 間多餘斜線 /? → ?
  // 去尾斜線(不動協定後的 //;真實情況不會只剩 https://)
  out = out.replace(/\/+$/, "");
  return out;
}
