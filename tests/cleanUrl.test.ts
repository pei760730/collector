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
});
