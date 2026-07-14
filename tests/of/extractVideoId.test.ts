import { describe, it, expect } from "vitest";
import { cleanUrl } from "@pei760730/collector-core";
import { extractVideoId } from "../../src/engines/of/pipeline/extractVideoId.js";

const FIXED = () => 1_700_000_000_000;

describe("extractVideoId — 各平台正常抽取", () => {
  it("Instagram /reel/<code>", () => {
    const r = extractVideoId("https://www.instagram.com/reel/CxYz_-1");
    expect(r.platform).toBe("Instagram");
    expect(r.videoId).toBe("ig_CxYz_-1");
    expect(r.unsupported).toBe(false);
  });

  it("Instagram /p/<code>", () => {
    expect(extractVideoId("https://www.instagram.com/p/AbC123_-x").videoId).toBe("ig_AbC123_-x");
  });

  it("Instagram /tv/<code> (IGTV)", () => {
    const r = extractVideoId("https://www.instagram.com/tv/CxYz_-1");
    expect(r.platform).toBe("Instagram");
    expect(r.videoId).toBe("ig_CxYz_-1");
    expect(r.unsupported).toBe(false);
  });

  it("TikTok /video/<id> → tt_ 前綴", () => {
    const r = extractVideoId("https://www.tiktok.com/@u/video/7234567890");
    expect(r.platform).toBe("TikTok");
    expect(r.videoId).toBe("tt_7234567890");
  });

  it("YouTube watch?v=", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ").videoId).toBe(
      "yt_dQw4w9WgXcQ",
    );
  });

  it("YouTube youtu.be 短鏈", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ").videoId).toBe("yt_dQw4w9WgXcQ");
  });

  it("YouTube shorts", () => {
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ").videoId).toBe(
      "yt_dQw4w9WgXcQ",
    );
  });

  it("YouTube 11 碼後接 query 參數仍可抽", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ?si=abc").videoId).toBe("yt_dQw4w9WgXcQ");
  });

  it("YouTube 非 11 碼(12 碼)→ 不截斷,落 raw_(unsupported)", () => {
    const r = extractVideoId("https://youtube.com/watch?v=AAAAAAAAAAAA", FIXED);
    expect(r.unsupported).toBe(true);
    expect(r.videoId).toBe("raw_1700000000000");
  });

  it("YouTube shorts 13 碼 → 不截斷,落 raw_", () => {
    expect(
      extractVideoId("https://www.youtube.com/shorts/ABCDEFGHIJKLM", FIXED).unsupported,
    ).toBe(true);
  });

  it("X /status/<id> → x_ 前綴", () => {
    const r = extractVideoId("https://x.com/someone/status/1690000000000000001");
    expect(r.platform).toBe("X");
    expect(r.videoId).toBe("x_1690000000000000001");
  });

  it("twitter.com 也判成 X", () => {
    expect(extractVideoId("https://twitter.com/a/status/12345").videoId).toBe("x_12345");
  });

  it("小紅書 /explore/<id>", () => {
    expect(extractVideoId("https://www.xiaohongshu.com/explore/abc123").videoId).toBe("xhs_abc123");
  });

  it("Threads /post/<id> → th_ 前綴", () => {
    const r = extractVideoId("https://www.threads.com/@u/post/DZwtc9Jk7Yf");
    expect(r.platform).toBe("Threads");
    expect(r.videoId).toBe("th_DZwtc9Jk7Yf");
    expect(r.unsupported).toBe(false);
  });

  it("threads.net 也判成 Threads", () => {
    expect(extractVideoId("https://www.threads.net/@u/post/DZwtc9Jk7Yf").videoId).toBe(
      "th_DZwtc9Jk7Yf",
    );
  });

  it("小紅書 /discovery/item/<id>", () => {
    expect(
      extractVideoId("https://www.xiaohongshu.com/discovery/item/64ab12cd").videoId,
    ).toBe("xhs_64ab12cd");
  });

  it("抖音 /video/<id> → dy_ 前綴(2026-07-06 新支援)", () => {
    const r = extractVideoId("https://www.douyin.com/video/7234567890123456789");
    expect(r.platform).toBe("抖音");
    expect(r.videoId).toBe("dy_7234567890123456789");
    expect(r.unsupported).toBe(false);
  });

  it("抖音 query 注入造不出假 id → unsupported(退 raw_,對齊 TikTok path-only)", () => {
    const r = extractVideoId("https://www.douyin.com/user/x?redirect=/video/9999999999", FIXED);
    expect(r.platform).toBe("抖音");
    expect(r.unsupported).toBe(true);
  });
});

