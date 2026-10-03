/**
 * Google Sheets 版 Storage。
 * - 最小權限:只用 spreadsheets scope。
 * - 寫入一律 RAW(避免 video ID / 開頭 0 被當數字)。
 * - 空表才寫正規表頭;非空 → 不覆寫(避免毀資料)。
 *
 * 表頭飄移防護(2026-06-26):欄位對映改「依實際表頭具名解析」,不再假設固定欄序。
 * 表頭被重排、前面多一欄、後面有空欄,都能把值寫到正確的具名欄、讀回也對得上,而不是因為
 * 「順序/長度不完全相等」就把整輪 drain 打掛。唯一仍 fail-fast = 某個必要欄整個不存在
 * (那才會錯欄毀資料,寧可停下等人對齊)。`findApprovedByUrl` 早已是具名解析,本次對齊其餘讀寫。
 */
import { google, type sheets_v4 } from "googleapis";
// 退避重試(只對暫態錯誤:429/5xx + 網路型)+ 表頭具名解析工具(colLetter / resolveHeaderIndexes /
// placeRow / readNamedRow / HeaderLayout),三 collector 逐字相同,已抽進 collector-core(SSoT)。
// feed 只留自家 schema 常數(STAGING_COLUMNS / 總表 URL 欄名)。
import {
  withRetry,
  colLetter,
  resolveHeaderIndexes,
  placeRow,
  readNamedRow,
  type HeaderLayout,
  type GoogleServiceAccountCredentials,
} from "@pei760730/collector-core";
import { approvedGateKey } from "./approvedKey.js";
import type { Storage, DuplicateHit, StatsSummary } from "./Storage.js";
import type { StagingRow } from "../types.js";
import { STAGING_COLUMNS } from "../types.js";
import { computeStats } from "./computeStats.js";
import { isRawReplay } from "./rawReplay.js";
import { logger } from "../utils/logger.js";
import { appendWithIdempotencyGuard } from "../../../shared/appendIdempotency.js";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

export interface GoogleSheetsOptions {
  credentials: GoogleServiceAccountCredentials;
  sheetId: string;
  sheetName: string;
  prodSheetName: string;
  /**
   * 總表去重 gate 失效(讀不到總表/找不到 URL 欄)時通知。gate 是 fail-soft:失效照常收錄
   * (可能重複),但這是全 pipeline 唯一「下游改變收集行為」的跨系統閉環,斷了不能無聲——
   * 由呼叫端(drain)接去 Telegram 告警。不給 = 維持原行為(只 logger.warn)。
   */
  onGateSkip?: (detail: string) => void;
}

const LAST_COL = colLetter(STAGING_COLUMNS.length - 1);
const PROD_URL_HEADER = "影片連結";

export class GoogleSheetsStorage implements Storage {
  private sheets: sheets_v4.Sheets;
  private readonly sheetId: string;
  private readonly sheetName: string;
  private readonly prodSheetName: string;
  private readonly onGateSkip?: (detail: string) => void;
  private layoutCache?: HeaderLayout;
  // 單輪 drain 的去重索引/總表集合快取(每實例一份;drain 每輪新建實例)。
  private videoIdCache?: Map<string, DuplicateHit>;
  private rawReplayCache?: DuplicateHit[];
  private approvedCache?: Set<string>;

  constructor(opts: GoogleSheetsOptions) {
    this.sheetId = opts.sheetId;
    this.sheetName = opts.sheetName;
    this.prodSheetName = opts.prodSheetName;
    this.onGateSkip = opts.onGateSkip;
    const auth = new google.auth.JWT({
      email: opts.credentials.client_email,
      key: opts.credentials.private_key,
      scopes: SCOPES,
    });
    this.sheets = google.sheets({ version: "v4", auth });
  }

  /** `'暫存區'!A1:G1` 之類的 range,中文分頁名要加引號。 */
  private range(a1: string): string {
    return `'${this.sheetName}'!${a1}`;
  }

