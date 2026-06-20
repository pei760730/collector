/**
 * Detect Platform — 依優先序比對 **hostname**(不是子字串)判斷平台。
 * 比對不到 → fallback 到 Instagram(confidence=medium),沿用 n8n 行為。
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

export const PLATFORM_ICON: Record<Platform, string> = Object.fromEntries(
  RULES.map((r) => [r.platform, r.icon]),
) as Record<Platform, string>;

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
    return { platform: "Instagram", icon: "📸", confidence: "low", method: "error" };
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
  // fallback:沿用 n8n —— 不認得就猜 Instagram,但標 medium 讓人看得出是猜的。
  // 注意:fallback 時 assembleDraft 不會跑抽 id(避免在非 IG 連結上造假 ig_ id)。
  return { platform: "Instagram", icon: "📸", confidence: "medium", method: "fallback" };
}
