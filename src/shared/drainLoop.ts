/**
 * shell(voc/tbvoc) 與 of 共用的 drain 迴圈。
 *
 * 只收 target 無關的 getUpdates→handleUpdate→ack、persist abort 與 exit code 語意；
 * 寫入目的地名稱由呼叫端注入，保留既有 target-specific log 文案。
 */
import type { Update } from "@telegraf/types";
import { logger } from "@pei760730/collector-core";
import { callTelegramWithRetry } from "./telegramRetry.js";
import { errSummary } from "./errorSummary.js";

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

/**
 * 一筆更新處理完的去向(handler 經 hooks.onOutcome 回報,不靠字串猜)。
 * saved = 已寫進表;duplicate = 已收過而略過;unwritten = 出了非暫態錯誤、沒寫進表,
 * 但照舊 ack(重領也沒用,避免毒訊息卡住佇列)。其餘更新(沒連結、/stats…)不回報 = 「其他」。
 */
export type UpdateOutcome = "saved" | "duplicate" | "unwritten";

/** 寫入失敗 side-channel 旗標(createBot hooks.onPersistError 翻 true；每筆處理前歸零)。 */
export interface PersistFlag {
  failed: boolean;
  /** 本筆去向(hooks.onOutcome 寫入；每筆處理前歸零;沒回報 = 其他)。 */
  outcome?: UpdateOutcome;
}

/** 給 createBot 的 drain 鉤子:翻 persist 旗標 / 記錄本筆去向(shell 與 of 共用,免各寫一份)。 */
export function drainHooks(persist: PersistFlag): {
  onPersistError: () => void;
  onOutcome: (outcome: UpdateOutcome) => void;
} {
  return {
    onPersistError: () => {
      persist.failed = true;
    },
    onOutcome: (outcome) => {
      // 先到先贏:已確定 saved/duplicate 之後的雜訊例外(例如回覆階段)不能把它改判成未寫入。
      persist.outcome ??= outcome;
    },
  };
}

/**
 * drain 回條帳本:由呼叫端持有、迴圈邊跑邊寫 —— 即使迴圈中途 reject(例如確認用的
 * getUpdates 失敗),呼叫端仍讀得到「到哪了」。
 */
export interface DrainTally {
  /** 已處理(前進 offset)的更新數。 */
  processed: number;
  saved: number;
  duplicate: number;
  /** 出錯沒寫進表的更新數(不論之後有沒有被確認)。 */
  unwritten: number;
  /** processed 之中已被 Telegram 確認(後續 getUpdates 帶新 offset 成功)的筆數。 */
  acked: number;
  /** unwritten 之中已被確認收走者 = 這一輪沒對它寫入、且不會重領(表上可能已有同一則,例如上一輪已寫入)。 */
  ackedUnwritten: number;
}

