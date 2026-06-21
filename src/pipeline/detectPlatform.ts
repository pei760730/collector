/**
 * Detect Platform — 依優先序比對 **hostname**(不是子字串)判斷平台。
 * 比對不到 → fallback 到 Unknown(confidence=low)。不再像舊 n8n 誤猜 Instagram
 * (那會把 threads 等未列平台標成假 Instagram;voc 下游雖會自我校正,源頭誠實才對)。
 *
 * 用 hostname 結尾比對,避免 `netflix.com` 命中 `x.com`、`tiktok.com.evil.com`
 * 被當成 tiktok 這種子字串誤判。
 */
import type { Platform, PlatformInfo } from "../types.js";

interface Rule {
  platform: Platform;
  icon: string;
  /** 命中其一即判定(比對 hostname 是否等於或結尾為此網域)。 */
  domains: string[];
}

/** 順序即優先序,先命中先贏。 */
const RULES: Rule[] = [
  { platform: "TikTok", icon: "🎵", domains: ["tiktok.com"] },
  { platform: "YouTube", icon: "📺", domains: ["youtube.com", "youtu.be"] },
  { platform: "Facebook", icon: "📘", domains: ["facebook.com", "fb.com", "fb.watch"] },
  { platform: "Instagram", icon: "📸", domains: ["instagram.com"] },
  { platform: "Threads", icon: "🧵", domains: ["threads.net", "threads.com"] },
  { platform: "X", icon: "🐦", domains: ["x.com", "twitter.com"] },
  { platform: "抖音", icon: "🎶", domains: ["douyin.com"] },
  { platform: "小紅書", icon: "📕", domains: ["xhslink.com", "xiaohongshu.com"] },
];

export const PLATFORM_ICON: Record<Platform, string> = {
  ...Object.fromEntries(RULES.map((r) => [r.platform, r.icon])),
  Unknown: "❓",
} as Record<Platform, string>;

/** hostname 是否等於或為某網域的子網域(`www.youtube.com` ⊂ `youtube.com`)。 */
function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** 從乾淨連結取 hostname(小寫、去 www 無妨);解析失敗回 null。 */
function hostnameOf(cleanUrl: string): string | null {
  try {
    return new URL(cleanUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function detectPlatform(cleanUrl: string): PlatformInfo {
  const host = hostnameOf(cleanUrl);
  if (!host) {
    return { platform: "Unknown", icon: "❓", confidence: "low", method: "error" };
  }
  for (const rule of RULES) {
    if (rule.domains.some((d) => hostMatches(host, d))) {
      return {
        platform: rule.platform,
        icon: rule.icon,
        confidence: "high",
        method: "domain_match",
      };
    }
  }
  // fallback:認不得的網域標 Unknown(不誤猜 Instagram)。confidence=low。
  // 注意:fallback 時 assembleDraft 不會跑抽 id(method!=="domain_match"),故落 unknown_。
  return { platform: "Unknown", icon: "❓", confidence: "low", method: "fallback" };
}
