/**
 * Storage interface —— bot 只認這份介面,不認 Google Sheets。
 * 換儲存來源(DB / 別的試算表)只需新增一個實作,handlers 不用動。
 *
 * 目標分頁 = voc 的「參考池」(2026-06-22 直寫,廢「暫存區」)。參考池是 voc 永久池,
 * bot 只 append 新素材、絕不刪列(prune 已隨暫存區一起退役)。去重靠連結即時推導的 key
 * (pipeline `dedupKey`),全表比對、無時間窗(對齊 voc sync 行為)。
 */
import type { RefRow } from "../types.js";

export interface DuplicateHit {
  row: RefRow;
  /** 在 sheet 的列號(1-based,含表頭)。 */
  rowNumber: number;
}

export interface StatsSummary {
  total: number;
  byPlatform: Record<string, number>;
  addedThisWeek: number;
  addedThisMonth: number;
  recent: RefRow[];
}

export interface Storage {
  /** 確保「參考池」存在且表頭與 schema 一致(不自建/不覆寫 voc 的表;不齊就 fail-fast)。 */
  ensureHeader(): Promise<void>;

  /** append 一列。 */
  append(row: RefRow): Promise<void>;

  /** 讀全部資料列(不含表頭)。 */
  readAll(): Promise<RefRow[]>;

  /** 讀全部資料列 + **正確實體列號**(去重比對用;空白列已跳過但列號正確)。 */
  readRows(): Promise<DuplicateHit[]>;

  /**
   * 去重索引:dedupKey → 既有那列。
   *
   * 單輪 drain 生命週期內**只讀一次全表**建索引、快取於 storage 實例;之後 collect 每筆
   * 去重都查這份 in-memory Map(O(1)),不再每筆 `readRows()` 全表讀(N+1)。`append`
   * 成功後把新列併入此快取,故同一輪稍後的重複連結也擋得到。常駐 polling 也共用同一份
   * (單實例),行為一致;不重新整輪讀表(參考池只 append 不刪、且只有此 bot 寫入)。
   */
  dedupIndex(): Promise<Map<string, RefRow>>;

  /** 統計(供 /stats)。 */
  stats(opts: { recentLimit: number; nowMs: number }): Promise<StatsSummary>;
}
