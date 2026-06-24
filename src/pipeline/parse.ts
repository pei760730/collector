/**
 * Parse — 從 Telegram 訊息文字抽出第一個網址 + 備註。
 * 純函式,無副作用,好測試。
 */
import type { ParsedMessage } from "../types.js";

/** 抓訊息中第一個 http(s) 網址。 */
const URL_RE = /https?:\/\/\S+/;

// 1) 截斷在第一個「非 URL 合法字元」—— CJK 等必須 %-encode 的字不會出現在裸 URL,
//    所以遇到就代表後面是備註。把 `…/abc。很好笑` 切回 `…/abc`。
const NON_URL_CHAR = /[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%].*$/u;
// 2) 再剝掉尾端句讀(這些雖是合法 URL 字元,但黏在連結尾幾乎都是標點)。
const TRAILING_PUNCT = /[.,;:!?)\]'"}>]+$/u;

/** 把訊息抓到的裸 URL 修乾淨:截斷非法字元 + 剝尾端標點。 */
export function tidyUrl(raw: string): string {
  return raw.replace(NON_URL_CHAR, "").replace(TRAILING_PUNCT, "");
}

// 備註頭部:連結與備註之間殘留的分隔標點(含 CJK)一律剝掉,如 `…/abc。健身梗` 的 `。`、
// 包裹連結的 `(…)` 殘餘。含句末語氣標點(. , ! ?。!?)以便清掉純標點殘渣。
const NOTE_LEAD_SEP = /^[\s.,;:!?、。，．！？；：（）()[\]{}<>「」『』《》〈〉"'　]+/u;
// 備註尾部:只剝括號/引號/分隔標點與空白,**保留**句末語氣標點(備註「哈哈!」的 `!` 要留)。
const NOTE_TRAIL_SEP = /[\s、，；：（）()[\]{}<>「」『』《》〈〉"'　]+$/u;

/** 清理備註:收斂連續空白、剝頭尾殘留分隔標點(尾端保留語氣標點)。 */
export function cleanNote(s: string): string {
  return s
    .replace(/[ \t]{2,}/g, " ")
    .replace(NOTE_LEAD_SEP, "")
    .replace(NOTE_TRAIL_SEP, "")
    .trim();
}

export class NoUrlError extends Error {
  constructor() {
    super("訊息中找不到網址");
    this.name = "NoUrlError";
  }
}

export interface ParseInput {
  text: string;
  /** Telegram from.first_name;沒有就傳空字串。 */
  senderName?: string;
}

/**
 * @throws {NoUrlError} 訊息沒有網址(格式錯誤)。
 */
export function parseMessage(input: ParseInput): ParsedMessage {
  const text = (input.text ?? "").trim();
  const match = text.match(URL_RE);
  if (!match) {
    throw new NoUrlError();
  }
  const token = match[0];
  const rawUrl = tidyUrl(token);
  if (!/^https?:\/\/\S/.test(rawUrl)) {
    // 整段被剝光(例如 `https://` 後面全是標點)→ 視為沒有有效網址
    throw new NoUrlError();
  }
  // 備註 = 用「位置」切掉被匹配的整個 token,再把 tidyUrl 從 token 尾端截掉的備註正文補回。
  // 不用 text.replace(rawUrl):replace 只換首個出現、且會誤切備註裡與 URL 相同的片段。
  const before = text.slice(0, match.index ?? 0);
  const after = text.slice((match.index ?? 0) + token.length);
  const urlTail = token.slice(rawUrl.length); // tidyUrl 砍掉的尾段(備註開頭 / 包裹標點)
  const note = cleanNote(`${before}${urlTail}${after}`);
  // 改進#5:SENDER 不再寫死 'Pei',用真實提交者,沒有才 unknown
  const sender =
    input.senderName && input.senderName.trim() !== ""
      ? input.senderName.trim()
      : "unknown";
  return { rawUrl, note, sender };
}
