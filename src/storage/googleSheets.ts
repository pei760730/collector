/**
 * Google Sheets 版 Storage —— 目標 = voc 的「參考池」分頁(2026-06-22 直寫,廢「暫存區」)。
 * - 最小權限:只用 spreadsheets scope。
 * - 寫入一律 RAW(避免影片ID/開頭 0 被當數字)。
 * - append 用 values.append;不刪列(參考池是 voc 永久池,prune 已退役)。
 * - 不自建/不覆寫表頭:參考池由 voc `init-sheet` 擁有;bot 不替 voc 動表結構。
 *
 * 表頭飄移防護(2026-06-26):欄位對映改「依實際表頭具名解析」,不再假設固定欄序
 * (A=平台 B=連結 C=挑 D=加入日期)。表頭被重排、前面多一欄(如 legacy `id`)、後面有空欄,
 * 都能把值寫到正確的具名欄、讀回也對得上,而不是因為「順序/長度不完全相等」就把整輪 drain
 * 打掛(舊版 fail-fast 條件)。唯一仍 fail-fast 的情形 = 某個必要欄「整個不存在」——
 * 那才是真的會錯欄毀 voc 池,寧可停下等人對齊(維持 CLAUDE.md 安全網本意)。
 */
import { google, type sheets_v4 } from "googleapis";
import { withRetry } from "@pei760730/collector-core";
import type { Storage, DuplicateHit, StatsSummary } from "./Storage.js";
import type { RefRow } from "../types.js";
import { POOL_COLUMNS } from "../types.js";
import { dedupKey } from "../pipeline/index.js";
import { computeStats } from "./computeStats.js";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

export interface GoogleSheetsOptions {
  credentials: { client_email: string; private_key: string };
  sheetId: string;
  sheetName: string;
}

/** 表頭解析結果:每個必要欄的 0-based 欄位索引 + 整列寬度。 */
export interface HeaderLayout {
  indexOf: Record<string, number>;
  width: number;
}

/** 0-based 欄索引 → A1 欄字母(0→A, 25→Z, 26→AA)。 */
export function colLetter(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * 依「實際表頭」解析每個必要欄的 0-based 索引(純函式,好測)。
 * 必要欄整個缺席 → 丟錯(不錯欄寫入、不默默毀池);順序/多餘空欄/前置欄都容忍。
 */
export function resolveHeaderIndexes(
  header: readonly unknown[],
  required: readonly string[],
  label: string,
): HeaderLayout {
  const cells = header.map((h) => String(h ?? "").trim());
  const indexOf: Record<string, number> = {};
  const missing: string[] = [];
  for (const col of required) {
    const idx = cells.indexOf(col);
    if (idx < 0) missing.push(col);
    else indexOf[col] = idx;
  }
  if (missing.length > 0) {
    throw new Error(
      `${label}表頭缺少必要欄 [${missing.join(",")}],拒絕寫入(避免錯欄毀資料)。` +
        `現有=[${cells.join(",")}] 需要=[${required.join(",")}]。請對齊 voc schema.REFS。`,
    );
  }
  return { indexOf, width: Math.max(cells.length, required.length) };
}

/** 把一列物件依解析索引排成整列寬度字串陣列(該欄外留空)。 */
export function placeRow(
  row: Record<string, unknown>,
  columns: readonly string[],
  layout: HeaderLayout,
): string[] {
  const cells: string[] = new Array<string>(layout.width).fill("");
  for (const col of columns) {
    const idx = layout.indexOf[col];
    if (idx === undefined) continue; // resolve 階段已保證存在;防禦性
    cells[idx] = String(row[col] ?? "");
  }
  return cells;
}

/** 反向:依解析索引,把實際列的 cell 取回具名欄物件。 */
export function readNamedRow(
  cells: readonly string[],
  columns: readonly string[],
  layout: HeaderLayout,
): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const col of columns) {
    const idx = layout.indexOf[col];
    obj[col] = idx === undefined ? "" : String(cells[idx] ?? "");
  }
  return obj;
}

// 429 / 5xx / 暫態網路錯誤的退避重試 + `alreadyDone` 冪等護欄,改由 collector-core 提供
// canonical `withRetry`(三個 collector 各自副本的嚴格聯集);Sheets glue(JWT/sheets_v4)留本 repo。

export class GoogleSheetsStorage implements Storage {
  private sheets: sheets_v4.Sheets;
  private readonly sheetId: string;
  private readonly sheetName: string;
  private layoutCache?: HeaderLayout;
  private dedupCache?: Map<string, RefRow>;

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

