/**
 * 共用型別改由 @pei760730/collector-core 提供(PR-5,re-export 保持 import 路徑不變)。
 * RefRow / POOL_COLUMNS 是 voc「參考池」schema —— collector 專屬寫入契約,留本地。
 */
export type {
  Platform,
  DetectionMethod,
  ParsedMessage,
  CleanedUrl,
  PlatformInfo,
  VideoIdInfo,
} from "@pei760730/collector-core";
export { PLATFORM_CODE } from "@pei760730/collector-core";

/**
 * 「參考池」一列 —— 鍵名/順序就是 Sheet 表頭,別改。
 * voc target = 4 欄(無夯度);tbvoc target = 5 欄(夯度一律最後,收錄留空、按鈕回填)。
 * 各 target 的欄位契約由 tests/contract.test.ts / contractTbvoc.test.ts 守。
 * 去重 key 由連結即時推導(pipeline groupKey),不存欄。
 */
export interface RefRow {
  平台: string;
  連結: string;
  挑: string;
  加入日期: string; // ISO YYYY-MM-DD (Asia/Taipei)
  /** tbvoc 專屬第 5 欄;voc 列不帶此鍵。分享者點 inline 按鈕後由 callback 寫入。 */
  夯度?: string;
}

/** voc「參考池」表頭順序(SSOT),與 voc schema.REFS.columns 對齊;tbvoc 版在 targets.ts。 */
export const POOL_COLUMNS: (keyof RefRow)[] = ["平台", "連結", "挑", "加入日期"];
