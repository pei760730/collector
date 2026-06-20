/**
 * 記憶體版 Storage —— 給單元測試與本機 dry-run 用,不碰網路。
 */
import type { Storage, DuplicateHit, StatsSummary } from "./Storage.js";
import type { StagingRow } from "../types.js";
import { STAGING_COLUMNS } from "../types.js";
import { computeStats } from "./computeStats.js";
import { ageInDays } from "../utils/date.js";

export class MemoryStorage implements Storage {
  private rows: StagingRow[] = [];

  constructor(seed: StagingRow[] = []) {
    this.rows = [...seed];
  }

  async ensureHeader(): Promise<void> {
    // 記憶體版用固定 schema,無需建表頭。引用 STAGING_COLUMNS 確保 schema 對齊。
    void STAGING_COLUMNS;
  }

  async findByVideoId(videoId: string, withinDays?: number): Promise<DuplicateHit | null> {
    const key = videoId.trim();
    if (!key) return null; // 空 key 不去重
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i]!;
      if (r.VIDEO_ID.trim() !== key) continue;
      // 與 GoogleSheetsStorage 一致:日期解析不出(Infinity)不可略過,
      // 否則 DATE 被改壞的同 VIDEO_ID 列會被當不存在而重寫。
      const age = ageInDays(r.DATE);
      if (withinDays != null && Number.isFinite(age) && age > withinDays) continue;
      return { row: r, rowNumber: i + 2 }; // +2:表頭 + 1-based
    }
    return null;
  }

  async append(row: StagingRow): Promise<void> {
    this.rows.push(row);
  }

  async readAll(): Promise<StagingRow[]> {
    return [...this.rows];
  }

  async readRows(): Promise<DuplicateHit[]> {
    return this.rows.map((row, i) => ({ row, rowNumber: i + 2 }));
  }

  async updateStatus(rowNumber: number, status: string): Promise<void> {
    const idx = rowNumber - 2;
    const r = this.rows[idx];
    if (r) r.STATUS = status;
  }

  async stats(opts: { recentLimit: number; nowMs: number }): Promise<StatsSummary> {
    return computeStats(this.rows, opts);
  }
}
