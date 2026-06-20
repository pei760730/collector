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
 *
 * 第一性原理瘦身(2026-06-20,14→8):暫存區只存「捕捉到的不可化約事實」,
 * 衍生/診斷欄一律砍,智慧留下游(參考池/待拍/完成 + voc learn)。已砍:
 * - ID(永遠 == VIDEO_ID)、AGE(衍生,今天−DATE 現算)、PLATFORM_ICON(衍生自 PLATFORM)
 * - ERROR_LOG(永遠空,錯誤走 error chat/log)、PLATFORM_CONFIDENCE / DETECTION_METHOD(診斷,下游不消費)
 * voc 按欄名讀 PLATFORM/VIDEO_REF/CLEAN_URL/DATE,皆保留 → 不受影響。
 */
export interface StagingRow {
  PLATFORM: string;
  VIDEO_REF: string;
  DATE: string; // YYYY/M/D (Asia/Taipei)
  NOTE: string;
  CLEAN_URL: string;
  VIDEO_ID: string; // 帶平台前綴的唯一 id,也是去重 key
  SENDER: string;
  STATUS: string; // active | moved | error
}

/** 「暫存區」表頭順序(SSOT)。googleSheets 與 doctor 都用這個。 */
export const STAGING_COLUMNS: (keyof StagingRow)[] = [
  "PLATFORM",
  "VIDEO_REF",
  "DATE",
  "NOTE",
  "CLEAN_URL",
  "VIDEO_ID",
  "SENDER",
  "STATUS",
];

export const STATUS = {
  ACTIVE: "active",
  MOVED: "moved",
  ERROR: "error",
} as const;
