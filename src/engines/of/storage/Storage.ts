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

/** /stats 用的暫存區彙總(唯讀)。 */
export interface StatsSummary {
  total: number;
  byPlatform: Record<string, number>;
  byStatus: Record<string, number>;
  addedThisWeek: number;
  addedThisMonth: number;
  /** 最近 N 筆(由新到舊)。 */
  recent: StagingRow[];
}

export interface Storage {
  /** 確保分頁 + 表頭存在且與 schema 一致(冪等)。 */
  ensureHeader(): Promise<void>;

  /** 依 VIDEO_ID 找重複,回第一筆 match(含列號),無則 null。 */
  findByVideoId(videoId: string): Promise<DuplicateHit | null>;

  /**
   * 暫存區去重索引:VIDEO_ID(trim 後、非空)→ 第一筆命中(含列號)。
   * 單輪 drain 只讀一次全表建索引後快取,之後查 in-memory(O(1)、無網路),
   * 取代逐訊息 findByVideoId 的全表掃描(N 筆 → N 次全表讀)。append 成功後應把
   * 新寫入列的 VIDEO_ID 併入,讓同輪稍後的重複也擋得到。
   */
  videoIdIndex(): Promise<Map<string, DuplicateHit>>;

  /**
   * 用 CLEAN_URL 完全比對總表(已產出/待拍池)是否已有這支片。
   * 回 true 表示已存在於總表,收集端不可再 append 回暫存區。
   * 實作應 trim cleanUrl 與儲存值;空字串視為無命中。
   */
  findApprovedByUrl(cleanUrl: string): Promise<boolean>;

  /**
   * 總表(已產出/待拍池)已收錄 URL 的集合,值為 core cleanUrl 正規化後的字串。
   * 單輪 drain 只讀一次總表 URL 欄建集合後快取,之後查 in-memory(O(1)),取代逐訊息
   * findApprovedByUrl 的「讀表頭 + 讀整欄」兩次全欄讀。
   * fail-soft:讀不到總表 / 找不到 URL 欄時回空 Set(照常收錄)並觸發 onGateSkip;
   * 失敗不快取(下一筆可再試)。
   */
  approvedUrlSet(): Promise<Set<string>>;

  /** append 一列。 */
  append(row: StagingRow): Promise<void>;

  /** 讀全部暫存區列彙總成統計(/stats 用,唯讀)。 */
  stats(opts: { recentLimit: number; nowMs: number }): Promise<StatsSummary>;
}
