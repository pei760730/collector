import type { StagingRow } from "../types.js";

/** 保留既有 raw replay 條件；VIDEO_ID 不作為候選唯一鍵。 */
export function isRawReplay(row: StagingRow, cleanUrl: string, date: string): boolean {
  return row.VIDEO_ID.startsWith("raw_") &&
    row.CLEAN_URL.trim() === cleanUrl && row.DATE === date;
}
