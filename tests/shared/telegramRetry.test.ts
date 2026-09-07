import { describe, expect, it, vi } from "vitest";
import {
  callTelegramWithRetry,
  shouldRetryTelegram,
  TELEGRAM_METHODS,
  type TelegramMethod,
} from "../../src/shared/telegramRetry.js";

function timeoutError(): Error & { code: string } {
  return Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
}

describe("callTelegramWithRetry: 錯誤 × 方法", () => {
  it("getUpdates 逾時會重試", async () => {
    const call = vi.fn().mockRejectedValueOnce(timeoutError()).mockResolvedValueOnce([]);

    await expect(
      callTelegramWithRetry("getUpdates", call, { sleep: async () => undefined }),
    ).resolves.toEqual([]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("sendMessage 逾時不重試，避免不確定是否送達時送出重複訊息", async () => {
    const error = timeoutError();
    const call = vi.fn().mockRejectedValue(error);

    await expect(
      callTelegramWithRetry("sendMessage", call, { sleep: async () => undefined }),
    ).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("sendMessage 收到 429 會依 retry_after 重試", async () => {
    const error = Object.assign(new Error("Too Many Requests"), {
      code: 429,
      parameters: { retry_after: 1 },
    });
    const call = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ ok: true });
    const sleep = vi.fn(async () => undefined);

    await expect(callTelegramWithRetry("sendMessage", call, { sleep })).resolves.toEqual({ ok: true });
    expect(call).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("getUpdates 的 5xx 會重試，4xx 會直接失敗", async () => {
    const sleep = vi.fn(async () => undefined);
    const serverError = Object.assign(new Error("server error"), { code: 502 });
    const read = vi.fn().mockRejectedValueOnce(serverError).mockResolvedValueOnce([]);
    await expect(callTelegramWithRetry("getUpdates", read, { sleep })).resolves.toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);

    const clientError = Object.assign(new Error("Unauthorized"), { code: 401 });
    const unauthorizedRead = vi.fn().mockRejectedValue(clientError);
    await expect(
      callTelegramWithRetry("getUpdates", unauthorizedRead, { sleep }),
    ).rejects.toBe(clientError);
    expect(unauthorizedRead).toHaveBeenCalledTimes(1);
  });
});

/**
 * 完整性釘子:每一支 TelegramMethod 的「5xx / 傳輸層錯誤能不能重試」都要被明講。
 *
 * 這張表的型別是 Record<TelegramMethod, boolean> —— 往 TELEGRAM_METHODS 加一支方法卻
 * 沒在這裡分類,**編譯期就會紅**,不會靜默沿用某個預設。這條規則本身就是為了修掉
 * 一個靜默漏分類:舊判斷式寫的是 `method !== "getUpdates"`,於是 getMe / deleteWebhook
 * 被排除在重試之外 —— 不是有人決定過,是句型剛好把它們掃到門外。
 */
const RETRYABLE_BEYOND_429: Record<TelegramMethod, boolean> = {
  getUpdates: true, // 純讀
  getMe: true, // 純讀
  deleteWebhook: true, // 冪等
  sendMessage: false, // 刻意:重試可能送出重複訊息
};

describe("shouldRetryTelegram: 每支方法都要被明確分類", () => {
  const serverError = Object.assign(new Error("Bad Gateway"), { code: 502 });
  const transportError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

  for (const method of TELEGRAM_METHODS) {
    const want = RETRYABLE_BEYOND_429[method];
    it(`${method}:5xx / 傳輸層 → ${want ? "重試" : "不重試"};429 一律重試`, () => {
      expect(shouldRetryTelegram(method, serverError)).toBe(want);
      expect(shouldRetryTelegram(method, transportError)).toBe(want);
      // 429 是全體共通的例外(Telegram 明確告訴你稍後再打),與冪等性無關。
      expect(shouldRetryTelegram(method, Object.assign(new Error("429"), { code: 429 }))).toBe(true);
    });
  }
});
