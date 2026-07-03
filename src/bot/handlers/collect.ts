/**
 * 收集 pipeline handler。
 * runCollect 不依賴 Telegraf —— 吃 {text} 回 {reply, error},
 * 方便用 MemoryStorage 寫整合測試。Telegraf wiring 在 router.ts。
 */
import { parseMessage, NoUrlError } from "@pei760730/collector-core";
import { assembleDraft, dedupKey } from "../../pipeline/index.js";
import { hasShortHost } from "@pei760730/collector-core";
import type { Storage } from "../../storage/Storage.js";
import { expandShortUrl } from "../../utils/expandUrl.js";
import { logger } from "../../utils/logger.js";

// 同進程序列化 dedup→append,避免同一連結極短時間連發時兩條都過去重再雙寫。
// (跨進程要靠單一 bot 實例;我們就是單實例 polling。)
let lock: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
import {
  formatErrorMsg,
  successMsg,
  duplicateMsg,
  saveErrorMsg,
} from "../../messages/templates.js";

export interface CollectDeps {
  storage: Storage;
  expandShortUrls: boolean;
  now?: () => number;
  /**
   * 寫入參考池失敗(可重試)時呼叫 —— 給 drain 模式用的 side-channel。
   * runCollect 仍照常回 {reply, error}(常駐版/測試契約不變);drain 靠這個 callback
   * 得知「這筆沒持久化」,好停在當前 offset、不 ack、下次 cron 重領,避免靜默丟資料。
   */
  onPersistError?: () => void;
}

export interface CollectResult {
  reply: string;
  /** 有值 → 也要通知 error chat。 */
  error?: string;
}

export async function runCollect(
  input: { text: string },
  deps: CollectDeps,
): Promise<CollectResult> {
  const now = deps.now ?? Date.now;

  let parsed;
  try {
    parsed = parseMessage({ text: input.text });
  } catch (err) {
    if (err instanceof NoUrlError) {
      return { reply: formatErrorMsg() };
    }
    throw err;
  }

  // 短網址展開(opt-in,且只對「已知短網址服務」展開,別對每條連結都發 HEAD
  // / 把正常連結跟著 redirect 跑到登入頁)。展開在 clean 之前,平台判斷吃真實網址。
  if (deps.expandShortUrls && hasShortHost(parsed.rawUrl)) {
    const expanded = await expandShortUrl(parsed.rawUrl);
    if (expanded !== parsed.rawUrl) {
      parsed = { ...parsed, rawUrl: expanded };
    }
  }

  const draft = assembleDraft(parsed, now);

  // 去重 + 寫入序列化,避免並發雙寫。去重靠連結即時推導的 key(全表比對、無時間窗,
  // 對齊 voc:參考池是永久池)。同連結(含同支影片不同形態)只收一次。
  return serialize(async () => {
    const existing = await deps.storage.readRows();
    const hit = existing.find((h) => dedupKey(h.row.連結) === draft.dedupKey);
    if (hit) {
      return { reply: duplicateMsg(hit.row) };
    }

    try {
      await deps.storage.append(draft.row);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("寫入參考池失敗", err);
      // 通知 drain:這筆沒寫成功(可重試)。常駐版沒給 callback → no-op,行為不變。
      deps.onPersistError?.();
      return {
        reply: saveErrorMsg(detail),
        error: `collect 寫入失敗:${detail}｜url=${draft.row.連結}`,
      };
    }

    logger.info(`收錄 ${draft.row.平台} ${draft.row.連結}`);
    return {
      reply: successMsg(draft.row, {
        unsupported: draft.unsupported,
        isShortUrl: draft.isShortUrl,
        note: draft.note,
      }),
    };
  });
}
