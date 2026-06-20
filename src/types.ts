/**
 * 共用型別 + Google Sheet「暫存區」schema(SSOT)。
 * 改欄位只改這裡,storage / messages / handlers 都引用這份。
 */

/** 支援的平台代碼(寫進 PLATFORM 欄的顯示名)。 */
export type Platform =
  | "TikTok"
  | "YouTube"
  | "Facebook"
  | "Instagram"
  | "Threads"
  | "X"
  | "抖音"
  | "小紅書";

export type Confidence = "high" | "medium" | "low";
export type DetectionMethod = "domain_match" | "fallback" | "error";

/** Parse 階段輸出。 */
export interface ParsedMessage {
  /** 原始(未清理)網址,寫進 VIDEO_REF。 */
  rawUrl: string;
  /** 訊息文字移除網址後的備註。 */
  note: string;
  /** 提交者(Telegram from.first_name),寫進 SENDER。 */
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
 * 「暫存區」一列資料 —— 欄位順序即 Sheet 表頭順序,不要改順序。
 * 對應規格第五節 14 欄。
 */
export interface StagingRow {
  ID: string;
  PLATFORM: string;
  VIDEO_REF: string;
  DATE: string; // YYYY/M/D (Asia/Taipei)
  AGE: string; // 距 DATE 的天數,寫入時為 "0"
  NOTE: string;
  CLEAN_URL: string;
  VIDEO_ID: string;
  SENDER: string;
  STATUS: string; // active | moved | error
  ERROR_LOG: string;
  PLATFORM_ICON: string;
  PLATFORM_CONFIDENCE: Confidence | "";
  DETECTION_METHOD: DetectionMethod | "";
}

/** 「暫存區」表頭順序(SSOT)。googleSheets 與 doctor 都用這個。 */
export const STAGING_COLUMNS: (keyof StagingRow)[] = [
  "ID",
  "PLATFORM",
  "VIDEO_REF",
  "DATE",
  "AGE",
  "NOTE",
  "CLEAN_URL",
  "VIDEO_ID",
  "SENDER",
  "STATUS",
  "ERROR_LOG",
  "PLATFORM_ICON",
  "PLATFORM_CONFIDENCE",
  "DETECTION_METHOD",
];

export const STATUS = {
  ACTIVE: "active",
  MOVED: "moved",
  ERROR: "error",
} as const;
