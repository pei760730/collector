/**
 * 讀環境變數 → 型別化 config。憑證/token 一律走 env,不進版控。
 * 缺必要變數會在啟動時丟錯(fail fast),不要讓 bot 帶半套設定跑起來。
 */
import dotenv from "dotenv";
import { readFileSync } from "node:fs";

// override:true —— .env 蓋過系統既有環境變數。
// 原因:Windows 系統環境若殘留舊/打錯的 TELEGRAM_BOT_TOKEN,dotenv 預設不覆蓋會讓
// bot 拿到壞值(踩過 l→1 typo 的 401)。Docker 沒 .env 檔時此行 no-op,不影響真環境。
dotenv.config({ override: true });

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`缺少必要環境變數:${name}(請參考 .env.example)`);
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || v.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

export type BotMode = "polling" | "webhook";
export type StorageMode = "sheets" | "memory";

export interface Config {
  telegramToken: string;
  mode: BotMode;
  storage: StorageMode;
  webhook: { domain: string; path: string; port: number };
  /** memory 乾跑模式下為 null(不需 Google 憑證)。 */
  google: {
    /** 解析後的 service account 憑證物件。 */
    credentials: { client_email: string; private_key: string };
    sheetId: string;
    stagingSheetName: string;
  } | null;
  adminChatId: string;
  errorChatId: string;
  dedupePeriodDays: number;
  expandShortUrls: boolean;
  tz: string;
  logLevel: string;
}

/**
 * 取得 Google service account 憑證。優先序:
 * JSON 字串 > base64 > 檔案路徑。
 */
function loadGoogleCredentials(): { client_email: string; private_key: string } {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64?.trim();
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim();

  let jsonText: string | undefined;
  if (raw) {
    jsonText = raw;
  } else if (b64) {
    jsonText = Buffer.from(b64, "base64").toString("utf-8");
  } else if (file) {
    jsonText = readFileSync(file, "utf-8");
  } else {
    throw new Error(
      "缺少 Google 憑證:請設 GOOGLE_SERVICE_ACCOUNT_JSON / _BASE64 / _FILE 其一",
    );
  }

  let parsed: { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("GOOGLE service account JSON 解析失敗(格式不是合法 JSON)");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("service account JSON 缺 client_email / private_key");
  }
  return {
    client_email: parsed.client_email,
    // .env 內的 \n 換行還原
    private_key: parsed.private_key.replace(/\\n/g, "\n"),
  };
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const mode = optional("BOT_MODE", "polling") as BotMode;
  const storage = optional("STORAGE", "sheets") as StorageMode;
  // memory 乾跑模式不碰 Google 憑證,讓只有 token 也能啟動測 bot 回覆
  const google =
    storage === "memory"
      ? null
      : {
          credentials: loadGoogleCredentials(),
          sheetId: required("GOOGLE_SHEET_ID"),
          stagingSheetName: optional("STAGING_SHEET_NAME", "暫存區"),
        };
  cached = {
    telegramToken: required("TELEGRAM_BOT_TOKEN"),
    mode,
    storage,
    webhook: {
      domain: optional("WEBHOOK_DOMAIN", ""),
      path: optional("WEBHOOK_PATH", "/telegraf"),
      port: Number(optional("PORT", "8080")),
    },
    google,
    adminChatId: optional("ADMIN_CHAT_ID", ""),
    errorChatId: optional("ERROR_CHAT_ID", ""),
    dedupePeriodDays: Number(optional("DEDUPE_PERIOD_DAYS", "180")),
    expandShortUrls: boolEnv("EXPAND_SHORT_URLS", false),
    tz: optional("TZ", "Asia/Taipei"),
    logLevel: optional("LOG_LEVEL", "info"),
  };
  if (mode === "webhook" && !cached.webhook.domain) {
    throw new Error("BOT_MODE=webhook 但未設 WEBHOOK_DOMAIN");
  }
  return cached;
}
