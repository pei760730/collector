/**
 * drain —— 一次性把 Telegram 這 24h 內囤的更新撈乾、處理、寫進「參考池」,然後結束。
 *
 * 取代常駐 long polling:給 GitHub Actions cron 週期呼叫,$0、不需常駐機器,
 * 也避開 Docker-on-WSL2 對 googleapis 大封包的 Premature close(Actions 跑 ubuntu 直連)。
 *
 * 為什麼「定時撈一次」不漏訊息:Telegram 會保留未領取的更新約 24h。只要 cron 間隔 < 24h,
 * 每次把待領更新領乾即可。用 getUpdates(offset) 逐批領 + ack(下一次帶新 offset 即確認上一批);
 * 處理走和常駐完全相同的 `bot.handleUpdate`,行為一致、不重寫邏輯。
 *
 * 失敗語意:中途崩潰沒 ack → 下次 cron 重領,storage 去重(連結 key)擋掉重複。
 * at-least-once,寧可重複看得到也不要遺失(對齊 voc move_row 的同款取捨)。
 *
 * #9 三併一:這裡是「target 生產組裝點」(唯一一個)—— 依 COLLECTOR_TARGET(config.target,
 * 預設 voc)取 TargetSpec,storage 吃該 target 的欄位/文案參數。編排本體在 drainRun.ts(可測)。
 */
import { loadConfig } from "./config.js";
import { getTarget } from "./targets.js";
import { runDrain } from "./drainRun.js";
import { GoogleSheetsStorage } from "./storage/googleSheets.js";
import { MemoryStorage } from "./storage/memory.js";
import type { Storage } from "./storage/Storage.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<number> {
  const config = loadConfig();
  const target = getTarget(config.target);
  // DATE / 去重窗一律 Asia/Taipei(utils/date.ts 寫死),不靠 process.env.TZ。

  let storage: Storage;
  if (config.storage === "memory") {
    storage = new MemoryStorage();
    logger.warn("STORAGE=memory 乾跑:不寫真表,只驗領取/處理流程");
  } else {
    if (!config.google) throw new Error("sheets 模式缺 Google 設定");
    storage = new GoogleSheetsStorage({
      credentials: config.google.credentials,
      sheetId: config.google.sheetId,
      sheetName: config.google.poolSheetName,
      columns: target.columns,
      owner: target.owner,
    });
  }
  logger.info(`drain target=${target.name}`);
  return runDrain(config, storage, target);
}

// #9 三併一 Phase 3:of target 走 vendored feed 引擎(engines/of/,自帶 config/storage/router
// 與自己的 drain entry,import 即執行、自行 process.exit)。feed 與 voc/tbvoc 是刻意不同的
// scope(暫存區英文 5 欄、STATUS 狀態流、tt_/dy_ 前綴),不塞 TargetSpec —— 這裡是唯一接點,
// voc/tbvoc 路徑一行不動。
if ((process.env.COLLECTOR_TARGET ?? "voc").trim() === "of") {
  // trim:此分支比對 raw env,殼內 enumEnv(core)容忍前後空白;不 trim 的話
  // "of "(尾空白)不委派、落殼後 enumEnv 丟「只能是 voc/tbvoc」誤導排查。
  await import("./engines/of/drain.js");
} else {
  main()
    // 顯式退出:避免 telegraf/gaxios 殘留 keep-alive handle 讓 Actions job 卡到 timeout。
    // aborted → exit 2(非 0):舊版一律 exit 0 會讓 collect.yml 假綠、kai-notify(if: failure())
    // 永不觸發 —— Sheets 壞掉 + ERROR_CHAT_ID 沒設時就是靜默丟資料。ERROR_CHAT_ID 告警
    // 在 handleUpdate 內由 router notifyError await 送完才回來,main resolve 時已送出,
    // 這裡 exit 不會截斷告警。
    .then((code) => process.exit(code))
    .catch((err) => {
      logger.error("drain 失敗", err);
      process.exit(1);
    });
}
