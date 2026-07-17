/**
 * chat id 白名單嚴格解析:白名單是公開 repo 的防灌池閘門,打錯一項就該紅燈,
 * 不能靠 Number() 把 "1e5"/"0x10"/"12.0" 這種寫法默默吞成「看起來合法」的錯 id
 * (白名單靜默失準,以為有保護其實開了)。用 /^-?\d+$/ 只認純十進位整數。
 * 嚴格 regex 原產於本 repo round-1 #58,後上移 collector-core(chatIdsEnv);
 * 本測釘住 core 行為不漂移(原與 clip-collector 同組守則;該 repo 已併入本 repo 並 archive,單邊守住即可)。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { chatIdsEnv } from "../src/config.js";

const KEY = "TEST_CHAT_IDS_STRICT";

afterEach(() => {
  delete process.env[KEY];
});

function parse(raw: string): number[] {
  process.env[KEY] = raw;
  return chatIdsEnv(KEY);
}

describe("chatIdsEnv:嚴格純整數解析", () => {
  it("純十進位整數(含負號)通過", () => {
    expect(parse("123")).toEqual([123]);
    expect(parse("-100")).toEqual([-100]);
    expect(parse("123,-100, 456 ")).toEqual([123, -100, 456]);
  });

  it("未設 / 空字串 → 空陣列", () => {
    delete process.env[KEY];
    expect(chatIdsEnv(KEY)).toEqual([]);
    expect(parse("")).toEqual([]);
    expect(parse("   ")).toEqual([]);
  });

  // Number() 會把這些吞成合法整數 → 必須被 regex 擋下,否則白名單靜默失準
  it.each(["1e5", "0x10", "12.0", "0b1", "0o17", "1_000", "12abc", "abc", "+5", "１２３"])(
    "非純整數字面 '%s' → 丟錯",
    (bad) => {
      expect(() => parse(bad)).toThrow(/非整數 chat id/);
    },
  );

  it("有效項中夾一個壞項也整組丟錯(fail-fast)", () => {
    expect(() => parse("123,1e5,456")).toThrow(/非整數 chat id/);
  });
});

// ── ERROR_CHAT_ID 開機告警(選配管道,但沒設不能默默沒告警)──────────────────
// loadConfig 有模組級快取,且 config.ts import 時就跑 dotenv({override:true}),
// 所以走 vi.resetModules() + 動態 import 取全新實例;env 一律在 import 之後設
// (repo 無 .env,但照防呆順序寫,免得本機殘留 .env 蓋掉測試值)。
// logger 是 core 的單例物件(re-export),spyOn 其 warn 即可攔到 loadConfig 的告警。
const CONFIG_ENV_KEYS = [
  "STORAGE",
  "TELEGRAM_BOT_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64",
  "GOOGLE_SERVICE_ACCOUNT_FILE",
  "GOOGLE_SHEET_ID",
  "ALLOWED_CHAT_IDS",
  "ERROR_CHAT_ID",
  "COLLECTOR_TARGET",
] as const;

async function loadFreshSheetsConfig(errorChatId?: string) {
  vi.resetModules();
  const { loadConfig } = await import("../src/config.js");
  const { logger } = await import("../src/utils/logger.js");
  process.env.STORAGE = "sheets";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  // 假憑證:loadGoogleCredentials 只驗 client_email/private_key 存在,不打網路
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: "test@test.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
  });
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  process.env.GOOGLE_SHEET_ID = "test-sheet-id";
  process.env.ALLOWED_CHAT_IDS = "123456"; // 假 id,真實管理員 chat id 不進 public repo(#64)
  if (errorChatId === undefined) delete process.env.ERROR_CHAT_ID;
  else process.env.ERROR_CHAT_ID = errorChatId;
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  loadConfig();
  return warn;
}

describe("loadConfig — ERROR_CHAT_ID 開機告警", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of CONFIG_ENV_KEYS) delete process.env[k];
  });

  it("sheets 模式未設 ERROR_CHAT_ID → logger.warn 明講(寫入失敗將無 Telegram 告警)", async () => {
    const warn = await loadFreshSheetsConfig(undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ERROR_CHAT_ID 未設"));
  });

  it("sheets 模式已設 ERROR_CHAT_ID → 不 warn", async () => {
    const warn = await loadFreshSheetsConfig("123456"); // 假 id
    expect(warn).not.toHaveBeenCalled();
  });
});
