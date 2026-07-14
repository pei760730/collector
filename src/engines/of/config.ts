/**
 * 讀環境變數 → 型別化 config。憑證/token 一律走 env,不進版控。
 * 缺必要變數會在啟動時丟錯(fail fast),不要讓 bot 帶半套設定跑起來。
 */
import dotenv from "dotenv";
// env 讀取小工具(required/optional/boolEnv/enumEnv/chatIdsEnv)+ Google 憑證載入,
// 三個 collector 逐字相同,已抽進 collector-core(SSoT);本檔只留 feed 專屬的 Config 型別 + loadConfig 組裝。
// chatIdsEnv 需 re-export:tests/config.test.ts 直接 import 它(嚴格純整數 regex 由 core 保證)。
import {
  required,
  optional,
  boolEnv,
  enumEnv,
  chatIdsEnv,
  loadGoogleCredentials,
  type GoogleServiceAccountCredentials,
} from "@pei760730/collector-core";

import { logger } from "./utils/logger.js";

export { chatIdsEnv };

// override:true —— .env 蓋過系統既有環境變數,避免殘留舊/打錯的 token。
// quiet:true —— dotenv v17 預設會印 tip 行,靜音避免污染 drain.log / CI 輸出。
// core 的 env 工具是純函式(不自帶 dotenv 副作用),故仍由本檔在 import 時載入 .env。
dotenv.config({ override: true, quiet: true });

export type StorageMode = "sheets" | "memory";

export interface Config {
  telegramToken: string;
  storage: StorageMode;
  /** memory 乾跑模式下為 null(不需 Google 憑證)。 */
  google: {
    credentials: GoogleServiceAccountCredentials;
    sheetId: string;
    stagingSheetName: string;
    prodSheetName: string;
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
  const google =
    storage === "memory"
      ? null
      : {
          credentials: loadGoogleCredentials(),
          sheetId: required("GOOGLE_SHEET_ID"),
          stagingSheetName: optional("STAGING_SHEET_NAME", "暫存區"),
          prodSheetName: optional("PROD_SHEET_NAME", "總表"),
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
      "STORAGE=sheets 但未設 ALLOWED_CHAT_IDS:正式寫表必須限定來源 chat id(逗號分隔純數字),否則公開後任何人都能灌你的暫存區",
    );
  }
  // sheets 模式沒設 ERROR_CHAT_ID:gate 告警/notifyError 全程 no-op,寫入失敗只剩 Actions 紅燈
  // (drain aborted → exit 2)可見。不 fail-fast(告警管道是選配),但開機明講,別默默沒告警。
  if (storage === "sheets" && cached.errorChatId === "") {
    logger.warn("ERROR_CHAT_ID 未設,寫入失敗將無 Telegram 告警(只剩 collect.yml 紅燈/exit code)");
  }
  return cached;
}
