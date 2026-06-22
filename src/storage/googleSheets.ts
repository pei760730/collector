/**
 * Google Sheets 版 Storage —— 目標 = voc 的「參考池」分頁(2026-06-22 直寫,廢「暫存區」)。
 * - 最小權限:只用 spreadsheets scope。
 * - 寫入一律 RAW(避免影片ID/開頭 0 被當數字)。
 * - append 用 values.append;不刪列(參考池是 voc 永久池,prune 已退役)。
 * - 不自建/不覆寫表頭:參考池由 voc `init-sheet` 擁有;表頭缺/不齊一律 fail-fast,
 *   不替 voc 動表結構(避免錯欄寫入靜默毀資料)。
 */
import { google, type sheets_v4 } from "googleapis";
import type { Storage, DuplicateHit, StatsSummary } from "./Storage.js";
import type { RefRow } from "../types.js";
import { POOL_COLUMNS } from "../types.js";
import { dedupKey } from "../pipeline/index.js";
import { computeStats } from "./computeStats.js";
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

const LAST_COL = colLetter(POOL_COLUMNS.length - 1);

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

  /** `'參考池'!A1:E1` 之類的 range,中文分頁名要加引號。 */
  private range(a1: string): string {
    return `'${this.sheetName}'!${a1}`;
  }

  private rowToValues(row: RefRow): string[] {
    return POOL_COLUMNS.map((c) => String(row[c] ?? ""));
  }

  private valuesToRow(values: string[]): RefRow {
    const obj = {} as Record<string, string>;
    POOL_COLUMNS.forEach((c, i) => {
      obj[c] = values[i] ?? "";
    });
    return obj as unknown as RefRow;
  }

  /** 確認分頁存在(參考池由 voc 擁有,bot 不自建);不存在 → fail-fast。 */
  private async assertTab(): Promise<void> {
    const meta = await withRetry("取分頁清單", () =>
      this.sheets.spreadsheets.get({
        spreadsheetId: this.sheetId,
        fields: "sheets.properties.title",
      }),
    );
    const titles = (meta.data.sheets ?? []).map((s) => s.properties?.title);
    if (titles.includes(this.sheetName)) return;
    throw new Error(
      `找不到分頁「${this.sheetName}」。參考池由 voc 擁有,請先用 voc init-sheet 建表(bot 不自建 voc 的表)。`,
    );
  }

  async ensureHeader(): Promise<void> {
    await this.assertTab();
    const res = await withRetry("讀表頭", () =>
      this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: this.range(`A1:${LAST_COL}1`),
      }),
    );
    const header = res.data.values?.[0] ?? [];
    const expected = POOL_COLUMNS as string[];
    const aligned =
      header.length === expected.length && expected.every((c, i) => header[i] === c);
    if (!aligned) {
      // 不替 voc 改表頭:append 用固定欄序硬塞,表頭錯位會「錯欄寫入」(平台值落到連結欄之類)
      // 靜默毀 voc 的池。寧可停在這也不要默默寫壞。請對齊 voc schema.REFS 後再跑。
      throw new Error(
        `參考池表頭與 schema 不一致,拒絕寫入(避免錯欄毀資料)。` +
          `現有=[${header.join(",")}] 期望=[${expected.join(",")}]。請對齊 voc schema.REFS。`,
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

  async readAll(): Promise<RefRow[]> {
    return (await this.rawRows()).map((r) => this.valuesToRow(r.cells));
  }

  async readRows(): Promise<DuplicateHit[]> {
    return (await this.rawRows()).map((r) => ({
      row: this.valuesToRow(r.cells),
      rowNumber: r.rowNumber,
    }));
  }

  async append(row: RefRow): Promise<void> {
    const key = dedupKey(row.連結);
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
        // 冪等護欄:呼叫端(collect)已先去重,故重試前若這連結 key 已在表上,
        // 必是上一次「寫成功但回應遺失」留下的,視為完成,避免重試雙寫。
        alreadyDone: async () =>
          !!key && (await this.readRows()).some((h) => dedupKey(h.row.連結) === key),
      },
    );
  }

  async stats(opts: { recentLimit: number; nowMs: number }): Promise<StatsSummary> {
    const rows = await this.readAll();
    return computeStats(rows, opts);
  }
}
