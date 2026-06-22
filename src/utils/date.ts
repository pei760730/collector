/**
 * 日期工具 —— 固定 Asia/Taipei 時區。
 * DATE 欄格式 YYYY/M/D(沿用 n8n moment 行為,不補零)。
 */
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export const TZ = "Asia/Taipei";

/** 今天日期字串 YYYY/M/D(台北),epoch ms 可注入以利測試。 */
export function todayTaipei(nowMs: number = Date.now()): string {
  const d = dayjs(nowMs).tz(TZ);
  return `${d.year()}/${d.month() + 1}/${d.date()}`;
}

/**
 * 今天 ISO 日期字串 YYYY-MM-DD(台北),epoch ms 可注入以利測試。
 * 參考池「加入日期」用 ISO(對齊 voc schema 的 ISO 慣例 + voc normalize_date)。
 */
export function todayIsoTaipei(nowMs: number = Date.now()): string {
  return dayjs(nowMs).tz(TZ).format("YYYY-MM-DD");
}

/** 解析 YYYY/M/D 或 ISO 字串為 dayjs(台北);無法解析回 null。 */
export function parseSheetDate(s: string): dayjs.Dayjs | null {
  if (!s || !s.trim()) return null;
  // 先試 YYYY/M/D,再退回 dayjs 寬鬆解析
  const m = s.trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const [, y, mo, da] = m;
    return dayjs.tz(`${y}-${mo!.padStart(2, "0")}-${da!.padStart(2, "0")}`, TZ);
  }
  const d = dayjs(s.trim());
  return d.isValid() ? d.tz(TZ) : null;
}

/** 距今天數(台北);解析不出回 Infinity(視為超出任何窗格)。 */
export function ageInDays(dateStr: string, nowMs: number = Date.now()): number {
  const d = parseSheetDate(dateStr);
  if (!d) return Infinity;
  return dayjs(nowMs).tz(TZ).startOf("day").diff(d.startOf("day"), "day");
}
