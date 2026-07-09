/**
 * 記憶體版 Storage —— 給單元測試與本機 dry-run 用,不碰網路。
 */
import type { Storage, DuplicateHit, StatsSummary } from "./Storage.js";
import type { RefRow } from "../types.js";
import { dedupKey } from "../pipeline/index.js";
import { computeStats } from "./computeStats.js";

export class MemoryStorage implements Storage {
  private rows: RefRow[] = [];
  private dedupCache?: Map<string, RefRow>;

  constructor(seed: RefRow[] = []) {
    this.rows = [...seed];
  }

  async ensureHeader(): Promise<void> {
    // 記憶體版用固定 schema,無需建表頭。
  }

  async append(row: RefRow): Promise<void> {
    this.rows.push(row);
    // 與 sheets 版一致:成功 append 後併入去重快取(若已建)。
    this.dedupCache?.set(dedupKey(row.連結), row);
  }

  async readAll(): Promise<RefRow[]> {
    return [...this.rows];
  }

  async readRows(): Promise<DuplicateHit[]> {
    return this.rows.map((row, i) => ({ row, rowNumber: i + 2 })); // +2:表頭 + 1-based
  }

  async dedupIndex(): Promise<Map<string, RefRow>> {
    if (this.dedupCache) return this.dedupCache;
    const index = new Map<string, RefRow>();
    for (const r of this.rows) {
      const key = dedupKey(r.連結);
      // 與 sheets 版一致:同 key 多列保第一筆(duplicateMsg 顯示「首次加入」)。
      if (!index.has(key)) index.set(key, r);
    }
    this.dedupCache = index;
    return index;
  }

  async stats(opts: { recentLimit: number; nowMs: number }): Promise<StatsSummary> {
    return computeStats(this.rows, opts);
  }
}
