/**
 * 參考池打勾器 —— /pick 用。在 voc 的「參考池」分頁按 R#### 找列、把「挑」寫成已勾。
 *
 * 為什麼 bot 只「打勾」、不自己搬:
 * 「參考池 → 待拍」的搬移是 voc pick 的不變式重活(T 號跨待拍+完成取最大、ISO 日期、
 * 先 append 後 delete、欄名漂移會大聲炸)。bot 重做 = 脆弱的第二真相,voc 改 schema 會默默壞。
 * 所以 bot 只寫一格「挑=TRUE」,真正搬移交回 `voc pick`(單一真相、零 drift)。
 *
 * 與 voc 對接契約(改前讀 repo CLAUDE.md 第六層):
 * - 欄名:`id`(R 編碼)、`挑`(checkbox)。改名要兩 repo 一起(voc `schema.PICK_COL` / `REFS`)。
 * - voc `_is_checked` 認的值:TRUE / ✓ / V / Y / 1 / X / 是 —— 我們寫標準 "TRUE"。
 */
import { google, type sheets_v4 } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const ID_COL = "id";
const PICK_COL = "挑";
const CHECK_VALUE = "TRUE"; // voc _is_checked 認可的值

export interface PoolRef {
  /** 實體列號(1-based,含表頭那列)。 */
  rowNumber: number;
  id: string;
  checked: boolean;
}

export interface PoolStore {
  readPool(): Promise<PoolRef[]>;
  /** 把該列的「挑」欄寫成已勾。 */
  setPick(rowNumber: number): Promise<void>;
}

/** voc `_is_checked` 對齊:認得這些值就算已勾。 */
export function isChecked(v: string): boolean {
  return ["TRUE", "✓", "V", "Y", "1", "X", "是"].includes(String(v).trim().toUpperCase());
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

export interface PoolOptions {
  credentials: { client_email: string; private_key: string };
  sheetId: string;
  poolSheetName: string;
}

export class GoogleSheetsPool implements PoolStore {
  private sheets: sheets_v4.Sheets;
  private readonly sheetId: string;
  private readonly poolName: string;
  private pickIdx: number | null = null;

  constructor(opts: PoolOptions) {
    this.sheetId = opts.sheetId;
    this.poolName = opts.poolSheetName;
    const auth = new google.auth.JWT({
      email: opts.credentials.client_email,
      key: opts.credentials.private_key,
      scopes: SCOPES,
    });
    this.sheets = google.sheets({ version: "v4", auth });
  }

  private range(a1: string): string {
    return `'${this.poolName}'!${a1}`;
  }

  async readPool(): Promise<PoolRef[]> {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.sheetId,
      range: this.range("A1:ZZ"),
    });
    const values = res.data.values ?? [];
    if (values.length === 0) return [];
    const header = values[0]!.map((c) => String(c ?? "").trim());
    const idIdx = header.indexOf(ID_COL);
    const pickIdx = header.indexOf(PICK_COL);
    if (idIdx === -1 || pickIdx === -1) {
      throw new Error(
        `參考池缺欄位:需要「${ID_COL}」「${PICK_COL}」,現有表頭=[${header.join(",")}]`,
      );
    }
    this.pickIdx = pickIdx; // 給 setPick 用,免再讀一次表頭
    const refs: PoolRef[] = [];
    for (let i = 1; i < values.length; i++) {
      const cells = values[i]!.map((c) => String(c ?? ""));
      if (!cells.some((c) => c.trim() !== "")) continue; // 跳空白列(列號照算)
      refs.push({
        rowNumber: i + 1, // values[0]=第 1 列表頭,values[i]=第 i+1 列
        id: (cells[idIdx] ?? "").trim(),
        checked: isChecked(cells[pickIdx] ?? ""),
      });
    }
    return refs;
  }

  async setPick(rowNumber: number): Promise<void> {
    if (this.pickIdx == null) {
      // 沒先 readPool 就呼叫:補讀一次表頭定位「挑」欄。
      const res = await this.sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: this.range("A1:ZZ1"),
      });
      const header = (res.data.values?.[0] ?? []).map((c) => String(c ?? "").trim());
      const idx = header.indexOf(PICK_COL);
      if (idx === -1) throw new Error(`參考池缺「${PICK_COL}」欄`);
      this.pickIdx = idx;
    }
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.sheetId,
      range: this.range(`${colLetter(this.pickIdx)}${rowNumber}`),
      valueInputOption: "RAW",
      requestBody: { values: [[CHECK_VALUE]] },
    });
  }
}

/** 測試 / 乾跑用記憶體版。 */
export class MemoryPool implements PoolStore {
  constructor(private refs: PoolRef[] = []) {}

  async readPool(): Promise<PoolRef[]> {
    return this.refs.map((r) => ({ ...r }));
  }

  async setPick(rowNumber: number): Promise<void> {
    const r = this.refs.find((x) => x.rowNumber === rowNumber);
    if (r) r.checked = true;
  }
}
