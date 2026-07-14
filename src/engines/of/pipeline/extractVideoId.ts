/**
 * Extract Video ID —— feed 的 per-engine adapter(2026-07-06 起吃 collector-core,終審 #8)。
 *
 * 分工:平台判定 + 各平台抽取規則 = core SSOT(anti-injection/形態集合/canonical 對齊都在那);
 * 本檔只做 feed 自家表的「化妝」層:
 *   1. 前綴轉換:core `tiktok_…` → 本表歷史前綴 `tt_…`(暫存區既有列全是舊前綴,
 *      去重靠 VIDEO_ID 逐字比對 —— 換前綴 = 去重歷史斷裂,故 adapter 保舊前綴、零 migration)。
 *   2. XHS 小寫收斂:core 抽取保留原大小寫、收斂在 groupKey 層;feed 無 groupKey 層,
 *      得在這裡收斂,否則同筆記大小寫變體撞不到同 VIDEO_ID。
 *   3. raw_ 語意不變:抓不到 id → `raw_<timestamp>`,unsupported、不去重、每貼必留一列(規格 §4.4)。
 *
 * 注意:FB 轉址解開已上移到 core cleanUrl(l.facebook.com → 內層真網址 + 重清理),
 * 本檔輸入即最終 CLEAN_URL,不再回寫。改抽取規則去 collector-core 改(先過 core tests +
 * dedupConformance),別動這裡。
 */
import { detectPlatform, extractVideoId as coreExtractVideoId } from "@pei760730/collector-core";
import type { Platform as CorePlatform } from "@pei760730/collector-core";
import type { Platform } from "../types.js";

export interface ExtractResult {
  /** 寫進 PLATFORM 欄的顯示名(core `Unknown` → 本表慣用 `Other`)。 */
  platform: Platform;
  /** 帶本表前綴的唯一 ID,如 tt_7234…;抓不到為 raw_<ts>。 */
  videoId: string;
  /** 抓不到 ID(VIDEO_ID 為 raw_*)。 */
  unsupported: boolean;
}

/** core 前綴 ↔ 本表前綴對照(core 前綴 = PLATFORM_CODE 慣例;FB 特例見 extract 內註解)。 */
const FEED_PREFIX: Partial<Record<CorePlatform, { core: string; feed: string }>> = {
  TikTok: { core: "tiktok_", feed: "tt_" },
  Instagram: { core: "ig_", feed: "ig_" },
  YouTube: { core: "yt_", feed: "yt_" },
  Facebook: { core: "", feed: "" }, // FB 特例:core 的 fbw_/fb_/fbs_ 三前綴與本表歷史完全同款,直通
  X: { core: "x_", feed: "x_" },
  小紅書: { core: "xhs_", feed: "xhs_" },
  Threads: { core: "threads_", feed: "th_" },
  抖音: { core: "douyin_", feed: "dy_" }, // 2026-07-06 新支援(core 順送,Kai 拍板接)
};

/** core Platform → 本表 PLATFORM 欄顯示名。 */
function toFeedPlatform(p: CorePlatform): Platform {
  return p === "Unknown" ? "Other" : p;
}

export function extractVideoId(
  inputCleanUrl: string,
  now: () => number = Date.now,
): ExtractResult {
  const det = detectPlatform(inputCleanUrl ?? "");
  const platform = toFeedPlatform(det.platform);

  // 只在真的比對到網域時抽 id;fallback/解析失敗一律 unsupported(不誤猜)。
  if (det.method !== "domain_match") {
    return { platform: "Other", videoId: `raw_${now()}`, unsupported: true };
  }

  const info = coreExtractVideoId(det.platform, inputCleanUrl);
  const map = FEED_PREFIX[det.platform];
  if (info.unsupported || !info.videoId || !map) {
    return { platform, videoId: `raw_${now()}`, unsupported: true };
  }

  if (det.platform === "Facebook") {
    // FB 直通:core 的 fbw_(watch)/fb_(reel/videos/story_fbid)/fbs_(share)三前綴
    // 與本表歷史完全同款(dedup_vectors 釘住「四形態同號不撞」),不轉換。
    return { platform, videoId: info.videoId, unsupported: false };
  }

  if (!info.videoId.startsWith(map.core)) {
    // core 前綴慣例變了(升版沒跟到)→ 寧可落 raw_,也不寫錯格式污染去重欄。
    return { platform, videoId: `raw_${now()}`, unsupported: true };
  }
  let id = info.videoId.slice(map.core.length);

  // XHS hex 大小寫無語義:feed 無 groupKey 層,在此收斂小寫(對齊 core groupKey/voc/tbvoc)。
  if (det.platform === "小紅書") id = id.toLowerCase();

  return { platform, videoId: `${map.feed}${id}`, unsupported: false };
}
