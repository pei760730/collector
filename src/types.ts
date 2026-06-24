/**
 * 共用型別 + Google Sheet「參考池」schema(SSOT)。
 * 改欄位只改這裡,storage / messages / handlers 都引用這份。
 *
 * 2026-06-22:bot 改成「直接寫 voc 的『參考池』分頁」(廢「暫存區」中間層)。
 * voc 端已砍掉 sync-pool(暫存區→參考池 每日複製),bot 與 voc 用同一張表、同一個 SA,
 * 所以 bot 直寫參考池就是最終狀態,不再有複製儀式。參考池 4 欄欄名/順序必須與
 * voc `schema.REFS` 完全對上(契約由 tests/contract.test.ts 守;2026-06-24 砍 id)。
 */

/** 支援的平台代碼(內部判定用的顯示名;寫進 Sheet 的是 PLATFORM_CODE 的小寫碼)。 */
export type Platform =
  | "TikTok"
  | "YouTube"
  | "Facebook"
  | "Instagram"
  | "Threads"
  | "X"
  | "抖音"
  | "小紅書"
  /** 認不得的網域(fallback / 解析失敗)。不再誤猜 Instagram。 */
  | "Unknown";

export type Confidence = "high" | "medium" | "low";
export type DetectionMethod = "domain_match" | "fallback" | "error";

/**
 * 平台顯示名 → voc 參考池統一用的小寫代碼。
 * voc(及全系統下游)用小寫碼篩選/統計;bot 是參考池的唯一寫入者,寫入前一律轉碼。
 * 8 個正式平台對到 voc 認得的碼;Unknown 落 "unknown"(8 碼之外的唯一例外)。
 */
export const PLATFORM_CODE: Record<Platform, string> = {
  TikTok: "tiktok",
  YouTube: "youtube",
  Facebook: "facebook",
  Instagram: "instagram",
  Threads: "threads",
  X: "x",
  抖音: "douyin",
  小紅書: "xiaohongshu",
  Unknown: "unknown",
};

/** Parse 階段輸出。 */
export interface ParsedMessage {
  /** 原始(未清理)網址,給 cleanUrl 當輸入。 */
  rawUrl: string;
  /** 訊息文字移除網址後的備註(供回覆顯示;參考池無備註欄,梗在搬進待拍後填「待拍.備註」)。 */
  note: string;
  /** 提交者(Telegram from.first_name);參考池不存,保留供未來多人辨識用。 */
  sender: string;
}

/** Clean URL 階段輸出。 */
export interface CleanedUrl {
  cleanUrl: string;
  /** 是否為已知短網址服務(bit.ly 等)。 */
  isShortUrl: boolean;
}

/** Detect Platform 階段輸出。 */
export interface PlatformInfo {
  platform: Platform;
  icon: string;
  confidence: Confidence;
  method: DetectionMethod;
}

/** Extract Video ID 階段輸出。 */
export interface VideoIdInfo {
  /** 帶平台前綴的唯一 ID,如 tiktok_7234...;抓不到為 unknown_<ts>。 */
  videoId: string;
  /** 抓不到 ID(平台不支援或格式異常)。 */
  unsupported: boolean;
}

/**
 * 「參考池」一列資料 —— 欄位即 voc `schema.REFS`,鍵名/順序就是 Sheet 表頭,不要改。
 *
 * voc 參考池 4 欄(2026-06-24 契約;砍掉 id):
 * - 平台      :小寫碼(PLATFORM_CODE)。
 * - 連結      :乾淨連結 —— 「打開」+ 去重的唯一 key(= 參考池的身份)。
 * - 挑        :checkbox,留空(=還沒挑);勾它 → GAS 即時搬待拍。
 * - 加入日期  :ISO YYYY-MM-DD(新鮮度;voc `normalize_date` 也吃 ISO)。
 *
 * id 欄已砍(2026-06-24):池內 id 是純流水號、非去重 key(連結才是)、挑走搬待拍另發 T 號不沿用 → 廢標籤。
 * NOTE / VIDEO_ID / SENDER 等原始細節參考池不存(voc 設計如此):梗在搬進待拍後填「待拍.備註」,
 * 去重 key 寫入前由連結即時推導(見 pipeline `dedupKey`),不需存欄。
 */
export interface RefRow {
  平台: string;
  連結: string;
  挑: string;
  加入日期: string; // ISO YYYY-MM-DD (Asia/Taipei)
}

/** 「參考池」表頭順序(SSOT),與 voc schema.REFS.columns 對齊。 */
export const POOL_COLUMNS: (keyof RefRow)[] = ["平台", "連結", "挑", "加入日期"];
