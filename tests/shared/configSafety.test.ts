/**
 * shell/of 共用 config 水電的雙 target 反向驗證。
 *
 * 兩份舊測試中近逐字的 ERROR_CHAT_ID 段落集中到本檔；table 中每個 case 仍各跑
 * shell 與 of，並補齊 ALLOWED_CHAT_IDS fail-fast、memory 反條件與 singleton 證據。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const CONFIG_ENV_KEYS = [
  "STORAGE",
  "TELEGRAM_BOT_TOKEN",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SERVICE_ACCOUNT_JSON_BASE64",
  "GOOGLE_SERVICE_ACCOUNT_FILE",
  "GOOGLE_SHEET_ID",
  "POOL_SHEET_NAME",
  "STAGING_SHEET_NAME",
  "PROD_SHEET_NAME",
  "ALLOWED_CHAT_IDS",
  "ERROR_CHAT_ID",
  "COLLECTOR_TARGET",
  "EXPAND_SHORT_URLS",
  "LOG_LEVEL",
] as const;

const WARN_MESSAGE =
  "ERROR_CHAT_ID 未設,寫入失敗將無 Telegram 告警(只剩 collect.yml 紅燈/exit code)";

const TARGETS = [
  {
    name: "shell(voc/tbvoc)",
    sheetsDestination: "參考池",
    importConfig: () => import("../../src/config.js"),
    importLogger: () => import("../../src/utils/logger.js"),
    googleDefaults: { poolSheetName: "參考池" },
    absentGoogleField: "stagingSheetName",
    expectedTarget: "voc",
  },
  {
    name: "of",
    sheetsDestination: "暫存區",
    importConfig: () => import("../../src/engines/of/config.js"),
    importLogger: () => import("../../src/engines/of/utils/logger.js"),
    googleDefaults: { stagingSheetName: "暫存區", prodSheetName: "總表" },
    absentGoogleField: "poolSheetName",
    expectedTarget: undefined,
  },
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  for (const key of CONFIG_ENV_KEYS) delete process.env[key];
});

function setBaseEnv(storage: string): void {
  process.env.STORAGE = storage;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
}

function setSheetsEnv(): void {
  setBaseEnv("sheets");
  // 假憑證：loadGoogleCredentials 只驗必要欄位，不打網路。
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: "test@test.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----",
  });
  process.env.GOOGLE_SHEET_ID = "test-sheet-id";
}

describe.each(TARGETS)("$name loadConfig", (target) => {
  async function freshLoader() {
    vi.resetModules();
    const [{ loadConfig }, { logger }] = await Promise.all([
      target.importConfig(),
      target.importLogger(),
    ]);
    return { loadConfig, logger };
  }

  it("sheets + 空 ALLOWED_CHAT_IDS → 以原 target 文案 fail-fast", async () => {
    const { loadConfig } = await freshLoader();
    setSheetsEnv();
    delete process.env.ALLOWED_CHAT_IDS;

    let caught: unknown;
    try {
      loadConfig();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      `STORAGE=sheets 但未設 ALLOWED_CHAT_IDS:正式寫表必須限定來源 chat id(逗號分隔純數字),否則公開後任何人都能灌你的${target.sheetsDestination}`,
    );
  });

  it("sheets + 白名單 + 未設 ERROR_CHAT_ID → 原訊息 logger.warn", async () => {
    const { loadConfig, logger } = await freshLoader();
    setSheetsEnv();
    process.env.ALLOWED_CHAT_IDS = "123456";
    delete process.env.ERROR_CHAT_ID;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const config = loadConfig();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(WARN_MESSAGE);
    expect(config.google).toMatchObject(target.googleDefaults);
    expect(target.absentGoogleField in (config.google as object)).toBe(false);
    const record = config as unknown as Record<string, unknown>;
    if (target.expectedTarget === undefined) expect("target" in record).toBe(false);
    else expect(record.target).toBe(target.expectedTarget);
  });

  it("sheets + 白名單 + 已設 ERROR_CHAT_ID → 不 warn", async () => {
    const { loadConfig, logger } = await freshLoader();
    setSheetsEnv();
    process.env.ALLOWED_CHAT_IDS = "123456";
    process.env.ERROR_CHAT_ID = "654321";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    expect(() => loadConfig()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it("memory + 空白名單/ERROR_CHAT_ID → 不丟錯、不 warn、不載 Google", async () => {
    const { loadConfig, logger } = await freshLoader();
    setBaseEnv("memory");
    delete process.env.ALLOWED_CHAT_IDS;
    delete process.env.ERROR_CHAT_ID;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const config = loadConfig();

    expect(config.storage).toBe("memory");
    expect(config.google).toBeNull();
    expect(config.allowedChatIds).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("模組 loader 回傳同一 cached Config 實例", async () => {
    const { loadConfig } = await freshLoader();
    setBaseEnv("memory");

    const first = loadConfig();
    process.env.TELEGRAM_BOT_TOKEN = "changed-after-first-load";

    expect(loadConfig()).toBe(first);
    expect(first.telegramToken).toBe("test-token");
  });

  it("非法 STORAGE 值維持 enumEnv fail-fast", async () => {
    const { loadConfig } = await freshLoader();
    setBaseEnv("database");

    expect(() => loadConfig()).toThrow(/STORAGE/);
  });
});
