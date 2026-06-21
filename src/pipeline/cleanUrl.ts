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
  // TikTok 短連結:無 /video/<id>,不展開的話跟長連結算出不同去重 key → 漏去重。
  // EXPAND_SHORT_URLS=true 時展開成正規 /video/ 連結;展開失敗會優雅退回原值(不會更糟)。
  "vm.tiktok.com",
  "vt.tiktok.com",
]);

/**
 * Facebook 轉址解開:`l.facebook.com/l.php?u=<編碼真網址>` → 還原內層真網址。
 * 非 FB 轉址回 null。`searchParams.get` 已 percent-decode,直接用(不再 decodeURIComponent
 * 雙重解碼)。概念借自 OF-DOG —— 從 FB app 分享 IG/TikTok/YT 等「本來就支援」的連結
 * 常被包成這種轉址,不解會落 fallback + unknown_ 垃圾列。
 */
function unwrapFacebookRedirect(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host !== "l.facebook.com" && host !== "lm.facebook.com") return null;
  return url.searchParams.get("u");
}

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

  // Facebook 轉址解開:還原成內層真網址後,重走完整清理(去追蹤參數/行動版/偵測短網址)。
  // 內層 host 不會再是 l.facebook → 不會無限遞迴;isShortUrl 改以內層判定(內層可能是 vm.tiktok)。
  const fbInner = unwrapFacebookRedirect(url);
  if (fbInner != null) {
    return cleanUrl(fbInner);
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
