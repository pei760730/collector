/**
 * shell(voc/tbvoc) 與 of 共用的 drain 迴圈。
 *
 * 只收 target 無關的 getUpdates→handleUpdate→ack、persist abort 與 exit code 語意；
 * 寫入目的地名稱由呼叫端注入，保留既有 target-specific log 文案。
 */
import type { Update } from "@telegraf/types";
import { logger } from "@pei760730/collector-core";

/** drain 迴圈需要的最小 bot 介面(Telegraf 子集；測試注入假件即可，不用真連線)。 */
export interface DrainableBot {
  telegram: {
    getUpdates(
      timeout: number,
      limit: number,
      offset: number,
      allowedUpdates: undefined,
    ): Promise<Update[]>;
  };
  handleUpdate(update: Update): Promise<unknown>;
}

/** 寫入失敗 side-channel 旗標(createBot hooks.onPersistError 翻 true；每筆處理前歸零)。 */
export interface PersistFlag {
  failed: boolean;
}

export interface DrainResult {
  /** 成功處理並 ack 的更新數。 */
  processed: number;
  /** true = 某筆持久化失敗 → 停在該 offset 提前結束(該筆與之後的下次 cron 重領)。 */
  aborted: boolean;
}

export async function drainUpdates(
  bot: DrainableBot,
  persist: PersistFlag,
  persistDestination: string,
): Promise<DrainResult> {
  let offset = 0;
  let processed = 0;
  let aborted = false;
  outer: for (;;) {
    // timeout=0 → 不長等:有就回、沒有立刻回空(一次性語意,不要 block 住 Actions)。
    const updates = await bot.telegram.getUpdates(0, 100, offset, undefined);
    if (updates.length === 0) break;
    for (const u of updates) {
      persist.failed = false;
      try {
        await bot.handleUpdate(u);
      } catch (err) {
        // 解析/路由層的非預期例外(非寫入失敗):這類重領也沒用,記錄後跳過。
        logger.error(`處理 update ${u.update_id} 例外(跳過,下次不重領)`, err);
      }
      if (persist.failed) {
        // 寫入失敗(可重試):不前進 offset、結束整個 drain,之後不再呼叫 getUpdates ——
        // 本批的新 offset(含同批已成功筆推進的那段)從未回報給 Telegram,所以下次 cron
        // 從 offset=0 起把「失敗批含同批已成功筆 + 之後全部」整段重領(更早的完整批次
        // 已被本輪後續 getUpdates 帶新 offset ack 掉)。重領的已成功筆由各 target storage
        // 去重吸收；失敗筆重新寫入。這樣才真正 at-least-once,不會把沒寫成功的訊息
        // 默默 ack 掉(CLAUDE.md 紅線)。
        logger.error(
          `update ${u.update_id} 寫入${persistDestination}失敗 → 停在此 offset,結束本輪讓下次 cron 重領`,
        );
        aborted = true;
        break outer;
      }
      offset = u.update_id + 1; // 帶到下一輪 getUpdates 即 ack 本批(累積語意)
      processed += 1;
    }
  }
  // 正常結束時最後一次「空批」getUpdates(offset) 已 ack 最後一批,不需額外補 ack。
  // 中止結束時刻意不 ack 未處理段(含失敗那筆),留給下次 cron 重領。
  return { processed, aborted };
}

/** aborted(寫入失敗中止)→ 2，正常 → 0，讓 collect.yml 不會假綠。 */
export function exitCodeFor(result: DrainResult): number {
  return result.aborted ? 2 : 0;
}
