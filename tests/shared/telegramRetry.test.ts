import { describe, expect, it, vi } from "vitest";
import { callTelegramWithRetry } from "../../src/shared/telegramRetry.js";

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
