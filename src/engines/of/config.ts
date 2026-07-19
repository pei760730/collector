/**
 * 讀環境變數 → 型別化 config。憑證/token 一律走 env,不進版控。
 * 缺必要變數會在啟動時丟錯(fail fast),不要讓 bot 帶半套設定跑起來。
 */
// env 讀取小工具(required/optional/boolEnv/enumEnv/chatIdsEnv)+ Google 憑證載入,
// 三個 collector 逐字相同,已抽進 collector-core(SSoT);本檔只留 feed 專屬的 Config 型別 + loadConfig 組裝。
// chatIdsEnv 需 re-export:tests/config.test.ts 直接 import 它(嚴格純整數 regex 由 core 保證)。
import {
  required,
  optional,
  loadGoogleCredentials,
  type GoogleServiceAccountCredentials,
} from "@pei760730/collector-core";
import {
  createConfigLoader,
  type StorageMode as SharedStorageMode,
} from "../../shared/configSafety.js";

export { chatIdsEnv } from "../../shared/configSafety.js";

export type StorageMode = SharedStorageMode;

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

const loadConfigSingleton = createConfigLoader({
  sheetsDestination: "暫存區",
  loadGoogleConfig: () => ({
    credentials: loadGoogleCredentials(),
    sheetId: required("GOOGLE_SHEET_ID"),
    stagingSheetName: optional("STAGING_SHEET_NAME", "暫存區"),
    prodSheetName: optional("PROD_SHEET_NAME", "總表"),
  }),
});

export function loadConfig(): Config {
  return loadConfigSingleton();
}
