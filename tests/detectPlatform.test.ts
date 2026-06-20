import { describe, it, expect } from "vitest";
import { detectPlatform } from "../src/pipeline/detectPlatform.js";

describe("detectPlatform", () => {
  const cases: [string, string][] = [
    ["https://www.tiktok.com/@u/video/123", "TikTok"],
    ["https://youtu.be/abcdefghijk", "YouTube"],
    ["https://www.youtube.com/shorts/abcdefghijk", "YouTube"],
    ["https://www.facebook.com/watch?v=1", "Facebook"],
    ["https://fb.watch/xyz", "Facebook"],
    ["https://www.instagram.com/reel/abc", "Instagram"],
    ["https://www.threads.com/@u/post/DZwtc9Jk7Yf", "Threads"],
    ["https://www.threads.net/@u/post/DZwtc9Jk7Yf", "Threads"],
    ["https://x.com/a/status/1", "X"],
    ["https://twitter.com/a/status/1", "X"],
    ["https://www.douyin.com/video/123", "抖音"],
    ["https://xhslink.com/abc", "小紅書"],
    ["https://www.xiaohongshu.com/explore/abc", "小紅書"],
  ];

  for (const [url, platform] of cases) {
    it(`${platform} ← ${url}`, () => {
      const r = detectPlatform(url);
      expect(r.platform).toBe(platform);
      expect(r.confidence).toBe("high");
      expect(r.method).toBe("domain_match");
      expect(r.icon).not.toBe("");
    });
  }

  it("不認得 → fallback Instagram(medium)", () => {
    const r = detectPlatform("https://example.com/whatever");
    expect(r.platform).toBe("Instagram");
    expect(r.confidence).toBe("medium");
    expect(r.method).toBe("fallback");
  });

  it("空字串 → error/low", () => {
    const r = detectPlatform("");
    expect(r.method).toBe("error");
    expect(r.confidence).toBe("low");
  });

  // hostname 比對:子字串誤判不該再發生
  it("netflix.com 不該被當成 X(含 x.com 子字串)", () => {
    expect(detectPlatform("https://www.netflix.com/watch/81234567").method).toBe("fallback");
  });
  it("box.com 不該被當成 X", () => {
    expect(detectPlatform("https://box.com/s/abc").method).toBe("fallback");
  });
  it("abcfb.com 不該被當成 Facebook", () => {
    expect(detectPlatform("https://abcfb.com/x").method).toBe("fallback");
  });
  it("tiktok.com.evil.com 不該被當成 TikTok", () => {
    const r = detectPlatform("https://tiktok.com.evil.com/x");
    expect(r.method).toBe("fallback");
  });
  it("query 裡有 x.com 不影響 hostname 判斷", () => {
    const r = detectPlatform("https://example.com/redirect?to=x.com");
    expect(r.method).toBe("fallback");
  });
});
