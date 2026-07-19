/**
 * shell(voc/tbvoc) 與 of 共用的 Google Sheets append 冪等護欄。
 *
 * 只收「重試前 fresh 查 key」的控制流；key 算法、全表讀法、append payload，及寫入成功後
 * 各 target 的快取更新都由呼叫端保留。快取刻意放在單次函式呼叫的 closure，避免不同
 * storage instance／不同 append 互相串味。
 */
import { withRetry } from "@pei760730/collector-core";

/** Set、Map 或其他只需支援 has(key) 的 fresh key lookup。 */
export interface FreshKeyLookup {
  has(key: string): boolean;
}

export interface IdempotentAppendOptions<Row, Result> {
  row: Row;
  /** shell 注入 dedupKey(連結)；of 注入 trim 後的 VIDEO_ID。空字串代表無穩定 key。 */
  keyOf: (row: Row) => string;
  /** 必須 fresh 讀表，不能使用 instance-level 去重快取。 */
  fetchFreshKeys: () => Promise<FreshKeyLookup>;
  append: () => Promise<Result>;
}

export interface IdempotentAppendResult<Result> {
  key: string;
  /** alreadyDone 命中時 core withRetry 實際回 undefined。 */
  result: Result | undefined;
}

/**
 * 執行非冪等 append，並在暫態錯誤重試前確認前一次是否其實已落表。
 *
 * fresh key 查詢成功後，本次 append 的整個重試窗只讀一次；查詢失敗則清掉 pending，
 * 讓下一次重試可再查。空 key 不啟用護欄，完全退回原本的 withRetry 行為。
 */
export async function appendWithIdempotencyGuard<Row, Result>(
  options: IdempotentAppendOptions<Row, Result>,
): Promise<IdempotentAppendResult<Result>> {
  const key = options.keyOf(options.row);
  let keySetCache: Promise<FreshKeyLookup> | undefined;

  const existingKeys = (): Promise<FreshKeyLookup> => {
    const pending = (keySetCache ??= options.fetchFreshKeys().catch((err) => {
      if (keySetCache === pending) keySetCache = undefined;
      throw err;
    }));
    return pending;
  };

  // collector-core 的宣告是 Promise<Result>，但 alreadyDone 命中時 runtime 會回 undefined。
  const result = (await withRetry("append", options.append, {
    alreadyDone: key ? async () => (await existingKeys()).has(key) : undefined,
  })) as Result | undefined;

  return { key, result };
}
