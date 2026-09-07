import { logger } from "@pei760730/collector-core";

const DEFAULT_TRIES = 4;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 60_000;

/**
 * 會走本模組重試的 Telegram 方法。**型別由這個陣列推導**,不是各寫一份 —— 加方法時
 * 下面的 IDEMPOTENT_METHODS 與測試的分類表都會因為 Record 的完整性檢查而編譯期報錯,
 * 逼你明講「這支能不能安全重試」,不會靜默漏分類。
 */
export const TELEGRAM_METHODS = ["getUpdates", "getMe", "deleteWebhook", "sendMessage"] as const;
export type TelegramMethod = (typeof TELEGRAM_METHODS)[number];

/**
 * 除了 429 之外,還能對 5xx / 傳輸層錯誤重試的方法 = 純讀或冪等的那些。
 *
 * sendMessage 刻意不在內:重試時無法確定上一次是否已送達,會送出重複訊息
 * (tests/shared/telegramRetry.test.ts 有釘住這個刻意行為)。
 * getMe 是純讀、deleteWebhook 是冪等,都不適用那個理由 —— 它們原本被排除只是因為
 * 判斷式寫成 `method !== "getUpdates"`,不是有人決定過。
 */
const IDEMPOTENT_METHODS = new Set<TelegramMethod>(["getUpdates", "getMe", "deleteWebhook"]);

interface RetryOptions {
  tries?: number;
  sleep?: (ms: number) => Promise<void>;
}

function statusCode(error: unknown): number | undefined {
  const candidate = error as {
    code?: unknown;
    response?: { error_code?: unknown; status?: unknown };
  };
  if (typeof candidate?.code === "number") return candidate.code;
  if (typeof candidate?.response?.error_code === "number") return candidate.response.error_code;
  return typeof candidate?.response?.status === "number"
    ? candidate.response.status
    : undefined;
}

function isTransportError(error: unknown): boolean {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
  if (candidate?.name === "AbortError") return false;
  const text = `${String(candidate?.name ?? "")} ${String(candidate?.code ?? "")} ${String(
    candidate?.message ?? "",
  )}`;
  if (
    /FetchError|TimeoutError|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|EPIPE|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network|fetch failed|premature close/i.test(
      text,
    )
  ) {
    return true;
  }
  return candidate?.cause !== undefined && isTransportError(candidate.cause);
}

export function shouldRetryTelegram(method: TelegramMethod, error: unknown): boolean {
  const status = statusCode(error);
  if (status === 429) return true;
  if (!IDEMPOTENT_METHODS.has(method)) return false;
  return (status !== undefined && status >= 500 && status < 600) || isTransportError(error);
}

function retryDelayMs(error: unknown, attempt: number): number {
  const candidate = error as { parameters?: { retry_after?: unknown } };
  const retryAfter = candidate?.parameters?.retry_after;
  if (statusCode(error) === 429 && typeof retryAfter === "number" && retryAfter >= 0) {
    return Math.min(MAX_DELAY_MS, retryAfter * 1_000);
  }
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
}

export async function callTelegramWithRetry<T>(
  method: TelegramMethod,
  call: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const tries = Math.max(1, Math.trunc(options.tries ?? DEFAULT_TRIES));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= tries || !shouldRetryTelegram(method, error)) throw error;
      const delay = retryDelayMs(error, attempt);
      logger.warn(`Telegram ${method} 第 ${attempt}/${tries} 次失敗，${delay}ms 後重試`);
      await sleep(delay);
    }
  }
}
