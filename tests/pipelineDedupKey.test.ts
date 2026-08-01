/**
 * 2026-08-01 突變測試倖存者 M3 回填:dedupKey 必須從「清理後」網址推導。
 *
 * groupKey 不會自己 cleanUrl:FB 轉址包裝(l.facebook.com/l.php?u=…)抽不出
 * 平台 id 時退回 path fallback key → 所有包裝分享撞同一把 key,第二支不同影片
 * 被當重複「靜默丟棄」;同支影片包裝/裸連結又會變兩列。既有 FB 轉址測試只斷言
 * row.平台/連結(來自 cleaned),從未斷言 draft.dedupKey 的推導來源。
 */
import { describe, expect, it } from "vitest";
import { cleanUrl } from "@pei760730/collector-core";
import { assembleDraft, dedupKey } from "../src/pipeline/index.js";

const wrap = (target: string) =>
  `https://l.facebook.com/l.php?u=${encodeURIComponent(target)}`;

const REEL_A = "https://www.instagram.com/reel/AAA111/";
const REEL_B = "https://www.instagram.com/reel/BBB222/";

function draft(rawUrl: string) {
  return assembleDraft({ rawUrl, note: "", truncated: false });
}

describe("dedupKey 從 cleaned.cleanUrl 推導(M3)", () => {
  it("兩支不同影片各自包在 FB 轉址裡 → dedupKey 必須不同(否則第二支被靜默丟棄)", () => {
    expect(draft(wrap(REEL_A)).dedupKey).not.toBe(draft(wrap(REEL_B)).dedupKey);
  });

  it("同支影片:包裝與裸連結收斂到同一把 dedupKey", () => {
    expect(draft(wrap(REEL_A)).dedupKey).toBe(draft(REEL_A).dedupKey);
  });

  it("dedupKey === groupKey(cleanUrl(raw).cleanUrl) 的推導鏈釘死", () => {
    const raw = wrap(REEL_A);
    expect(draft(raw).dedupKey).toBe(dedupKey(cleanUrl(raw).cleanUrl));
  });
});
