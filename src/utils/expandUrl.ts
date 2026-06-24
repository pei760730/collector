/**
 * 短網址展開(opt-in,EXPAND_SHORT_URLS=true 才用)。
 * 用 HEAD 跟隨 redirect 取真實網址;失敗就原樣退回,不擋流程。
 */
import { logger } from "./logger.js";

export async function expandShortUrl(url: string, timeoutMs = 5000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: controller.signal,
    });
    return res.url || url;
  } catch (err) {
    logger.warn(`短網址展開失敗,沿用原網址:${url}`, err);
    return url;
  } finally {
    clearTimeout(timer);
  }
}
