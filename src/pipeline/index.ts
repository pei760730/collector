/**
 * Pipeline 組合 —— 把純函式串成一個「草稿」:
 * parse → cleanUrl → detectPlatform → extractVideoId。
 * 去重 / 寫入屬於 I/O,留給 collect handler;這裡保持純函式好測試。
 */
import { parseMessage, type ParseInput } from "./parse.js";
import { cleanUrl } from "./cleanUrl.js";
import { detectPlatform } from "./detectPlatform.js";
import { extractVideoId } from "./extractVideoId.js";
import type { ParsedMessage, StagingRow } from "../types.js";
import { STATUS } from "../types.js";
import { todayTaipei } from "../utils/date.js";

export { NoUrlError } from "./parse.js";

export interface Draft {
  row: StagingRow;
  /** 去重 key。 */
  videoId: string;
  unsupported: boolean;
  isShortUrl: boolean;
}

/**
 * 從訊息產出一筆「暫存區」草稿列(尚未去重、尚未寫入)。
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
  // 只在「真的比對到網域」時抽 id。fallback(猜 Instagram)/error 不抽,
  // 否則 random.com/p/xxx 會被造出假的 ig_xxx 並當成可去重的正常影片。
  const vid =
    platform.method === "domain_match"
      ? extractVideoId(platform.platform, cleaned.cleanUrl, now)
      : { videoId: `unknown_${now()}`, unsupported: true };

  const date = todayTaipei(now());
  // 改進#1:VIDEO_ID 不帶多餘空白(直接用乾淨字串)
  const videoId = vid.videoId.trim();

  const row: StagingRow = {
    PLATFORM: platform.platform,
    VIDEO_REF: parsed.rawUrl,
    DATE: date,
    NOTE: parsed.note,
    CLEAN_URL: cleaned.cleanUrl,
    VIDEO_ID: videoId,
    SENDER: parsed.sender,
    STATUS: STATUS.ACTIVE,
  };

  return { row, videoId, unsupported: vid.unsupported, isShortUrl: cleaned.isShortUrl };
}
