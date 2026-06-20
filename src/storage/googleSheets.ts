/**
 * Google Sheets 版 Storage。
 * - 最小權限:只用 spreadsheets scope。
 * - 寫入一律 RAW(避免影片ID/開頭 0 被當數字)。
 * - append 用 values.append;狀態更新用 values.update 單格。
 */
import { google, type sheets_v4 } from "googleapis";
import type { Storage, DuplicateHit, StatsSummary } from "./Storage.js";
import type { StagingRow } from "../types.js";
import { STAGING_COLUMNS } from "../types.js";
import { computeStats } from "./computeStats.js";
import { ageInDays } from "../utils/date.js";
import { logger } from "../utils/logger.js";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

export interface GoogleSheetsOptions {
  credentials: { client_email: string; private_key: string };
  sheetId: string;
  sheetName: string;
}

/** 0-based 欄索引 → A1 欄字母(0→A, 25→Z, 26→AA)。 */
function colLetter(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

const LAST_COL = colLetter(STAGING_COLUMNS.length - 1);

/**
 * 429 / 5xx 退避重試(沿用 th-ops 策略)。其餘錯誤直接丟。
 * `alreadyDone`:重試前的冪等護欄 —— 非冪等寫入(append)可能「寫成功但回應遺失」
 * 觸發重試,導致雙寫;重試前先問一次「上次其實成功了嗎?」是就視為完成、不再重打。
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { tries?: number; alreadyDone?: () => Promise<boolean> } = {},
): Promise<T> {
  const tries = opts.tries ?? 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const e = err as { code?: number; response?: { status?: number } };
      const code = e?.code ?? e?.response?.status;
      const retryable = code === 429 || (typeof code === "number" && code >= 500 && code < 600);
      if (!retryable || attempt === tries) throw err;
      if (opts.alreadyDone) {
        try {
          if (await opts.alreadyDone()) {
            logger.warn(`${label} 第 ${attempt} 次回應遺失但寫入已存在,視為成功(不重打)`);
            return undefined as T;
          }
        } catch {
          // 護欄查詢本身失敗就照常重試,不放大故障。
        }
      }
      const backoff = 500 * 2 ** (attempt - 1); // 0.5s,1s,2s
      logger.warn(`${label} 第 ${attempt}/${tries} 次失敗(code=${code}),${backoff}ms 後重試`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

export class GoogleSheetsStorage implements Storage {
  private sheets: sheets_v4.Sheets;
  private readonly sheetId: string;
  private readonly sheetName: string;

  constructor(opts: GoogleSheetsOptions) {
    this.sheetId = opts.sheetId;
    this.sheetName = opts.sheetName;
    const auth = new google.auth.JWT({
      email: opts.credentials.client_email,
      key: opts.credentials.private_key,
      scopes: SCOPES,
    });
    this.sheets = google.sheets({ version: "v4", auth });
  }

  /** `暫存區!A1:N1` 之類的 range,中文分頁名要加引號。 */
  private range(a1: string): string {
    return `'${this.sheetName}'!${a1}`;
  }

  private rowToValues(row: StagingRow): string[] {
    return STAGING_COLUMNS.map((c) => String(row[c] ?? ""));
  }

  private valuesToRow(values: string[]): StagingRow {
    const obj = {} as Record<string, string>;
    STAGING_COLUMNS.forEach((c, i) => {
      obj[c] = values[i] ?? "";
    });
    return obj as unknown as StagingRow;
  }

  /** 分頁不存在就建(voc init-sheet 不建「暫存區」,bot 自己負責)。 */
  private async ensureTab(): Promise<boolean> {
    const meta = await withRetry("取分頁清單", () =>
      this.sheets.spreadsheets.get({
        spreadsheetId: this.sheetId,
        fields: "sheets.properties.title",
      }),
    );
    const titles = (meta.data.sheets ?? []).map((s) => s.properties?.title);
    if (titles.includes(this.sheetName)) return false;
    logger.info(`分頁不存在,建立:${this.sheetName}`);
    await withRetry("建立分頁", () =>
      this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.sheetId,
        requestBody: { requests: [{ addSheet: { properties: { title: this.sheetName } } }] },
      }),
    );
    return true;
  }

  async ensureHeader(): Promise<void> {
    const created = await this.ensureTab();
    const res = await withRetry("讀表頭", () =>
      this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: this.range(`A1:${LAST_COL}1`),
      }),
    );
    const header = res.data.values?.[0] ?? [];
    const expected = STAGING_COLUMNS as string[];
    const empty = header.length === 0;
    const aligned =
      header.length === expected.length && expected.every((c, i) => header[i] === c);

    if (empty || created) {
      // 全新分頁/空表頭 → 寫入正確表頭
      await withRetry("寫表頭", () =>
        this.sheets.spreadsheets.values.update({
          spreadsheetId: this.sheetId,
          range: this.range(`A1:${LAST_COL}1`),
          valueInputOption: "RAW",
          requestBody: { values: [expected] },
        }),
      );
    } else if (!aligned) {
      // 已有表頭但跟 schema 不一致 → fail fast。append 用固定欄序硬塞,放行會「錯欄寫入」
      // (平台值落到 DATE 欄之類)靜默毀資料。寧可停在這(對齊註解原本的意圖)也不要默默寫壞。
      throw new Error(
        `暫存區表頭與 schema 不一致且非空,拒絕寫入(避免錯欄毀資料)。` +
          `現有=[${header.join(",")}] 期望=[${expected.join(",")}]。請人工對齊表頭。`,
      );
    }
  }

  /** 讀原始 values(A2 起),回 [實體列號, 該列字串陣列]。空白列跳過但列號仍正確。 */
  private async rawRows(): Promise<{ rowNumber: number; cells: string[] }[]> {
    const res = await withRetry("讀資料", () =>
      this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: this.range(`A2:${LAST_COL}`),
      }),
    );
    const values = res.data.values ?? [];
    const out: { rowNumber: number; cells: string[] }[] = [];
    for (let i = 0; i < values.length; i++) {
      const cells = values[i]!.map((c) => String(c ?? ""));
      if (!cells.some((c) => c.trim() !== "")) continue; // 跳空白列,但 i 仍照算
      out.push({ rowNumber: i + 2, cells }); // +2:表頭 + 1-based
    }
    return out;
  }

  async readAll(): Promise<StagingRow[]> {
    return (await this.rawRows()).map((r) => this.valuesToRow(r.cells));
  }

  async readRows(): Promise<DuplicateHit[]> {
    return (await this.rawRows()).map((r) => ({
      row: this.valuesToRow(r.cells),
      rowNumber: r.rowNumber,
    }));
  }

  async findByVideoId(videoId: string, withinDays?: number): Promise<DuplicateHit | null> {
    const key = videoId.trim(); // 改進#1:lookup 去多餘空白
    if (!key) return null; // 空 key 不去重(避免跟空白列互撞)
    for (const { row, rowNumber } of await this.readRows()) {
      if (row.VIDEO_ID.trim() !== key) continue;
      // 只在「日期可解析且確實超窗」時才略過;解析不出(ageInDays=Infinity)時
      // 不能略過 —— 否則同 VIDEO_ID 但 DATE 被改壞的列會被當成不存在而重寫。
      const age = ageInDays(row.DATE);
      if (withinDays != null && Number.isFinite(age) && age > withinDays) continue;
      return { row, rowNumber };
    }
    return null;
  }

  async append(row: StagingRow): Promise<void> {
    await withRetry(
      "append",
      () =>
        this.sheets.spreadsheets.values.append({
          spreadsheetId: this.sheetId,
          range: this.range(`A1:${LAST_COL}`),
          valueInputOption: "RAW",
          insertDataOption: "INSERT_ROWS",
          requestBody: { values: [this.rowToValues(row)] },
        }),
      {
        // 冪等護欄:呼叫端(collect)已先去重,故重試前若這 VIDEO_ID 已在表上,
        // 必是上一次「寫成功但回應遺失」留下的,視為完成,避免重試雙寫。
        alreadyDone: async () =>
          !!row.VIDEO_ID.trim() && (await this.findByVideoId(row.VIDEO_ID)) != null,
      },
    );
  }

  async stats(opts: { recentLimit: number; nowMs: number }): Promise<StatsSummary> {
    const rows = await this.readAll();
    return computeStats(rows, opts);
  }

  /** 取本分頁的數字 sheetId(gid),deleteDimension 需要它(range 字串不行)。 */
  private async getSheetGid(): Promise<number> {
    const meta = await withRetry("取分頁 gid", () =>
      this.sheets.spreadsheets.get({
        spreadsheetId: this.sheetId,
        fields: "sheets.properties(title,sheetId)",
      }),
    );
    const sheet = (meta.data.sheets ?? []).find(
      (s) => s.properties?.title === this.sheetName,
    );
    const gid = sheet?.properties?.sheetId;
    if (gid == null) throw new Error(`找不到分頁 ${this.sheetName} 的 sheetId`);
    return gid;
  }

  async pruneOlderThan(days: number, opts?: { dryRun?: boolean }): Promise<number> {
    const dateIdx = STAGING_COLUMNS.indexOf("DATE");
    // 用既有 rawRows():帶正確實體列號、空白列已跳過。
    const victims = (await this.rawRows()).filter((r) => {
      const age = ageInDays(r.cells[dateIdx] ?? "");
      // 窗外 = 年齡有限且 > days。Infinity(DATE 解析不出)一律保留(與去重一致)。
      return Number.isFinite(age) && age > days;
    });
    if (opts?.dryRun || victims.length === 0) return victims.length;

    const gid = await this.getSheetGid();
    // rowNumber(1-based,含表頭)→ 0-based dimension index。把連續列合併成區段,
    // 再「由下往上」刪(startIndex 大的先刪)—— 刪一段不會位移它上面的列號,故捕捉到的
    // 實體列號全程有效,不會刪一列後位移誤刪。
    const idxAsc = victims.map((v) => v.rowNumber - 1).sort((a, b) => a - b);
    const ranges: { start: number; end: number }[] = []; // [start, end) 半開
    for (const i of idxAsc) {
      const last = ranges[ranges.length - 1];
      if (last && i === last.end) last.end = i + 1; // 接續 → 延長區段
      else ranges.push({ start: i, end: i + 1 });
    }
    ranges.sort((a, b) => b.start - a.start); // 由下往上

    await withRetry("prune 刪列", () =>
      this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.sheetId,
        requestBody: {
          requests: ranges.map((r) => ({
            deleteDimension: {
              range: { sheetId: gid, dimension: "ROWS", startIndex: r.start, endIndex: r.end },
            },
          })),
        },
      }),
    );
    return victims.length;
  }
}
