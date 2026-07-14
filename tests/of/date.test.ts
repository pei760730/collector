/**
 * utils/date 釘住(re-export core 後的行為核對):
 * 本地過期副本帶兩個已知 bug —— ① ISO fallback dayjs(s).tz(TZ) 先用 runner 本地時區解析,
 * UTC+9..+14 上日期倒退一天(ageInDays off-by-one,CI 在 UTC 被遮蔽);② 溢位日期
 * (2026/2/30、2026-02-30)被 dayjs 滾動接受。改吃 core 版後,本檔釘住修正行為不回退,
 * 以及 feed 專屬 todayTaipei(YYYY/M/D 不補零)不漂移。
 */
import { describe, expect, it } from "vitest";

import { ageInDays, parseSheetDate, todayTaipei } from "../../src/engines/of/utils/date.js";

// 2026-07-09 12:00 台北(= 04:00 UTC)。
const NOW = Date.UTC(2026, 6, 9, 4, 0, 0);

describe("todayTaipei(feed 專屬:DATE 欄 YYYY/M/D 不補零)", () => {
  it("不補零格式", () => {
    expect(todayTaipei(NOW)).toBe("2026/7/9");
  });

  it("台北牆鐘跨日:UTC 前一日 23:00 = 台北 07:00,日期要進位", () => {
    // 2026-07-08 23:00 UTC = 2026-07-09 07:00 台北
    expect(todayTaipei(Date.UTC(2026, 6, 8, 23, 0, 0))).toBe("2026/7/9");
  });
});

describe("parseSheetDate(core 版):溢位日期拒絕,不滾動接受", () => {
  it("YYYY/M/D 溢位(2026/2/30)→ null", () => {
    expect(parseSheetDate("2026/2/30")).toBeNull();
  });

  it("ISO 溢位(2026-02-30)→ null", () => {
    expect(parseSheetDate("2026-02-30")).toBeNull();
  });

  it("合法 YYYY/M/D 照收", () => {
    expect(parseSheetDate("2026/7/9")?.format("YYYY-MM-DD")).toBe("2026-07-09");
  });
});

describe("ageInDays(core 版):ISO fallback 以台北牆鐘解析,無 off-by-one", () => {
  it("ISO 昨天 = 1(舊寫法在 UTC+9..+14 runner 上會算成 2)", () => {
    expect(ageInDays("2026-07-08", NOW)).toBe(1);
  });

  it("YYYY/M/D 今天 = 0", () => {
    expect(ageInDays("2026/7/9", NOW)).toBe(0);
  });

  it("解析不出 → Infinity(不計入本週/本月)", () => {
    expect(ageInDays("not-a-date", NOW)).toBe(Infinity);
    expect(ageInDays("2026/2/30", NOW)).toBe(Infinity);
  });
});