  /**
   * 讀「實際表頭」並解析具名欄索引(每實例快取一次)。
   * 缺必要欄 → resolveHeaderIndexes 丟錯;這也是 ensureHeader 的早期 fail-fast 來源。
   */
  private async layout(): Promise<HeaderLayout> {
    if (this.layoutCache) return this.layoutCache;
    await this.assertTab();
    const res = await withRetry("讀表頭", () =>
      this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: this.range("1:1"),
      }),
    );
    this.layoutCache = resolveHeaderIndexes(res.data.values?.[0] ?? [], POOL_COLUMNS, "參考池");
    return this.layoutCache;
  }

  async ensureHeader(): Promise<void> {
    // 不替 voc 改表頭:只「讀 + 解析 + 驗證必要欄齊全」。缺欄就丟錯等人對齊。
    await this.layout();
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
      if (!cells.some((c) => c.trim() !== "")) continue; // 跳空白列,但 i 仍照算
      out.push({ rowNumber: i + 2, cells }); // +2:表頭 + 1-based
    }
    return out;
  }

  async readAll(): Promise<RefRow[]> {
    const layout = await this.layout();
    return (await this.rawRows(layout)).map(
      (r) => readNamedRow(r.cells, POOL_COLUMNS, layout) as unknown as RefRow,
    );
  }

  async readRows(): Promise<DuplicateHit[]> {
    const layout = await this.layout();
    return (await this.rawRows(layout)).map((r) => ({
      row: readNamedRow(r.cells, POOL_COLUMNS, layout) as unknown as RefRow,
      rowNumber: r.rowNumber,
    }));
  }

  /**
   * 去重索引:第一次讀全表建 Map(一次 values.get),之後直接回快取(O(1)、無網路)。
   * append 成功後會把新 key 併入這份快取(見下方),故同輪稍後的重複連結也擋得到。
   */
  async dedupIndex(): Promise<Map<string, RefRow>> {
    if (this.dedupCache) return this.dedupCache;
    const index = new Map<string, RefRow>();
    for (const h of await this.readRows()) {
      index.set(dedupKey(h.row.連結), h.row);
    }
    this.dedupCache = index;
    return index;
  }

  async append(row: RefRow): Promise<void> {
    const layout = await this.layout();
    const key = dedupKey(row.連結);
    // 冪等護欄的「既有 key 集合」在單次 append 的重試窗內只讀一次後快取:
    // 連環 429 / 暫時性網路錯會逼出多次重試,舊版每次重試都做一次全表讀 → 故障時讀放大成 N 倍。
    // 護欄查詢「成功」就快取本次結果重用;查詢「本身失敗」不快取(throw 出去,由 withRetry 吞掉照常重試),
    // 維持「護欄掛了也不放棄寫入」的降級。參考池無時間窗、重試窗短,期間集合視為不變是安全的。
    let keySetCache: Promise<Set<string>> | undefined;
    const existingKeys = (): Promise<Set<string>> => {
      const pending = (keySetCache ??= this.readRows()
        .then((hits) => new Set(hits.map((h) => dedupKey(h.row.連結))))
        .catch((err) => {
          // 不快取失敗:清掉 pending,下次重試重新查(降級保留)。
          if (keySetCache === pending) keySetCache = undefined;
          throw err;
        }));
      return pending;
    };
    await withRetry(
      "append",
      () =>
        this.sheets.spreadsheets.values.append({
          spreadsheetId: this.sheetId,
          range: this.range(`A1:${colLetter(layout.width - 1)}`),
          valueInputOption: "RAW",
          insertDataOption: "INSERT_ROWS",
          requestBody: { values: [placeRow(row as unknown as Record<string, unknown>, POOL_COLUMNS, layout)] },
        }),
      {
        // 冪等護欄:呼叫端(collect)已先去重,故重試前若這連結 key 已在表上,
        // 必是上一次「寫成功但回應遺失」留下的,視為完成,避免重試雙寫。
        alreadyDone: async () => !!key && (await existingKeys()).has(key),
      },
    );
    // 寫入成功 → 併入去重快取,讓同輪稍後的重複連結不必重讀全表也擋得到。
    if (key) this.dedupCache?.set(key, row);
  }

  async stats(opts: { recentLimit: number; nowMs: number }): Promise<StatsSummary> {
    const rows = await this.readAll();
    return computeStats(rows, opts);
  }
}
