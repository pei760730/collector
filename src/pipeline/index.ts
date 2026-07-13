/**
 * Pipeline 組合 —— assembleDraft 組「參考池」草稿(RefRow)。
 * 純 pipeline(parse/cleanUrl/detectPlatform/extractVideoId/groupKey)來自 @pei760730/collector-core。
 */
import {
  cleanUrl,
  detectPlatform,
  extractVideoId,
  groupKey,
  PLATFORM_CODE,
  todayIsoTaipei,
} from "@pei760730/collector-core";
import type { ParsedMessage } from "@pei760730/collector-core";
import type { RefRow } from "../types.js";

export { NoUrlError } from "@pei760730/collector-core";
/** 去重 key = core groupKey(對齊 voc dedup_key,跨語言分群等價;名稱沿用 dedupKey 不動 importer)。 */
export { groupKey as dedupKey } from "@pei760730/collector-core";

export interface Draft {
  row: RefRow;
  /** 去重 key(由連結即時推導,參考池不存欄)。 */
  dedupKey: string;
  /** 抓不到 video id(平台不支援 / 解析失敗)→ 回覆提醒「先以 unknown 收錄」。 */
  unsupported: boolean;
  isShortUrl: boolean;
  /** 這次訊息的備註(參考池不存,只給回覆顯示用)。 */
  note: string;
  /** 連結/備註超出 core 上限被截斷(fanout-safety)→ 回覆提醒分享者存的不是完整值。 */
  truncated: boolean;
}

/**
 * 從已解析訊息組草稿。collect handler 想在 parse 之後、組裝之前插入短網址展開時用這支
 * (把 parsed.rawUrl 換成展開後的網址)。
 */
export function assembleDraft(parsed: ParsedMessage, now: () => number = Date.now): Draft {
  const cleaned = cleanUrl(parsed.rawUrl);
  const platform = detectPlatform(cleaned.cleanUrl);
  // 只在「真的比對到網域」時抽 id,判斷 unsupported(給回覆提示)。fallback/error 一律 unsupported。
  const vid =
    platform.method === "domain_match"
      ? extractVideoId(platform.platform, cleaned.cleanUrl)
      : { videoId: "", unsupported: true };

  const row: RefRow = {
    平台: PLATFORM_CODE[platform.platform],
    連結: cleaned.cleanUrl,
    挑: "", // 留空 = 還沒挑
    加入日期: todayIsoTaipei(now()),
  };

  return {
    row,
    dedupKey: groupKey(cleaned.cleanUrl),
    unsupported: vid.unsupported,
    isShortUrl: cleaned.isShortUrl,
    note: parsed.note,
    truncated: parsed.truncated,
  };
}
