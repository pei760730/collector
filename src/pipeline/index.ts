/**
 * Pipeline 組合 —— 把純函式串成一個「草稿」:
 * parse → cleanUrl → detectPlatform → extractVideoId。
 * 去重 / 寫入屬於 I/O,留給 collect handler;這裡保持純函式好測試。
 */
import { parseMessage, type ParseInput } from "./parse.js";
import { cleanUrl } from "./cleanUrl.js";
import { detectPlatform } from "./detectPlatform.js";
import { extractVideoId } from "./extractVideoId.js";
import { PLATFORM_CODE, type ParsedMessage, type RefRow } from "../types.js";
import { todayIsoTaipei } from "../utils/date.js";

export { NoUrlError } from "./parse.js";

export interface Draft {
  row: RefRow;
  /** 去重 key(由連結即時推導,參考池不存欄)。 */
  dedupKey: string;
  /** 抓不到 video id(平台不支援 / 解析失敗)→ 回覆提醒「先以 unknown 收錄」。 */
  unsupported: boolean;
  isShortUrl: boolean;
  /** 這次訊息的備註(參考池不存,只給回覆顯示用)。 */
  note: string;
}

/**
 * 連結 → 去重 key(對齊 voc `sync._dedup_key`,跨 repo 行為一致)。
 *
 * 優先用「平台:影片id」當 key —— YouTube `watch?v=AAA` 與 `watch?v=BBB` 不會在砍 query 後
 * 塌成同一個 `.../watch` 被誤判重複;同支影片的 `youtu.be/`、`shorts/`、`watch?v=` 反而收斂
 * 成同一 key,跨形態也擋得住重複。抽不到影片id(平台不支援 / 連結沒帶 id)才退回路徑 key:
 * 砍 query/fragment、去尾斜線、lower。
 *
 * 候選列與既有列都走這支(吃同樣的乾淨連結)→ 兩邊算出的 key 一致才能正確去重。
 */
export function dedupKey(url: string): string {
  const u = (url ?? "").trim();
  const platform = detectPlatform(u);
  if (platform.method === "domain_match") {
    const vid = extractVideoId(platform.platform, u);
    if (!vid.unsupported) return vid.videoId.trim().toLowerCase();
  }
  return u.replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * 從訊息產出一筆「參考池」草稿列(尚未去重、尚未寫入)。
 * @param now 可注入時間(epoch ms),預設 Date.now,利於測試。
 */
export function buildDraft(input: ParseInput, now: () => number = Date.now): Draft {
  return assembleDraft(parseMessage(input), now); // parseMessage 可能丟 NoUrlError
}

/**
 * 從已解析訊息組草稿。collect handler 想在 parse 之後、組裝之前
 * 插入短網址展開時用這支(把 parsed.rawUrl 換成展開後的網址)。
 */
export function assembleDraft(parsed: ParsedMessage, now: () => number = Date.now): Draft {
  const cleaned = cleanUrl(parsed.rawUrl);
  const platform = detectPlatform(cleaned.cleanUrl);
  // 只在「真的比對到網域」時抽 id,判斷 unsupported(給回覆提示)。fallback/error 一律 unsupported。
  const vid =
    platform.method === "domain_match"
      ? extractVideoId(platform.platform, cleaned.cleanUrl, now)
      : { videoId: "", unsupported: true };

  const row: RefRow = {
    平台: PLATFORM_CODE[platform.platform],
    連結: cleaned.cleanUrl,
    挑: "", // 留空 = 還沒挑
    加入日期: todayIsoTaipei(now()),
  };

  return {
    row,
    dedupKey: dedupKey(cleaned.cleanUrl),
    unsupported: vid.unsupported,
    isShortUrl: cleaned.isShortUrl,
    note: parsed.note,
  };
}
