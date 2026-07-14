/**
 * 日期工具 —— 固定 Asia/Taipei 時區。
 * TZ / parseSheetDate / ageInDays 已抽進 @pei760730/collector-core,本路徑 re-export
 * (core parseSheetDate 本就吃 YYYY/M/D + ISO;且修了本地過期副本的兩個已知 bug:
 *  ① ISO fallback 舊寫法 dayjs(s).tz(TZ) 先用 runner 本地時區解析 → UTC+9..+14 上
 *    日期倒退一天,ageInDays off-by-one(core #17);
 *  ② 溢位日期如 2026-02-30 被 dayjs 滾動接受 → core 用回寫比對拒絕,回 null)。
 *
 * 只留 feed 專屬 todayTaipei:DATE 欄格式 YYYY/M/D(年/月/日,不補零;沿用 n8n moment 行為),
 * 與 core 的 todayIsoTaipei(YYYY-MM-DD)不同,不上移。
 */
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { TZ } from "@pei760730/collector-core";

dayjs.extend(utc);
dayjs.extend(timezone);

export { TZ, parseSheetDate, ageInDays } from "@pei760730/collector-core";

/** 今天日期字串 YYYY/M/D(台北);epoch ms 可注入以利測試。 */
export function todayTaipei(nowMs: number = Date.now()): string {
  const d = dayjs(nowMs).tz(TZ);
  return `${d.year()}/${d.month() + 1}/${d.date()}`;
}
