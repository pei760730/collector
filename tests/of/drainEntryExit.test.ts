/**
 * of / ofgay 的 drain 進入點(entry,import 即跑、自行 process.exit):
 * 「訊息被確認收走但沒寫進暫存區」必須走到 exit 3,不能因 entry 少傳 tally 而退回 0。
 * 只替換 Telegram.prototype.callApi 與 Sheets storage;全為合成資料。
 */
import { logger } from "@pei760730/collector-core";
import { Telegram } from "telegraf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ default: { config: vi.fn() } }));
vi.mock("../../src/engines/of/storage/googleSheets.js", async () => {
  const { MemoryStorage } = await import("../../src/engines/of/storage/memory.js");
  return {
    GoogleSheetsStorage: class extends MemoryStorage {
      constructor(_opts: unknown) {
        super(); // 真 storage 吃 options 物件;這裡不需要,別讓它被當成 seed
      }
      override async videoIdIndex(): Promise<never> {
        throw Object.assign(new Error("Unable to parse range (synthetic non-transient 400)"), { code: 400 });
      }
    },
  };
});

// src/drain.ts 會 import shell 的 Sheets storage(拖進整包 googleapis,很慢);of 路徑不會用到,換成空殼。
vi.mock("../../src/storage/googleSheets.js", () => ({ GoogleSheetsStorage: class {} }));

const link = (n: number) => `https://www.tiktok.com/@synthetic_user/video/70000000000000000${n}`;
let batches: unknown[][] = [];

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "TEST:TOKEN");
  vi.stubEnv("ALLOWED_CHAT_IDS", "123");
  vi.stubEnv("ERROR_CHAT_ID", "456");
  vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", JSON.stringify({
    client_email: "test@example.invalid",
    private_key: "fake-private-key",
  }));
  vi.stubEnv("GOOGLE_SHEET_ID", "test-sheet");
  vi.stubEnv("STORAGE", "sheets");
  vi.stubEnv("EXPAND_SHORT_URLS", "false");
  batches = [
    [1, 2, 3].map((id) => ({
      update_id: id,
      message: {
        message_id: id,
        date: 0,
        chat: { id: 123, type: "private", first_name: "Synthetic" },
        from: { id: 123, is_bot: false, first_name: "Synthetic" },
        text: link(id),
      },
    })),
  ];
  vi.spyOn(Telegram.prototype, "callApi").mockImplementation(async (method) => {
    switch (method) {
      case "getMe":
        return { id: 1, is_bot: true, first_name: "test", username: "testbot" } as never;
      case "deleteWebhook":
        return true as never;
      case "getUpdates":
        return (batches.shift() ?? []) as never;
      default:
        return {} as never; // sendMessage(回覆 / error chat 通知)
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.each([
  { target: "of", importDrain: () => import("../../src/engines/of/drain.js") },
  { target: "ofgay", importDrain: () => import("../../src/drain.js") }, // 經 isOfTarget 委派到同一支 entry
])("$target drain 進入點", ({ target, importDrain }) => {
  it("3 則被確認收走卻沒寫入 → process.exit(3),且摘要列出失敗未寫入", async () => {
    vi.stubEnv("COLLECTOR_TARGET", target);
    const lines: string[] = [];
    for (const level of ["info", "warn", "error"] as const) {
      vi.spyOn(logger, level).mockImplementation((m: string) => {
        lines.push(m);
      });
    }
    const exitCode = new Promise<number | string | null | undefined>((resolve) => {
      vi.spyOn(process, "exit").mockImplementation((code) => {
        resolve(code);
        return undefined as never;
      });
    });
    await importDrain();
    expect(await exitCode).toBe(3);
    const summary = lines.filter((l) => l.includes("已處理"));
    expect(summary).toHaveLength(1);
    expect(summary[0]).toContain("已處理 3 筆");
    expect(summary[0]).toContain("失敗未寫入 3");
  }, 30_000);
});
