/**
 * chatIdsEnv 嚴格純整數字面解析(round-2 修正)。
 *
 * ALLOWED_CHAT_IDS 是公開 repo 的防灌池 gate:白名單打錯不能默默變成「錯的但合法」數字。
 * 舊版用 Number.isInteger(Number(t)),而 Number("1e5")/"0x10"/"12.0"/" 0b1 " 都會過
 * (→ 100000 / 16 / 12 / 1),讓 typo 的 id 靜默失準、gate 開錯口。改用 /^-?\d+$/ 只收
 * 純十進位整數字面。本檔釘住:科學記號/十六/二進位/小數一律 fail-fast,純整數照收。
 *
 * 直接測 chatIdsEnv(不經 loadConfig):避開 dotenv override 與 loadConfig 快取干擾,
 * 用專屬 env key 現設現讀。
 */
import { describe, it, expect, afterEach, vi } from "vitest";

import { chatIdsEnv } from "../../src/engines/of/config.js";

const KEY = "TEST_ALLOWED_CHAT_IDS";

function parse(v: string): number[] {
  process.env[KEY] = v;
  return chatIdsEnv(KEY);
}

afterEach(() => {
  delete process.env[KEY];
});

describe("chatIdsEnv — 只收純十進位整數字面", () => {
  it("純整數(含負號 / 多項 / 前後空白)照收", () => {
    expect(parse("123")).toEqual([123]);
    expect(parse("-100")).toEqual([-100]);
    expect(parse(" 123 , -100 , 456 ")).toEqual([123, -100, 456]);
  });

  it("空字串 → 空陣列(是否強制由 loadConfig 決定)", () => {
    expect(parse("")).toEqual([]);
    expect(parse("   ")).toEqual([]);
  });

  it("拒絕科學記號 '1e5'(Number 會靜默變 100000)", () => {
    expect(() => parse("1e5")).toThrow(/非整數 chat id/);
  });

  it("拒絕十六進位 '0x10'(Number 會靜默變 16)", () => {
    expect(() => parse("0x10")).toThrow(/非整數 chat id/);
  });

  it("拒絕小數 '12.0'(Number.isInteger 會誤放行)", () => {
    expect(() => parse("12.0")).toThrow(/非整數 chat id/);
  });

  it("拒絕二進位字面 '0b1'", () => {
    expect(() => parse("0b1")).toThrow(/非整數 chat id/);
  });

  it("一項壞的就整批 fail-fast(不默默丟掉壞項)", () => {
    expect(() => parse("123, 1e5, 456")).toThrow(/非整數 chat id/);
  });
});

// ── ERROR_CHAT_ID 開機告警(與殼版 tests/config.test.ts 同款,of 引擎自己的 loadConfig)──
// loadConfig 有模組級快取 + import 時跑 dotenv({override:true}) → vi.resetModules()
// 取全新實例、env 在 import 之後設。logger 是 core 單例(re-export),spyOn warn 即可。
const CONFIG_ENV_KEYS = [
  "STORAGE",
  "TELEGRAM_BOT_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64",
  "GOOGLE_SERVICE_ACCOUNT_FILE",
  "GOOGLE_SHEET_ID",
  "ALLOWED_CHAT_IDS",
  "ERROR_CHAT_ID",
] as const;

async function loadFreshSheetsConfig(errorChatId?: string) {
  vi.resetModules();
  const { loadConfig } = await import("../../src/engines/of/config.js");
  const { logger } = await import("../../src/engines/of/utils/logger.js");
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
  process.env.ALLOWED_CHAT_IDS = "123456"; // 假 id,真實管理員 chat id 不進 public repo
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