  private prodRange(a1: string): string {
    return `'${this.prodSheetName}'!${a1}`;
  }

  /**
   * 確認分頁存在,不存在就 fail-fast(不自動建)。
   * 自動建分頁會在 GOOGLE_SHEET_ID / STAGING_SHEET_NAME 設錯時,於錯誤試算表靜默生出空分頁,
   * chat-only owner 永遠不會發現。寧可大聲報錯(collect.yml 的 if:failure() 會 Telegram 通知)。
   */
  private async ensureTab(): Promise<void> {
    const meta = await withRetry("取分頁清單", () =>
      this.sheets.spreadsheets.get({
        spreadsheetId: this.sheetId,
        fields: "sheets.properties.title",
      }),
    );
    const titles = (meta.data.sheets ?? []).map((s) => s.properties?.title);
    if (titles.includes(this.sheetName)) return;
    throw new Error(
      `分頁「${this.sheetName}」不存在 — 請確認 GOOGLE_SHEET_ID / STAGING_SHEET_NAME。` +
        `(本服務不自動建分頁,避免在錯誤試算表靜默建空表。)`,
    );
  }

  async ensureHeader(): Promise<void> {
    await this.ensureTab();
    const res = await withRetry("讀表頭", () =>
      this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: this.range("1:1"),
      }),
    );
    const header = res.data.values?.[0] ?? [];

    if (header.length === 0) {
      // 空表:寫入正規 schema 表頭(本服務唯一會動表頭的情形)。
      const expected = STAGING_COLUMNS as string[];
      await withRetry("寫表頭", () =>
        this.sheets.spreadsheets.values.update({
          spreadsheetId: this.sheetId,
          range: this.range(`A1:${LAST_COL}1`),
          valueInputOption: "RAW",
          requestBody: { values: [expected] },
        }),
      );
      this.layoutCache = resolveHeaderIndexes(expected, STAGING_COLUMNS, "暫存區");
      return;
    }

    // 非空:依實際表頭具名解析。必要欄齊全就放行(容忍重排/多欄/空欄);缺欄才 fail-fast。
    this.layoutCache = resolveHeaderIndexes(header, STAGING_COLUMNS, "暫存區");
  }

  /** 讀「實際表頭」並解析具名欄索引(每實例快取一次;委派給 ensureHeader 處理空表)。 */
  private async layout(): Promise<HeaderLayout> {
    if (this.layoutCache) return this.layoutCache;
    await this.ensureHeader();
    return this.layoutCache!;
  }

  /** 讀原始 values(A2 起),回 [實體列號, 該列字串陣列]。空白列跳過但列號仍正確。 */
  private async rawRows(layout: HeaderLayout): Promise<{ rowNumber: number; cells: string[] }[]> {
    const res = await withRetry("讀資料", () =>
      this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: this.range(`A2:${colLetter(layout.width - 1)}`),
      }),
    );
    const values = res.data.values ?? [];
    const out: { rowNumber: number; cells: string[] }[] = [];
    for (let i = 0; i < values.length; i++) {
      const cells = values[i]!.map((c) => String(c ?? ""));
      if (!cells.some((c) => c.trim() !== "")) continue;
      out.push({ rowNumber: i + 2, cells }); // +2:表頭 + 1-based
    }
    return out;
  }

  /**
   * 暫存區去重索引:第一次讀全表建 Map(一次 values.get),之後直接回快取(O(1)、無網路)。
   * append 成功後會把新 key 併入這份快取(見 append 尾端),故同輪稍後的重複也擋得到。
   * 空 VIDEO_ID 不索引(對齊 findByVideoId「空 key 不去重」);同 key 保留首筆(列號最小)。
   */
  async videoIdIndex(): Promise<Map<string, DuplicateHit>> {
    await this.loadStagingIndexes();
    return this.videoIdCache!;
  }

  private async loadStagingIndexes(): Promise<void> {
    if (this.videoIdCache && this.rawReplayCache) return;
    const layout = await this.layout();
    const index = new Map<string, DuplicateHit>();
    const rawCandidates: DuplicateHit[] = [];
    for (const { rowNumber, cells } of await this.rawRows(layout)) {
      const row = readNamedRow(cells, STAGING_COLUMNS, layout) as unknown as StagingRow;
      const key = row.VIDEO_ID.trim();
      if (!key) continue;
      if (!index.has(key)) index.set(key, { row, rowNumber });
      if (row.VIDEO_ID.startsWith("raw_")) rawCandidates.push({ row, rowNumber });
    }
    this.videoIdCache = index;
    this.rawReplayCache = rawCandidates;
  }

  async findRawReplay(cleanUrl: string, date: string): Promise<DuplicateHit | null> {
    await this.loadStagingIndexes();
    return this.rawReplayCache!.find(({ row }) => isRawReplay(row, cleanUrl, date)) ?? null;
  }

  private invalidateStagingIndexes(): void {
    this.videoIdCache = undefined;
    this.rawReplayCache = undefined;
  }

  async findByVideoId(videoId: string): Promise<DuplicateHit | null> {
    const key = videoId.trim();
    if (!key) return null; // 空 key 不去重
    return (await this.videoIdIndex()).get(key) ?? null;
  }

  /**
   * 總表已收錄「閘門鍵」集合:第一次讀總表 URL 欄建 Set(讀表頭 + 讀整欄),之後回快取(O(1))。
   * 值為 approvedGateKey(= groupKey ∘ cleanUrl)——抗規則漂移**與參數/形態漂移**:歷史列是
   * 「當年的清理規則」寫的、還可能帶當年的分享參數或另一種分享形態(youtu.be vs watch?v=),
   * 字串比對會漏擋;改比 groupKey 之後同一支片永遠同一把鍵。建集合與查詢兩側走同一支函式。
   * fail-soft:讀不到總表 / URL 欄缺失或重複 → 回空 Set(照常收錄)並觸發 onGateSkip;
   * 失敗「不快取」(清掉才回),讓下一筆可再試(維持「gate 掛了也不放棄」的降級)。
   */
  async approvedKeySet(): Promise<Set<string>> {
    if (this.approvedCache) return this.approvedCache;

    let header: string[];
    try {
      const res = await withRetry("讀總表表頭", () =>
        this.sheets.spreadsheets.values.get({
          spreadsheetId: this.sheetId,
          range: this.prodRange("1:1"),
        }),
      );
      header = (res.data.values?.[0] ?? []).map((cell) => String(cell ?? "").trim());
    } catch (err) {
      logger.warn(`總表去重跳過:無法讀取分頁 ${this.prodSheetName}`, err);
      this.onGateSkip?.(`總表去重跳過:無法讀取分頁 ${this.prodSheetName}(擋回流 gate 失效,照常收錄)`);
      return new Set();
    }

    const urlColIndexes = header.flatMap((cell, i) => cell === PROD_URL_HEADER ? [i] : []);
    if (urlColIndexes.length !== 1) {
      const reason = urlColIndexes.length === 0
        ? `找不到「${PROD_URL_HEADER}」欄`
        : `「${PROD_URL_HEADER}」欄重複`;
      logger.warn(`總表去重跳過:${this.prodSheetName} ${reason}`);
      this.onGateSkip?.(`總表去重跳過:${this.prodSheetName} ${reason}(擋回流 gate 失效,照常收錄)`);
      return new Set();
    }

    const urlCol = colLetter(urlColIndexes[0]!);
    try {
      const res = await withRetry("讀總表影片連結", () =>
        this.sheets.spreadsheets.values.get({
          spreadsheetId: this.sheetId,
          range: this.prodRange(`${urlCol}2:${urlCol}`),
        }),
      );
      const values = res.data.values ?? [];
      const set = new Set<string>();
      for (const row of values) {
        const raw = String(row?.[0] ?? "").trim();
        if (!raw) continue;
        // raw 已由上面 `if (!raw) continue` 保證非空 → 算出的鍵必非空,不需再判一次。
        set.add(approvedGateKey(raw));
      }
      this.approvedCache = set;
      return set;
    } catch (err) {
      logger.warn(`總表去重跳過:無法讀取 ${this.prodSheetName} 的「${PROD_URL_HEADER}」欄`, err);
      this.onGateSkip?.(`總表去重跳過:無法讀取 ${this.prodSheetName} 的「${PROD_URL_HEADER}」欄(擋回流 gate 失效,照常收錄)`);
      return new Set();
    }
  }

  async findApprovedByUrl(cleanUrl: string): Promise<boolean> {
    const key = cleanUrl.trim();
    if (!key) return false;
    return (await this.approvedKeySet()).has(approvedGateKey(key));
  }

  async stats(opts: { recentLimit: number; nowMs: number }): Promise<StatsSummary> {
    const layout = await this.layout();
    const rows = (await this.rawRows(layout)).map(
      ({ cells }) => readNamedRow(cells, STAGING_COLUMNS, layout) as unknown as StagingRow,
    );
    return computeStats(rows, opts);
  }

  /** 每次重試重新讀；raw 候選需同時證明既有精確 URL / DATE 條件。 */
  private async freshAppendKeys(layout: HeaderLayout, candidate: StagingRow): Promise<Set<string>> {
    const set = new Set<string>();
    for (const { cells } of await this.rawRows(layout)) {
      const existing = readNamedRow(cells, STAGING_COLUMNS, layout) as unknown as StagingRow;
      if (candidate.VIDEO_ID.startsWith("raw_") && !isRawReplay(existing, candidate.CLEAN_URL, candidate.DATE)) continue;
      const id = existing.VIDEO_ID.trim();
      if (id) set.add(id);
    }
    return set;
  }

  async append(row: StagingRow): Promise<void> {
    const layout = await this.layout();
    // VIDEO_ID 保持原值；raw 重試另驗證 URL / DATE，不能把碰撞 ID 的無關列當作落地證明。
    let appended: { data: sheets_v4.Schema$AppendValuesResponse } | undefined;
    let videoId: string;
    try {
      const guarded = await appendWithIdempotencyGuard({
        row,
        keyOf: (candidate) => candidate.VIDEO_ID.trim(),
        fetchFreshKeys: () => this.freshAppendKeys(layout, row),
        append: () =>
          this.sheets.spreadsheets.values.append({
            spreadsheetId: this.sheetId,
            range: this.range(`A1:${colLetter(layout.width - 1)}`),
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [placeRow(row as unknown as Record<string, unknown>, STAGING_COLUMNS, layout)] },
          }),
      });
      videoId = guarded.key;
      appended = guarded.result;
    } catch (err) {
      // 最後一次嘗試仍可能已提交；下筆 raw replay 必須重讀，error / ack 規則不變。
      if (row.VIDEO_ID.startsWith("raw_")) this.invalidateStagingIndexes();
      throw err;
    }

    if (videoId && this.videoIdCache && (!this.videoIdCache.has(videoId) || row.VIDEO_ID.startsWith("raw_"))) {
      const a1 = (appended?.data?.updates?.updatedRange ?? "").split("!").pop() ?? "";
      const m = a1.match(/\d+/);
      // 拿不到真列號（含 lost-response guard 命中）就作廢兩份快取，不製造 rowNumber=0。
      if (!m) {
        this.invalidateStagingIndexes();
        return;
      }
      const hit = { row, rowNumber: Number(m[0]) };
      if (!this.videoIdCache.has(videoId)) this.videoIdCache.set(videoId, hit);
      // 保留 first-hit map，同 ID 的不同 raw 候選仍需更新到 replay 視圖。
      if (row.VIDEO_ID.startsWith("raw_")) this.rawReplayCache!.push(hit);
    }
  }
}
