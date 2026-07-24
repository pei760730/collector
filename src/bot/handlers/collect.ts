/**
 * 收集 pipeline handler。
 * runCollect 不依賴 Telegraf —— 吃 {text} 回 {reply, error},
 * 方便用 MemoryStorage 寫整合測試。Telegraf wiring 在 router.ts。
 */
import { parseMessage, NoUrlError } from "@pei760730/collector-core";
import { assembleDraft } from "../../pipeline/index.js";
import { hasShortHost } from "@pei760730/collector-core";
import type { Storage } from "../../storage/Storage.js";
import { VOC_TARGET, type TargetSpec } from "../../targets.js";
import { expandShortUrl as coreExpandShortUrl } from "../../utils/expandUrl.js";
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
import { formatErrorMsg, duplicateMsg, saveErrorMsg } from "../../messages/templates.js";

export interface CollectDeps {
  storage: Storage;
  expandShortUrls: boolean;
  /** 寫入目標(欄位/文案/夯度)。預設 voc:既有呼叫端與測試零改動;生產由 router 傳入。 */
  target?: TargetSpec;
  /** 短網址展開器。預設 = core expandShortUrl;測試注入 fake 即可驗 true 分支不打網路。 */
  expandShortUrl?: (url: string) => Promise<string>;
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
  /**
   * (tbvoc)收錄成功或已收過時帶這支的 dedupKey,讓 router 掛「夯度」inline 按鈕;
   * 點按鈕的 callback 用它定位該列回填夯度。voc target 恆不帶(無夯度功能)。
   */
  hotKey?: string;
}

export async function runCollect(
  input: { text: string },
  deps: CollectDeps,
): Promise<CollectResult> {
  const now = deps.now ?? Date.now;
  const target = deps.target ?? VOC_TARGET;

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
    const expand = deps.expandShortUrl ?? coreExpandShortUrl;
    const expanded = await expand(parsed.rawUrl);
    if (expanded !== parsed.rawUrl) {
      parsed = { ...parsed, rawUrl: expanded };
    }
  }

  const draft = assembleDraft(parsed, now, target);

  // 去重 + 寫入序列化,避免並發雙寫。去重靠連結即時推導的 key(全表比對、無時間窗,
  // 對齊 voc:參考池是永久池)。同連結(含同支影片不同形態)只收一次。
  return serialize(async () => {
    // 去重查 in-memory 索引(單輪只讀一次全表建好、快取於 storage 實例),
    // 不再每筆 readRows() 全表讀 —— 一輪 N 筆時 values.get 從 O(N) 降為 O(1)。
    const index = await deps.storage.dedupIndex();
    const hit = index.get(draft.dedupKey);
    if (hit) {
      // (tbvoc)已收過也讓他能(重)標夯度:帶同一支的 key。voc 不帶。
      return target.hotValues
        ? { reply: duplicateMsg(hit), hotKey: draft.dedupKey }
        : { reply: duplicateMsg(hit) };
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

    // public repo 的 Actions log 誰都看得到:只印平台、不印連結(dedupKey 對 unsupported
    // 平台 fallback=完整 URL,一樣不印)。明細在表裡;of 引擎收錄行同紀律(只印 VIDEO_ID)。
    logger.info(`收錄 ${draft.row.平台}`);
    const reply = target.successMsg(draft.row, {
      unsupported: draft.unsupported,
      isShortUrl: draft.isShortUrl,
      note: draft.note,
      truncated: draft.truncated,
    });
    return target.hotValues ? { reply, hotKey: draft.dedupKey } : { reply };
  });
}
