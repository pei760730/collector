/**
 * shell(voc/tbvoc) 與 of 共用的 Google Sheets append 冪等護欄。
 *
 * 只收「重試前 fresh 查 key」的控制流；key 算法、全表讀法、append payload，及寫入成功後
 * 各 target 的快取更新都由呼叫端保留。
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

/** 護欄查詢失敗時丟出的錯誤訊息(刻意不含 ECONNRESET/network 等字樣,core isTransient 才會判非暫態)。 */
export const GUARD_FAILURE_MESSAGE = "冪等護欄查詢失敗,為避免雙寫不重打 append";

/**
 * 執行非冪等 append，並在暫態錯誤重試前確認前一次是否其實已落表。
 *
 * 每次暫態 append 失敗後、重打前各查一次；新的 append 可能已提交，不能重用前次空集合。
 * 首次成功不查表。空 key 不啟用護欄，完全退回原本的 withRetry 行為。
 *
 * 護欄查詢本身失敗 → 不再重打 append(2026-10-14 審計 F4)。core withRetry 會吞掉 alreadyDone
 * 的例外並照常重打,但「前一次可能已落表、只是讀不到」時重打 = 雙列:
 *   append#1 已落表但回應遺失(ECONNRESET)→ 全表讀 4 次都失敗被吞 → append#2 再落表。
 * 這裡記下查詢失敗,下一次 fn 直接丟非暫態錯誤,withRetry 立即放棄 → 上層 runCollect/runIngest
 * 既有 catch 翻 onPersistError → drain 中止不 ack → 下輪 cron 以 fresh 全表讀去重。
 * at-least-once 不變,只是把「可能雙寫」換成「延後一輪」。
 */
export async function appendWithIdempotencyGuard<Row, Result>(
  options: IdempotentAppendOptions<Row, Result>,
): Promise<IdempotentAppendResult<Result>> {
  const key = options.keyOf(options.row);
  let guardFailure: Error | undefined;

  const append = async (): Promise<Result> => {
    if (guardFailure) throw guardFailure;
    return options.append();
  };
  const alreadyDone = key
    ? async () => {
        try {
          return (await options.fetchFreshKeys()).has(key);
        } catch (error) {
          guardFailure = new Error(GUARD_FAILURE_MESSAGE, { cause: error });
          throw error;
        }
      }
    : undefined;

  // collector-core 的宣告是 Promise<Result>，但 alreadyDone 命中時 runtime 會回 undefined。
  const result = (await withRetry("append", append, { alreadyDone })) as Result | undefined;

  return { key, result };
}
