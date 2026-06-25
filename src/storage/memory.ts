/**
 * 記憶體版 Storage —— 給單元測試與本機 dry-run 用,不碰網路。
 */
import type { Storage, DuplicateHit, StatsSummary } from "./Storage.js";
import type { RefRow } from "../types.js";
import { computeStats } from "./computeStats.js";

export class MemoryStorage implements Storage {
  private rows: RefRow[] = [];

  constructor(seed: RefRow[] = []) {
    this.rows = [...seed];
  }

  async ensureHeader(): Promise<void> {
    // 記憶體版用固定 schema,無需建表頭。
  }

  async append(row: RefRow): Promise<void> {
    this.rows.push(row);
  }

  async readAll(): Promise<RefRow[]> {
    return [...this.rows];
  }

  async readRows(): Promise<DuplicateHit[]> {
    return this.rows.map((row, i) => ({ row, rowNumber: i + 2 })); // +2:表頭 + 1-based
  }

  async stats(opts: { recentLimit: number; nowMs: number }): Promise<StatsSummary> {
    return computeStats(this.rows, opts);
  }
}
