import { describe, it, expect } from "vitest";
import { extractVideoId } from "../src/pipeline/extractVideoId.js";

describe("extractVideoId", () => {
  it("TikTok video/<id>", () => {
    expect(extractVideoId("TikTok", "https://www.tiktok.com/@u/video/7234567890").videoId).toBe(
      "tiktok_7234567890",
    );
  });

  it("TikTok item_id=(query)2026-06-27 不再抽 → unsupported(query 注入面,四語對齊只認 path /video/)", () => {
    const r = extractVideoId("TikTok", "https://www.tiktok.com/x?item_id=12345");
    expect(r.unsupported).toBe(true);
    expect(r.videoId).toBe("");
  });

  it("TikTok 19 位純數字短路徑 2026-06-27 不再抽 → unsupported(靠展開成 /video/;真實短碼非純數字)", () => {
    const r = extractVideoId("TikTok", "https://vt.tiktok.com/1234567890123456789");
    expect(r.unsupported).toBe(true);
    expect(r.videoId).toBe("");
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

  it("YouTube 11 碼後接 query 參數仍可抽", () => {
    expect(extractVideoId("YouTube", "https://youtu.be/dQw4w9WgXcQ?si=abc").videoId).toBe(
      "yt_dQw4w9WgXcQ",
    );
  });

  it("YouTube 非 11 碼(12 碼)→ 不截斷,落 unknown_(unsupported)", () => {
    const r = extractVideoId("YouTube", "https://www.youtube.com/watch?v=AAAAAAAAAAAA");
    expect(r.unsupported).toBe(true);
    expect(r.videoId).toBe("");
  });

  it("YouTube shorts 13 碼 → 不截斷,落 unsupported", () => {
    expect(
      extractVideoId("YouTube", "https://www.youtube.com/shorts/ABCDEFGHIJKLM").unsupported,
    ).toBe(true);
  });

  it("小紅書 /explore/<id>", () => {
    expect(
      extractVideoId("小紅書", "https://www.xiaohongshu.com/explore/abc123").videoId,
    ).toBe("xhs_abc123");
  });

  it("小紅書 /discovery/item/<id>", () => {
    expect(
      extractVideoId("小紅書", "https://www.xiaohongshu.com/discovery/item/def456").videoId,
    ).toBe("xhs_def456");
  });

  it("Facebook fb.watch/<code> → fbw_", () => {
    const r = extractVideoId("Facebook", "https://fb.watch/xyz");
    expect(r.unsupported).toBe(false);
    expect(r.videoId).toBe("fbw_xyz");
  });

  it("Facebook /reel|/reels|/videos/<n> → fb_", () => {
    expect(
      extractVideoId("Facebook", "https://www.facebook.com/reel/1234567890").videoId,
    ).toBe("fb_1234567890");
    expect(
      extractVideoId("Facebook", "https://www.facebook.com/u/videos/987654321").videoId,
    ).toBe("fb_987654321");
  });

  it("Facebook /share/[rvp]/<code> → fbs_", () => {
    expect(
      extractVideoId("Facebook", "https://www.facebook.com/share/r/AbC-1_x").videoId,
    ).toBe("fbs_AbC-1_x");
    expect(
      extractVideoId("Facebook", "https://www.facebook.com/share/v/9z8Y").videoId,
    ).toBe("fbs_9z8Y");
  });

  it("Facebook watch?v= / story_fbid → fb_", () => {
    expect(
      extractVideoId("Facebook", "https://www.facebook.com/watch?v=1122334455").videoId,
    ).toBe("fb_1122334455");
    expect(
      extractVideoId("Facebook", "https://www.facebook.com/story.php?story_fbid=55667788").videoId,
    ).toBe("fb_55667788");
  });

  it("Facebook 純個人頁(四形態皆不中)→ unknown + unsupported", () => {
    const r = extractVideoId("Facebook", "https://www.facebook.com/someuser");
    expect(r.unsupported).toBe(true);
    expect(r.videoId).toBe("");
  });

  it("抓不到 → 空 videoId + unsupported", () => {
    const r = extractVideoId("TikTok", "https://www.tiktok.com/discover");
    expect(r.unsupported).toBe(true);
    expect(r.videoId).toBe("");
  });

  it("X(Twitter)/status/<id> → x_", () => {
    expect(
      extractVideoId("X", "https://x.com/someone/status/1234567890123456789").videoId,
    ).toBe("x_1234567890123456789");
    expect(
      extractVideoId("X", "https://twitter.com/i/web/status/55667788").videoId,
    ).toBe("x_55667788");
  });

  it("X 個人頁(無 status)→ 空 videoId + unsupported", () => {
    const r = extractVideoId("X", "https://x.com/someone");
    expect(r.unsupported).toBe(true);
    expect(r.videoId).toBe("");
  });

  it("抖音 /video/<id> → douyin_", () => {
    expect(
      extractVideoId("抖音", "https://www.douyin.com/video/7234567890123456789").videoId,
    ).toBe("douyin_7234567890123456789");
  });

  it("抖音 19 位純數字短路徑 2026-06-27 不再抽 → unsupported(同 TikTok,只認 path /video/)", () => {
    const r = extractVideoId("抖音", "https://www.douyin.com/share/1234567890123456789");
    expect(r.unsupported).toBe(true);
    expect(r.videoId).toBe("");
  });

  it("抖音 個人頁(無影片)→ 空 videoId + unsupported", () => {
    const r = extractVideoId("抖音", "https://www.douyin.com/user/MS4wLjAxlong");
    expect(r.unsupported).toBe(true);
    expect(r.videoId).toBe("");
  });

  it("Threads /post/<id>", () => {
    const r = extractVideoId("Threads", "https://www.threads.com/@u/post/DZwtc9Jk7Yf");
    expect(r.videoId).toBe("threads_DZwtc9Jk7Yf");
    expect(r.unsupported).toBe(false);
  });

  it("YouTube channel/@user 不該被當成影片", () => {
    expect(extractVideoId("YouTube", "https://www.youtube.com/channel/UCabcdefghij").unsupported).toBe(true);
    expect(extractVideoId("YouTube", "https://www.youtube.com/@someuser11").unsupported).toBe(true);
  });

  it("TikTok ?sec_uid=<19位> 不該被偽造成影片 id", () => {
    const r = extractVideoId("TikTok", "https://www.tiktok.com/@u?sec_uid=1234567890123456789");
    expect(r.unsupported).toBe(true);
    expect(r.videoId).toBe("");
  });

  it("TikTok 20 位數字不該截前 19 位當 id", () => {
    const r = extractVideoId("TikTok", "https://www.tiktok.com/x/12345678901234567890");
    expect(r.unsupported).toBe(true);
  });

  it("TikTok discover 搜尋頁(帶 ?)不是影片 → unsupported", () => {
    const r = extractVideoId("TikTok", "https://www.tiktok.com/discover/funny?lang=en");
    expect(r.unsupported).toBe(true);
    expect(r.videoId).toBe("");
  });
});
