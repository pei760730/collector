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

  /**
   * 清掉「窗外」舊列(暫存區是 append-only,不清會無限長)。
   * 只刪「年齡為**有限值**且 > days」的列;DATE 解析不出(ageInDays=Infinity)的列**一律保留** ——
   * 必須與去重邏輯一致(去重對 Infinity 視為「不可略過、仍存在」),否則同 VIDEO_ID 但 DATE
   * 壞掉的列會被誤刪後重寫。窗外列 bot 去重本來就忽略(age > withinDays → 跳過),刪掉不影響去重。
   * dryRun=true 時只回「會刪幾筆」不真刪。回傳刪除(或將刪)筆數。
   */
  pruneOlderThan(days: number, opts?: { dryRun?: boolean }): Promise<number>;
}
