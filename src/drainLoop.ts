/**
 * drain 迴圈本體 —— 從 drain.ts 抽出成可注入測試的純迴圈(getUpdates→handleUpdate→ack)。
 * drain.ts 是進程進入點(import 即執行 main),測試無法直接 import;
 * abort/ack 語意與 exit code 對映在這裡,tests/drainLoop.test.ts 用假 bot 釘住。
 */
import type { Update } from "@telegraf/types";
import { logger } from "./utils/logger.js";

/** drain 迴圈需要的最小 bot 介面(Telegraf 子集;測試注入假件即可,不用真連線)。 */
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

/** 寫入失敗 side-channel 旗標(createBot hooks.onPersistError 翻 true;每筆處理前歸零)。 */
export interface PersistFlag {
  failed: boolean;
}

export interface DrainResult {
  /** 成功處理並 ack 的更新數。 */
  processed: number;
  /** true = 某筆寫入參考池失敗 → 停在該 offset 提前結束(該筆與之後的下次 cron 重領)。 */
  aborted: boolean;
}

export async function drainUpdates(bot: DrainableBot, persist: PersistFlag): Promise<DrainResult> {
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
        logger.error(`處理 update ${u.update_id} 例外(跳過)`, err);
      }
      if (persist.failed) {
        // 寫入失敗(可重試):不前進 offset、結束整個 drain。前面成功的那段下次 cron 的
        // 第一次 getUpdates(offset) 會 ack;這筆與之後的會被重領,靠 storage 連結 key 去重。
        // 這樣才真正 at-least-once,不會把沒寫成功的訊息默默 ack 掉(CLAUDE.md 紅線)。
        logger.error(`update ${u.update_id} 寫入參考池失敗 → 停在此 offset,結束本輪讓下次 cron 重領`);
        aborted = true;
        break outer;
      }
      offset = u.update_id + 1; // 帶到下一輪 getUpdates 即 ack 本批(累積語意)
      processed += 1;
    }
  }
  // 正常結束時最後一次「空批」getUpdates(offset) 已 ack 最後一批,不需額外補 ack。
  // 中止結束時刻意不 ack 未處理段,留給下次 cron 重領。
  return { processed, aborted };
}

/**
 * exit code 對映:aborted(寫入失敗中止)→ 2,正常 → 0。
 * 舊版 aborted 也 exit 0 → collect.yml 綠燈、kai-notify(if: failure())永不觸發;
 * Sheets 壞掉 + ERROR_CHAT_ID 沒設時 = 靜默丟資料。非零退出讓 Actions 紅燈成為底線告警。
 */
export function exitCodeFor(result: DrainResult): number {
  return result.aborted ? 2 : 0;
}
