/**
 * 記憶體版 Storage —— 給單元測試與本機 dry-run 用,不碰網路。
 */
import { cleanUrl as coreCleanUrl } from "@pei760730/collector-core";
import type { Storage, DuplicateHit, StatsSummary } from "./Storage.js";
import type { StagingRow } from "../types.js";
import { STAGING_COLUMNS } from "../types.js";
import { computeStats } from "./computeStats.js";

export interface MemoryStorageOptions {
  approvedUrls?: Iterable<string>;
  approvedUrlColumnAvailable?: boolean;
}

export class MemoryStorage implements Storage {
  private rows: StagingRow[] = [];
  private readonly approvedUrls: Set<string>;
  private readonly approvedUrlColumnAvailable: boolean;

  constructor(seed: StagingRow[] = [], opts: MemoryStorageOptions = {}) {
    this.rows = [...seed];
    // 值過 core cleanUrl 正規化(冪等):對齊 Storage 介面契約與 GoogleSheetsStorage 實作
    // (googleSheets approvedUrlSet 存入前過 coreCleanUrl)。只 trim 會與真實作分叉,
    // 用 MemoryStorage 跑的 gate 測試會假陰性(seed 髒連結 → 真實作擋、記憶體版放行)。
    this.approvedUrls = new Set(
      [...(opts.approvedUrls ?? [])]
        .map((url) => url.trim())
        .filter((url) => url !== "")
        .map((url) => coreCleanUrl(url).cleanUrl),
    );
    this.approvedUrlColumnAvailable = opts.approvedUrlColumnAvailable ?? true;
  }

  async ensureHeader(): Promise<void> {
    void STAGING_COLUMNS; // 記憶體版固定 schema,無需建表頭
  }

  async videoIdIndex(): Promise<Map<string, DuplicateHit>> {
    // 記憶體版每次現建(rows 是 append 直推的活陣列,不需快取;同輪稍後重複自然看得到)。
    const index = new Map<string, DuplicateHit>();
    for (let i = 0; i < this.rows.length; i++) {
      const r = this.rows[i]!;
      const key = r.VIDEO_ID.trim();
      if (!key) continue; // 空 key 不索引(對齊「空 key 不去重」)
      if (!index.has(key)) index.set(key, { row: r, rowNumber: i + 2 });
    }
    return index;
  }

  async findByVideoId(videoId: string): Promise<DuplicateHit | null> {
    const key = videoId.trim();
    if (!key) return null; // 空 key 不去重
    return (await this.videoIdIndex()).get(key) ?? null;
  }

  async approvedUrlSet(): Promise<Set<string>> {
    if (!this.approvedUrlColumnAvailable) return new Set(); // 欄不可用 → fail-soft 空集
    return new Set(this.approvedUrls);
  }

  async findApprovedByUrl(cleanUrl: string): Promise<boolean> {
    const key = cleanUrl.trim();
    if (!key) return false;
    // 查詢鍵同樣過 coreCleanUrl(對齊 googleSheets.findApprovedByUrl 的 normKey;冪等)。
    return (await this.approvedUrlSet()).has(coreCleanUrl(key).cleanUrl);
  }

  async append(row: StagingRow): Promise<void> {
    this.rows.push(row);
  }

  async stats(opts: { recentLimit: number; nowMs: number }): Promise<StatsSummary> {
    return computeStats(this.rows, opts);
  }

  /** 測試輔助:讀全部列。 */
  all(): StagingRow[] {
    return [...this.rows];
  }
}
