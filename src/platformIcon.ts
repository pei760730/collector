/**
 * 平台碼 → emoji 的單一 SSoT。
 * 原本 stats.ts 與 templates.ts 各自用 PLATFORM_CODE × PLATFORM_ICON 手組同一份反查表、
 * 會漂移(core 加平台時只改一邊就不一致);抽到這裡兩處共用。
 * (core 於 collector-core 已內建 ICON_BY_CODE;待本 repo bump core 版本後可改直接 import。)
 */
import { PLATFORM_ICON } from "@pei760730/collector-core";

import { PLATFORM_CODE, type Platform } from "./types.js";

/** 小寫平台碼(tiktok…) → emoji。row.平台 存的是碼,不是顯示名。 */
export const ICON_BY_CODE: Record<string, string> = Object.fromEntries(
  (Object.keys(PLATFORM_CODE) as Platform[]).map((p) => [PLATFORM_CODE[p], PLATFORM_ICON[p]]),
);

export function iconFor(code: string): string {
  return ICON_BY_CODE[code] ?? "•";
}
