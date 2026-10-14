/**
 * 公開 Actions log 的錯誤輸出紀律(shell 與 of 共用)。
 *
 * repo 是 public:任何 `logger.error(msg, err)` 都會讓 console 用 util.inspect 把整個錯誤物件
 * 攤開。兩種東西因此外洩過(2026-10-14 審計實測):
 * - gaxios 的 GaxiosError 帶 `config.body`(append 的 JSON 字串 = 整列值,含連結),會被完整印出。
 * - telegraf 只在 fetch 階段 redactToken;`res.json()` 讀 body 階段的 node-fetch FetchError 訊息
 *   帶完整 `https://api.telegram.org/bot<TOKEN>/…`。GitHub 只遮 log 顯示,drain.log 檔案與
 *   失敗通知(kai-notify)拿到的是明文。
 * 所以 log 只印這裡組出來的字串摘要:name/message/HTTP 狀態/Google reason,全部過 redactSecrets。
 * 絕不輸出 config/body/request/response.data 其他欄位。
 */

/** Telegram bot token 出現在 URL 路徑裡的形態:`/bot<數字>:<token>`。 */
const TELEGRAM_TOKEN_IN_PATH = /\/bot\d+:[A-Za-z0-9_-]+/g;

/** 遮蔽文字中的秘密(目前 = Telegram bot token)。 */
export function redactSecrets(text: string): string {
  return text.replace(TELEGRAM_TOKEN_IN_PATH, "/bot***");
}

interface ErrorLike {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  status?: unknown;
  errors?: Array<{ reason?: unknown }>;
  response?: {
    status?: unknown;
    data?: { error?: { status?: unknown; errors?: Array<{ reason?: unknown }> } };
  };
}

/** 單行錯誤摘要:`Name: message status=… code=… reason=…`(已遮秘密)。 */
export function errSummary(error: unknown): string {
  if (typeof error !== "object" || error === null) return redactSecrets(String(error));
  const e = error as ErrorLike;
  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const parts = [`${name}: ${typeof e.message === "string" ? e.message : String(e.message ?? "")}`];

  const status =
    typeof e.code === "number"
      ? e.code
      : typeof e.status === "number"
        ? e.status
        : typeof e.response?.status === "number"
          ? e.response.status
          : undefined;
  if (status !== undefined) parts.push(`status=${status}`);
  if (typeof e.code === "string" && e.code) parts.push(`code=${e.code}`);

  const googleError = e.response?.data?.error;
  const reason =
    googleError?.status ?? googleError?.errors?.[0]?.reason ?? e.errors?.[0]?.reason;
  if (typeof reason === "string" && reason) parts.push(`reason=${reason}`);

  return redactSecrets(parts.join(" "));
}

/** 摘要 + stack(已遮秘密)—— 給進程最外層 catch 用,保留排查用的呼叫位置。 */
export function errDetail(error: unknown): string {
  const summary = errSummary(error);
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  return stack ? `${summary}\n${redactSecrets(stack)}` : summary;
}
