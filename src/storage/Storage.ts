/**
 * Storage interface —— bot 只認這份介面,不認 Google Sheets。
 * 換儲存來源(DB / 別的試算表)只需新增一個實作,handlers 不用動。
 */
import type { StagingRow } from "../types.js";

export interface DuplicateHit {
  row: StagingRow;
  /** 在 sheet 的列號(1-based,含表頭)。 */
  rowNumber: number;
}

export interface StatsSummary {
  total: number;
  byPlatform: Record<string, number>;
  addedThisWeek: number;
  addedThisMonth: number;
  recent: StagingRow[];
}

export interface Storage {
  /** 確保表頭存在且與 schema 一致(冪等)。 */
  ensureHeader(): Promise<void>;

  /**
   * 依 VIDEO_ID 找重複。withinDays 給定時只算「N 天內」的同 ID。
   * 回傳第一筆 match(含列號),無則 null。
   */
  findByVideoId(videoId: string, withinDays?: number): Promise<DuplicateHit | null>;

  /** append 一列。 */
  append(row: StagingRow): Promise<void>;

  /** 讀全部資料列(不含表頭)。 */
  readAll(): Promise<StagingRow[]>;

  /** 讀全部資料列 + **正確實體列號**(去重比對用;空白列已跳過但列號正確)。 */
  readRows(): Promise<DuplicateHit[]>;

  /** 統計(供 /stats)。 */
  stats(opts: { recentLimit: number; nowMs: number }): Promise<StatsSummary>;
}
