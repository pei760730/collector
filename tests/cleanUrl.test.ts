import { describe, it, expect } from "vitest";
import { cleanUrl } from "../src/pipeline/cleanUrl.js";

describe("cleanUrl", () => {
  it("移除追蹤參數但保留真參數", () => {
    const { cleanUrl: out } = cleanUrl(
      "https://www.youtube.com/watch?v=abc&utm_source=ig&fbclid=xyz",
    );
    expect(out).toContain("v=abc");
    expect(out).not.toContain("utm_source");
    expect(out).not.toContain("fbclid");
  });

  it("行動版轉桌面版", () => {
    expect(cleanUrl("https://m.tiktok.com/v/123").cleanUrl).toContain("www.tiktok.com");
    expect(cleanUrl("https://mobile.twitter.com/a/status/1").cleanUrl).toContain(
      "twitter.com",
    );
    expect(cleanUrl("https://m.youtube.com/watch?v=abcdefghijk").cleanUrl).toContain(
      "www.youtube.com",
    );
  });

  it("補 https 前綴", () => {
    expect(cleanUrl("tiktok.com/@u/video/1").cleanUrl).toMatch(/^https:\/\//);
  });

  it("去尾斜線", () => {
    expect(cleanUrl("https://x.com/a/").cleanUrl).toBe("https://x.com/a");
  });

  it("偵測短網址", () => {
    expect(cleanUrl("https://bit.ly/abc").isShortUrl).toBe(true);
    expect(cleanUrl("https://t.co/abc").isShortUrl).toBe(true);
    expect(cleanUrl("https://www.tiktok.com/x").isShortUrl).toBe(false);
    // TikTok 短連結要被認出來,EXPAND_SHORT_URLS 才會展開 → 短/長連結去重一致。
    expect(cleanUrl("https://vm.tiktok.com/ZGJabc/").isShortUrl).toBe(true);
    expect(cleanUrl("https://vt.tiktok.com/ZSabc/").isShortUrl).toBe(true);
  });

  it("只移除追蹤參數後不留空 ?", () => {
    const { cleanUrl: out } = cleanUrl("https://x.com/a?utm_source=ig");
    expect(out).toBe("https://x.com/a");
  });

  it("清掉 Meta/Threads 分享追蹤碼(xmt/slof/igsh)", () => {
    const out = cleanUrl(
      "https://www.threads.com/@u/post/DZwtc9Jk7Yf?xmt=AQG0abc&slof=1",
    ).cleanUrl;
    expect(out).toBe("https://www.threads.com/@u/post/DZwtc9Jk7Yf");
    expect(cleanUrl("https://www.instagram.com/reel/ABC?igsh=xx").cleanUrl).toBe(
      "https://www.instagram.com/reel/ABC",
    );
  });

  describe("Facebook 轉址解開(l.facebook.com/l.php?u=…)", () => {
    it("還原內層 IG reel(外層 fbclid 也清掉)", () => {
      const inner = "https://www.instagram.com/reel/CxYz_-1";
      const wrapped = `https://l.facebook.com/l.php?u=${encodeURIComponent(inner)}&fbclid=abc`;
      expect(cleanUrl(wrapped).cleanUrl).toBe(inner);
    });

    it("還原內層後續走完整清理(內層自己的追蹤參數也清)", () => {
      const inner = "https://www.instagram.com/reel/CxYz_-1?igsh=zzz";
      const wrapped = `https://l.facebook.com/l.php?u=${encodeURIComponent(inner)}`;
      expect(cleanUrl(wrapped).cleanUrl).toBe("https://www.instagram.com/reel/CxYz_-1");
    });

    it("內層是 TikTok 短連結 → isShortUrl 以內層判定(true)", () => {
      const inner = "https://vm.tiktok.com/ZGJabc/";
      const wrapped = `https://lm.facebook.com/l.php?u=${encodeURIComponent(inner)}`;
      const r = cleanUrl(wrapped);
      expect(r.cleanUrl).toContain("vm.tiktok.com");
      expect(r.isShortUrl).toBe(true);
    });

    it("l.facebook 但沒有 u 參數 → 不解開(當一般 facebook 連結)", () => {
      const out = cleanUrl("https://l.facebook.com/somewhere").cleanUrl;
      expect(out).toContain("l.facebook.com");
    });
  });
});
