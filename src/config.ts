/**
 * 讀環境變數 → 型別化 config。憑證/token 一律走 env,不進版控。
 * 缺必要變數會在啟動時丟錯(fail fast),不要讓 bot 帶半套設定跑起來。
 */
import dotenv from "dotenv";
import {
  required,
  optional,
  boolEnv,
  enumEnv,
  chatIdsEnv,
  loadGoogleCredentials,
  type GoogleServiceAccountCredentials,
} from "@pei760730/collector-core";

// override:true —— .env 蓋過系統既有環境變數。
// 原因:Windows 系統環境若殘留舊/打錯的 TELEGRAM_BOT_TOKEN,dotenv 預設不覆蓋會讓
// bot 拿到壞值(踩過 l→1 typo 的 401)。Docker 沒 .env 檔時此行 no-op,不影響真環境。
// quiet:true —— dotenv v17 預設會印 tip 行,靜音避免污染 CI 輸出。
dotenv.config({ override: true, quiet: true });

// required / optional / boolEnv / enumEnv / chatIdsEnv / loadGoogleCredentials 已上移至
// collector-core(v0.3.0);此處只保留 bot 專屬的 Config 型別與 loadConfig 組裝。

export type StorageMode = "sheets" | "memory";

export interface Config {
  telegramToken: string;
  storage: StorageMode;
  /** memory 乾跑模式下為 null(不需 Google 憑證)。 */
  google: {
    /** 解析後的 service account 憑證物件。 */
    credentials: GoogleServiceAccountCredentials;
    sheetId: string;
    /** voc 的「參考池」分頁名(同一張表):收錄寫入的目標分頁。 */
    poolSheetName: string;
  } | null;
  errorChatId: string;
  /** 來源白名單:只處理這些 chat/user id 的訊息(公開後防陌生人灌池)。空=不限制,僅限乾跑/開發。 */
  allowedChatIds: number[];
  expandShortUrls: boolean;
  logLevel: string;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const storage = enumEnv("STORAGE", ["sheets", "memory"] as const, "sheets");
  // memory 乾跑模式不碰 Google 憑證,讓只有 token 也能啟動測 bot 回覆
  const google =
    storage === "memory"
      ? null
      : {
          credentials: loadGoogleCredentials(),
          sheetId: required("GOOGLE_SHEET_ID"),
          poolSheetName: optional("POOL_SHEET_NAME", "參考池"),
        };
  cached = {
    telegramToken: required("TELEGRAM_BOT_TOKEN"),
    storage,
    google,
    errorChatId: optional("ERROR_CHAT_ID", ""),
    allowedChatIds: chatIdsEnv("ALLOWED_CHAT_IDS"),
    expandShortUrls: boolEnv("EXPAND_SHORT_URLS", false),
    logLevel: optional("LOG_LEVEL", "info"),
  };
  // 公開 repo 防灌池:sheets 模式(=正式寫真表)必須設來源白名單,否則任何人都能餵 bot 寫進你的表。
  // 寧可 fail-fast 紅燈被發現,也不要默默大開。memory 乾跑不寫真表,免設。
  if (storage === "sheets" && cached.allowedChatIds.length === 0) {
    throw new Error(
      "STORAGE=sheets 但未設 ALLOWED_CHAT_IDS:正式寫表必須限定來源 chat id(逗號分隔純數字),否則公開後任何人都能灌你的參考池",
    );
  }
  return cached;
}