export function newDrainTally(): DrainTally {
  return { processed: 0, saved: 0, duplicate: 0, unwritten: 0, acked: 0, ackedUnwritten: 0 };
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
  tally: DrainTally = newDrainTally(),
): Promise<DrainResult> {
  let offset = 0;
  let processed = 0;
  let aborted = false;
  outer: for (;;) {
    // timeout=0 → 不長等:有就回、沒有立刻回空(一次性語意,不要 block 住 Actions)。
    const updates = await callTelegramWithRetry("getUpdates", () =>
      bot.telegram.getUpdates(0, 100, offset, undefined),
    );
    // 這次 getUpdates 成功 = Telegram 已確認 offset 之前的全部更新(累積語意)。
    tally.acked = tally.processed;
    tally.ackedUnwritten = tally.unwritten;
    if (updates.length === 0) break;
    for (const u of updates) {
      persist.failed = false;
      persist.outcome = undefined;
      let threw = false;
      try {
        await bot.handleUpdate(u);
      } catch (err) {
        // 解析/路由層的非預期例外(非寫入失敗):這類重領也沒用,記錄後跳過。
        threw = true;
        logger.error(`處理 update ${u.update_id} 例外(跳過,下次不重領):${errSummary(err)}`);
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
      tally.processed = processed;
      // handler 沒回報去向、卻丟了例外 = 沒寫進表就被跳過。
      const outcome = persist.outcome ?? (threw ? "unwritten" : undefined);
      if (outcome) tally[outcome] += 1;
    }
  }
  // 正常結束時最後一次「空批」getUpdates(offset) 已 ack 最後一批,不需額外補 ack。
  // 中止結束時刻意不 ack 未處理段(含失敗那筆),留給下次 cron 重領。
  return { processed, aborted };
}

/**
 * 迴圈包一層:中途 reject 時先印回條(已處理 N 筆、M 筆尚未確認)再把原錯誤丟出去,
 * 讓呼叫端原本的 exit 1 / logFatal 不變。成功時回 result + tally,摘要由呼叫端印。
 */
export async function drainWithTally(
  bot: DrainableBot,
  persist: PersistFlag,
  persistDestination: string,
): Promise<{ result: DrainResult; tally: DrainTally }> {
  const tally = newDrainTally();
  try {
    const result = await drainUpdates(bot, persist, persistDestination, tally);
    return { result, tally };
  } catch (err) {
    logger.error(formatDrainSummary(null, tally));
    throw err;
  }
}

/** processed 之中沒被收進「寫入/重複/失敗未寫入」的(沒連結、指令、未授權…)。 */
function otherCount(t: DrainTally): number {
  return t.processed - t.saved - t.duplicate - t.unwritten;
}

/**
 * 收尾摘要(collect.yml Step Summary 靠 grep '已處理' 抓這一行,所以一律含「已處理 N 筆」)。
 * result = null 代表迴圈中途 reject(領取/確認更新失敗)。四種開頭各自不同;
 * 「寫入」只計確認寫入成功的(append 已落表才丟錯的那筆以表為準,摘要不計):
 *   drain 完成 / drain 有訊息失敗未寫入 / drain 中止 / drain 中斷
 *
 * 文字紀律:只用肯定句講「這一輪程式親眼看到的」(送出寫入且成功、哪些 getUpdates 成功、
 * 哪一步丟錯、這一輪沒對某則送出寫入);表上現況、Telegram 伺服器端狀態、下一輪會怎樣、
 * 該不該重貼,一律條件句或「請核對」。「失敗未寫入」= 這一輪在寫入前出錯、沒對它送出寫入,
 * 不等於「表上沒有」(例如上一輪其實已寫入,這一輪去重讀取失敗)。
 */
export function formatDrainSummary(result: DrainResult | null, t: DrainTally): string {
  const counts = `寫入 ${t.saved}、重複 ${t.duplicate}、失敗未寫入 ${t.unwritten}、其他 ${otherCount(t)}`;
  const unacked = t.processed - t.acked;
  // 兩種「未確認」來源,說法不同(程式只分得出這兩種:result.aborted 與 result === null):
  //  - 中止(result.aborted):迴圈 break 後根本沒再呼叫 getUpdates,確認請求沒送出,
  //    Telegram 端一定沒收到。但「重領」仍是對未來的預測:下一輪要成功領取、且更新還在
  //    Telegram 保留期內(約 24 小時,從訊息送出起算,不是從本輪中止重算)才領得到,所以帶前提。
  //  - 中斷(result === null):確認請求已送出但沒拿到成功回應(傳輸失敗或被拒)。若是回應遺失,
  //    伺服器端可能已經接受了新 offset → 呼叫端分不出,所以只能說「結果不明」,不可承諾重領。
  // 「去重通常會擋」:of/ofgay 抽不出影片 ID 的 raw_ 更新跨台北午夜重領會多一列(刻意政策),
  // 共用摘要不知道自己是哪個 target,措辭要對所有 target 都成立。
  const abortedUnackedNote =
    unacked > 0
      ? `;其中 ${unacked} 筆因中止沒送出確認,尚未確認:下一輪若成功領取、且更新還在 Telegram 保留期內(約 24 小時,從訊息送出起算),才會重領,去重通常會擋`
      : "";
  const uncertainUnwritten = t.unwritten - t.ackedUnwritten; // 確認結果不明那段裡的未寫入
  const uncertainNote =
    unacked > 0
      ? `;其中 ${unacked} 筆的確認結果不明(Telegram 沒回應成功):若其實未確認,下一輪若成功領取且仍在保留期內(約 24 小時,從訊息送出起算)才會重領,去重通常會擋;若其實已確認,就不會再領` +
        (uncertainUnwritten > 0
          ? `;這 ${unacked} 筆裡有 ${uncertainUnwritten} 筆這一輪沒有寫入(寫入前出錯):若其實已被確認收走就不會重領,請核對表上有沒有,沒有再重貼連結`
          : "")
      : "";
  // 先前批次已被確認收走、沒寫進表的筆數:跟「未確認段」是兩件事,兩者可同時成立,
  // 所以中斷/中止/收尾三種摘要都要各自帶出。
  const lostNote =
    t.ackedUnwritten > 0
      ? `;其中 ${t.ackedUnwritten} 筆這一輪沒有寫入(寫入前出錯)、已被確認收走、不會重領;表上可能已有同一則(例如上一輪已寫入),請先核對,沒有再重貼連結`
      : "";
  if (result === null) {
    return t.processed === 0
      ? "drain 中斷(領取更新失敗):已處理 0 筆更新,一筆都沒領到"
      : `drain 中斷(領取/確認更新失敗):已處理 ${t.processed} 筆更新(${counts})${uncertainNote}${lostNote}`;
  }
  if (result.aborted) {
    return `drain 中止(寫入失敗,部分未處理):已處理 ${t.processed} 筆更新(${counts})${abortedUnackedNote}${lostNote}`;
  }
  if (t.ackedUnwritten > 0) {
    return `drain 有訊息失敗未寫入:已處理 ${t.processed} 筆更新(${counts})${lostNote}`;
  }
  return `drain 完成:已處理 ${t.processed} 筆更新(${counts})`;
}

/** 印收尾摘要;完全正常用 info,其餘用 error(失敗通知的真因擷取撈得到)。 */
export function logDrainSummary(result: DrainResult, tally: DrainTally): void {
  const line = formatDrainSummary(result, tally);
  if (result.aborted || tally.ackedUnwritten > 0) logger.error(line);
  else logger.info(line);
}

/**
 * aborted(寫入失敗中止)→ 2;有訊息被確認收走卻沒寫進表(傳入 tally 才判)→ 3;
 * 正常 → 0,讓 collect.yml 不會假綠。(領取/確認失敗是 reject,由 entry 走 exit 1。)
 */
export function exitCodeFor(result: DrainResult, tally?: DrainTally): number {
  if (result.aborted) return 2;
  return tally && tally.ackedUnwritten > 0 ? 3 : 0;
}
