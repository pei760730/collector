import { logger } from "@pei760730/collector-core";

const DEFAULT_TRIES = 4;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 60_000;

type TelegramMethod = "getUpdates" | "sendMessage";

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
  if (method !== "getUpdates") return false;
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
