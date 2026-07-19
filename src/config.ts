/**
 * 讀環境變數 → 型別化 config。憑證/token 一律走 env,不進版控。
 * 缺必要變數會在啟動時丟錯(fail fast),不要讓 bot 帶半套設定跑起來。
 */
import {
  required,
  optional,
  enumEnv,
  loadGoogleCredentials,
  type GoogleServiceAccountCredentials,
} from "@pei760730/collector-core";
import {
  createConfigLoader,
  type StorageMode as SharedStorageMode,
} from "./shared/configSafety.js";
import type { TargetName } from "./targets.js";

// chatIdsEnv 對外 re-export:白名單嚴格解析是公開 repo 的防灌池閘門,
// tests/config.test.ts 釘住 core 行為不漂移(原與 clip-collector 的同組守則;#9 三併一後
// 該 repo 已併入本 repo 並 archive,同步義務已內化,單邊守住即可)。
export { chatIdsEnv } from "./shared/configSafety.js";

// required / optional / boolEnv / enumEnv / chatIdsEnv / loadGoogleCredentials 已上移至
// collector-core(v0.3.0);此處只保留 bot 專屬的 Config 型別與 loadConfig 組裝。

export type StorageMode = SharedStorageMode;

export interface Config {
  /** 寫入目標(#9 三併一:一殼多表)。env COLLECTOR_TARGET,預設 voc = 既有行為零變更。 */
  target: TargetName;
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

const loadConfigSingleton = createConfigLoader({
  sheetsDestination: "參考池",
  loadGoogleConfig: () => ({
    credentials: loadGoogleCredentials(),
    sheetId: required("GOOGLE_SHEET_ID"),
    poolSheetName: optional("POOL_SHEET_NAME", "參考池"),
  }),
  loadExtension: () => ({
    target: enumEnv("COLLECTOR_TARGET", ["voc", "tbvoc"] as const, "voc"),
  }),
});

export function loadConfig(): Config {
  return loadConfigSingleton();
}
