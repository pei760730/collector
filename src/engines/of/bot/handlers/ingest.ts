/**
 * 收集 pipeline handler(核心流程,規格 §3)。
 *
 * runIngest 不依賴 Telegraf —— 吃 {text} 回 {reply, error},方便用 MemoryStorage 寫整合測試。
 * Telegraf wiring 在 router.ts。
 *
 *   parse → clean → extract(含 FB 轉址)→
 *     raw_*(unsupported) → 直接存(不查重)
 *     可解析       → 查重 → 重複:跳過不存 / 新的:pending_review 存
 */
import {
  parseMessage,
  NoUrlError,
  cleanUrl,
  hasShortHost,
  expandShortUrl as coreExpandShortUrl,
} from "@pei760730/collector-core";
import { extractVideoId } from "../../pipeline/extractVideoId.js";
import { todayTaipei } from "../../utils/date.js";
import { STATUS, type StagingRow } from "../../types.js";
import type { Storage } from "../../storage/Storage.js";
import { logger } from "../../utils/logger.js";
import {
  formatErrorMsg,
  savedMsg,
  unsupportedMsg,
  duplicateMsg,
  approvedDuplicateMsg,
  saveErrorMsg,
} from "../../messages/templates.js";

// 同進程序列化 查重→append,避免同一連結極短時間連發時兩條都過查重再雙寫(改進 #3)。
// 跨進程靠單一 bot 實例(polling / drain 都是單實例)。
let lock: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface IngestDeps {
  storage: Storage;
  expandShortUrls: boolean;
  /** 短網址展開器。預設 = core expandShortUrl;測試注入 fake 即可驗 true 分支不打網路。 */
  expandShortUrl?: (url: string) => Promise<string>;
  now?: () => number;
  /**
   * 寫入暫存區失敗(可重試)時呼叫 —— 給 drain 模式用的 side-channel。
   * runIngest 仍照常回 {reply, error}(常駐版/測試契約不變);drain 靠這個 callback
   * 得知「這筆沒持久化」,好停在當前 offset、不 ack、下次 cron 重領,避免靜默丟資料。
   */
  onPersistError?: () => void;
}

export interface IngestResult {
  reply: string;
  /** 有值 → 也要通知 error chat。 */
  error?: string;
}

export async function runIngest(
  input: { text: string },
  deps: IngestDeps,
): Promise<IngestResult> {
  const now = deps.now ?? Date.now;

  // Parse —— 抽第一個網址;沒有 → 格式錯誤
  let rawUrl: string;
  let truncated: boolean;
  try {
    const parsed = parseMessage({ text: input.text });
    rawUrl = parsed.rawUrl;
    // core 在解析邊界截斷超長連結/備註(fanout-safety)→ 收錄回覆要明講,
    // 別讓分享者以為存進暫存區的是完整值。
    truncated = parsed.truncated;
  } catch (err) {
    if (err instanceof NoUrlError) return { reply: formatErrorMsg() };
    throw err;
  }

  // 短網址展開(opt-in,且只對已知短網址服務發 HEAD,別追每條連結)。在 clean 前展開,
  // 平台判斷吃真實網址。
  if (deps.expandShortUrls && hasShortHost(rawUrl)) {
    const expand = deps.expandShortUrl ?? coreExpandShortUrl;
    const expanded = await expand(rawUrl);
    if (expanded !== rawUrl) rawUrl = expanded;
  }

  // Clean → Extract(FB 轉址解開在 core cleanUrl 層,cleaned.cleanUrl 即最終 CLEAN_URL)
  const cleaned = cleanUrl(rawUrl);
  const ex = extractVideoId(cleaned.cleanUrl, now);

  const row: StagingRow = {
    PLATFORM: ex.platform,
    DATE: todayTaipei(now()),
    CLEAN_URL: cleaned.cleanUrl,
    VIDEO_ID: ex.videoId,
    STATUS: ex.unsupported ? STATUS.UNSUPPORTED : STATUS.PENDING_REVIEW,
  };

  return serialize(async () => {
    // unsupported(raw_*)→ 直接存,不查重(規格 §4.4)
    if (!ex.unsupported) {
      // 查 in-memory 去重索引 / 總表集合(單輪 drain 各只讀一次全表後快取,取代逐訊息全表掃描)。
      const hit = (await deps.storage.videoIdIndex()).get(ex.videoId.trim());
      if (hit) return { reply: duplicateMsg(hit.row) };

      // normKey 已是 core cleanUrl 輸出(row.CLEAN_URL 來自上面的 cleanUrl(rawUrl));
      // approvedUrlSet 內值同樣過 core cleanUrl,兩側對齊。
      if ((await deps.storage.approvedUrlSet()).has(row.CLEAN_URL)) {
        return { reply: approvedDuplicateMsg(row.CLEAN_URL) };
      }
    }

    try {
      await deps.storage.append(row);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("寫入暫存區失敗", err);
      // 通知 drain:這筆沒寫成功(可重試)。常駐版沒給 callback → no-op,行為不變。
      deps.onPersistError?.();
      return {
        reply: saveErrorMsg(detail),
        error: `ingest 寫入失敗:${detail}｜url=${row.CLEAN_URL}`,
      };
    }

    logger.info(`收錄 ${row.PLATFORM} ${row.VIDEO_ID} (${row.STATUS})`);
    // unsupported(raw_*)也帶截斷提醒:截斷過的 URL 進 raw_ 給人工看時,
    // 分享者當下不講,審核的人只會對著半截連結困惑。
    return {
      reply: ex.unsupported
        ? unsupportedMsg(row, { truncated })
        : savedMsg(row, { truncated }),
    };
  });
}