describe("extractVideoId — 2026-06-27 對齊(pathname 化 + YT live + XHS hex)", () => {
  it("YouTube /live/<id> → yt_(新增 live 形態)", () => {
    expect(extractVideoId("https://www.youtube.com/live/dQw4w9WgXcQ").videoId).toBe(
      "yt_dQw4w9WgXcQ",
    );
  });

  it("YouTube embed/ 仍可抽", () => {
    expect(extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ").videoId).toBe(
      "yt_dQw4w9WgXcQ",
    );
  });

  it("小紅書 id 收緊小寫 hex:純 hex 抽得到", () => {
    expect(extractVideoId("https://www.xiaohongshu.com/explore/663ed2b2000000001e0102a3").videoId).toBe(
      "xhs_663ed2b2000000001e0102a3",
    );
  });

  it("小紅書 大寫 hex id 整段抽不截斷、且 lowercase 收斂(i flag + case-fold)", () => {
    // 缺 i flag 時 663ED2B2… 會在 E 截斷成 xhs_663 → 不同筆記假合併(2026-06-29 修)。
    // 抽整段後還要 lowercase:hex 大小寫無語義,大小寫變體必須撞同 VIDEO_ID 才去得了重
    // (2026-07-02 補;core/voc/tbvoc 皆 lowercase,feed 無 groupKey 層故在抽取時收斂)。
    const upper = extractVideoId("https://www.xiaohongshu.com/explore/663ED2B2000000001E0102A3");
    const lower = extractVideoId("https://www.xiaohongshu.com/explore/663ed2b2000000001e0102a3");
    expect(upper.videoId).toBe("xhs_663ed2b2000000001e0102a3");
    expect(upper.videoId).toBe(lower.videoId);
  });

  it("Task1:query 注入 /video//reel//videos/ 造不出假 id → unsupported(退 raw_)", () => {
    expect(
      extractVideoId("https://www.tiktok.com/@u/?redirect=/video/9999999999", FIXED).unsupported,
    ).toBe(true);
    expect(
      extractVideoId("https://www.instagram.com/explore?from=/reel/INJECTED1", FIXED).unsupported,
    ).toBe(true);
    expect(
      extractVideoId("https://www.facebook.com/feed?ref=/videos/1234567890", FIXED).unsupported,
    ).toBe(true);
  });

  it("Task1:合法 path/query id 不受影響仍抽得到", () => {
    expect(extractVideoId("https://www.tiktok.com/@u/video/7234567890").videoId).toBe("tt_7234567890");
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ").videoId).toBe("yt_dQw4w9WgXcQ");
  });
});

describe("extractVideoId — Facebook 各形態", () => {
  it("A. fb.watch/<code> → fbw_", () => {
    const r = extractVideoId("https://fb.watch/abcXYZ_-");
    expect(r.platform).toBe("Facebook");
    expect(r.videoId).toBe("fbw_abcXYZ_-");
  });

  it("A2. fb.me 短鏈判 Facebook 不落 Other(2026-07-02 補,對齊 core/引擎)", () => {
    // fb.me 是 FB 官方短鏈;無 video-id 形態 → unsupported raw_,但 PLATFORM 要標對。
    const r = extractVideoId("https://fb.me/1abcdefgh", FIXED);
    expect(r.platform).toBe("Facebook");
    expect(r.unsupported).toBe(true);
  });

  it("B. /reel/<n> → fb_", () => {
    expect(extractVideoId("https://www.facebook.com/reel/1234567890").videoId).toBe("fb_1234567890");
  });

  it("B. /videos/<n> → fb_", () => {
    expect(
      extractVideoId("https://www.facebook.com/page/videos/9876543210").videoId,
    ).toBe("fb_9876543210");
  });

  it("C. /share/r/<code> → fbs_", () => {
    expect(extractVideoId("https://www.facebook.com/share/r/AbCd123/").videoId).toBe("fbs_AbCd123");
  });

  it("C. /share/v/<code> → fbs_", () => {
    expect(extractVideoId("https://www.facebook.com/share/v/XyZ789/").videoId).toBe("fbs_XyZ789");
  });

  it("D. watch/?v= → fb_", () => {
    expect(
      extractVideoId("https://www.facebook.com/watch/?v=1122334455").videoId,
    ).toBe("fb_1122334455");
  });

  it("D. story_fbid → fb_", () => {
    expect(
      extractVideoId("https://www.facebook.com/permalink.php?story_fbid=555&id=1").videoId,
    ).toBe("fb_555");
  });

  it("m.facebook.com 仍判成 Facebook", () => {
    expect(extractVideoId("https://m.facebook.com/reel/42").platform).toBe("Facebook");
  });
});

describe("FB 轉址解開(已上移 core cleanUrl 層;此處驗 clean→extract 全鏈等價)", () => {
  it("l.facebook.com/l.php?u=… → cleanUrl 還原內層 IG,extract 照常抽 id", () => {
    const inner = "https://www.instagram.com/reel/CxYz_-1";
    const wrapped = `https://l.facebook.com/l.php?u=${encodeURIComponent(inner)}&fbclid=abc`;
    const cleaned = cleanUrl(wrapped);
    expect(cleaned.cleanUrl).toBe(inner);
    const r = extractVideoId(cleaned.cleanUrl);
    expect(r.platform).toBe("Instagram");
    expect(r.videoId).toBe("ig_CxYz_-1");
  });

  it("l.facebook.com 還原內層 TikTok", () => {
    const inner = "https://www.tiktok.com/@u/video/7234567890";
    const wrapped = `https://l.facebook.com/l.php?u=${encodeURIComponent(inner)}`;
    expect(extractVideoId(cleanUrl(wrapped).cleanUrl).videoId).toBe("tt_7234567890");
  });
});

describe("extractVideoId — 抓不到 → raw_<ts> + unsupported", () => {
  it("Other 平台(不在清單)", () => {
    const r = extractVideoId("https://example.com/whatever", FIXED);
    expect(r.platform).toBe("Other");
    expect(r.videoId).toBe("raw_1700000000000");
    expect(r.unsupported).toBe(true);
  });

  it("認得平台但抽不到 ID", () => {
    const r = extractVideoId("https://www.facebook.com/somepage", FIXED);
    expect(r.platform).toBe("Facebook");
    expect(r.videoId).toBe("raw_1700000000000");
    expect(r.unsupported).toBe(true);
  });

  it("YouTube channel 不該被當影片", () => {
    expect(extractVideoId("https://www.youtube.com/channel/UCabcdefghij", FIXED).unsupported).toBe(
      true,
    );
  });
});
