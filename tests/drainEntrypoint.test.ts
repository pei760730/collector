import { logger } from "@pei760730/collector-core";
import { Telegram } from "telegraf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

// 不讀開發者的 .env，也不讓任何 Telegram / Sheets 操作真的發出。
vi.mock("dotenv", () => ({ default: { config: vi.fn() } }));
vi.mock("../src/storage/googleSheets.js", () => ({
  GoogleSheetsStorage: class {
    constructor({ owner }: { owner: { initCmd: string } }) {
      calls.push(`Sheets:${owner.initCmd}`);
    }
    async ensureHeader() {
      calls.push("ensureHeader");
    }
  },
}));
vi.mock("../src/engines/of/storage/googleSheets.js", () => ({
  GoogleSheetsStorage: class {
    constructor() {
      calls.push("Sheets:of engine");
    }
    async ensureHeader() {
      calls.push("ensureHeader");
    }
  },
}));

beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "TEST:TOKEN");
  vi.stubEnv("ALLOWED_CHAT_IDS", "123");
  vi.stubEnv("ERROR_CHAT_ID", "456");
  vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", JSON.stringify({
    client_email: "test@example.invalid",
    private_key: "fake-private-key",
  }));
  vi.stubEnv("GOOGLE_SHEET_ID", "test-sheet");
  vi.stubEnv("EXPAND_SHORT_URLS", "false");

  vi.spyOn(Telegram.prototype, "callApi").mockImplementation(async (method) => {
    calls.push(method);
    switch (method) {
      case "getMe":
        return { id: 1, is_bot: true, first_name: "test", username: "testbot" } as never;
      case "deleteWebhook":
        return true as never;
      case "getUpdates":
        return [] as never;
      default:
        throw new Error(`Unexpected Telegram method: ${method}`);
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const importCollectorDrain = () => import("../src/drain.js");
const importOfDrain = () => import("../src/engines/of/drain.js");

async function runEntrypoint(importDrain: () => Promise<unknown> = importCollectorDrain) {
  // 進入點 import 後非同步呼叫 process.exit，等它回報退出碼再驗結果。
  const exitCode = new Promise<number | string | null | undefined>((resolve) => {
    vi.spyOn(process, "exit").mockImplementation((code) => {
      resolve(code);
      return undefined as never;
    });
  });
  await importDrain();
  return exitCode;
}

async function expectMemoryRejected(
  target: string,
  importDrain: () => Promise<unknown> = importCollectorDrain,
) {
  vi.stubEnv("STORAGE", "memory");
  vi.stubEnv("COLLECTOR_TARGET", target);
  const fatal = vi.spyOn(logger, "error").mockImplementation(() => {});

  const exitCode = await runEntrypoint(importDrain);

  expect(calls).toEqual([]);
  expect(exitCode).toBe(1);
  expect(fatal).toHaveBeenCalledWith(expect.stringMatching(
    /STORAGE=memory.*drain.*STORAGE=sheets.*npm test/,
  ));
}

describe.each([
  { target: "voc", storage: "voc" },
  { target: "tbvoc", storage: "tbvoc" },
  { target: "of", storage: "of engine" },
  { target: "ofgay", storage: "of engine" },
])("$target drain CLI", ({ target, storage }) => {
  it("拒絕 memory，包含 getMe / deleteWebhook 在內不發出任何 API 呼叫", async () => {
    await expectMemoryRejected(target);
  });

  it("sheets 維持原本的 storage / Telegram 初始化順序", async () => {
    vi.stubEnv("STORAGE", "sheets");
    vi.stubEnv("COLLECTOR_TARGET", target);

    expect(await runEntrypoint()).toBe(0);
    expect(calls).toEqual([
      `Sheets:${storage}`, "ensureHeader", "getMe", "deleteWebhook", "getUpdates",
    ]);
  });
});

it("直接執行 of 引擎進入點也不能繞過 memory 閘", async () => {
  await expectMemoryRejected("of", importOfDrain);
});
