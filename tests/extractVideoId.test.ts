import { describe, it, expect } from "vitest";
import { extractVideoId } from "../src/pipeline/extractVideoId.js";

const FIXED = () => 1_700_000_000_000;

describe("extractVideoId", () => {
  it("TikTok video/<id>", () => {
    expect(extractVideoId("TikTok", "https://www.tiktok.com/@u/video/7234567890").videoId).toBe(
      "tiktok_7234567890",
    );
  });

  it("TikTok item_id=", () => {
    expect(
      extractVideoId("TikTok", "https://www.tiktok.com/x?item_id=12345").videoId,
    ).toBe("tiktok_12345");
  });

  it("TikTok 19 位純數字 fallback", () => {
    expect(
      extractVideoId("TikTok", "https://vt.tiktok.com/1234567890123456789").videoId,
    ).toBe("tiktok_1234567890123456789");
  });

  it("Instagram /reel/<code>(取 code 那組,非 reel)", () => {
    expect(extractVideoId("Instagram", "https://www.instagram.com/reel/CxYz_-1").videoId).toBe(
      "ig_CxYz_-1",
    );
  });

  it("Instagram /p/<code> 取 code", () => {
    const v = extractVideoId("Instagram", "https://www.instagram.com/p/AbC123_-x").videoId;
    expect(v).toBe("ig_AbC123_-x");
  });

  it("YouTube watch?v=", () => {
    expect(
      extractVideoId("YouTube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ").videoId,
    ).toBe("yt_dQw4w9WgXcQ");
  });

  it("YouTube youtu.be 短鏈", () => {
    expect(extractVideoId("YouTube", "https://youtu.be/dQw4w9WgXcQ").videoId).toBe(
      "yt_dQw4w9WgXcQ",
    );
  });

  it("YouTube shorts", () => {
    expect(
      extractVideoId("YouTube", "https://www.youtube.com/shorts/dQw4w9WgXcQ").videoId,
    ).toBe("yt_dQw4w9WgXcQ");
  });

  it("小紅書 /explore/<id>", () => {
    expect(
      extractVideoId("小紅書", "https://www.xiaohongshu.com/explore/abc123").videoId,
    ).toBe("xhs_abc123");
  });

  it("Facebook 無抽取規則 → unknown + unsupported", () => {
    const r = extractVideoId("Facebook", "https://fb.watch/xyz", FIXED);
    expect(r.unsupported).toBe(true);
    expect(r.videoId).toBe("unknown_1700000000000");
  });

  it("抓不到 → unknown_<ts>", () => {
    const r = extractVideoId("TikTok", "https://www.tiktok.com/discover", FIXED);
    expect(r.unsupported).toBe(true);
    expect(r.videoId).toBe("unknown_1700000000000");
  });

  it("Threads /post/<id>", () => {
    const r = extractVideoId("Threads", "https://www.threads.com/@u/post/DZwtc9Jk7Yf");
    expect(r.videoId).toBe("threads_DZwtc9Jk7Yf");
    expect(r.unsupported).toBe(false);
  });

  it("YouTube channel/@user 不該被當成影片", () => {
    expect(extractVideoId("YouTube", "https://www.youtube.com/channel/UCabcdefghij", FIXED).unsupported).toBe(true);
    expect(extractVideoId("YouTube", "https://www.youtube.com/@someuser11", FIXED).unsupported).toBe(true);
  });
});
