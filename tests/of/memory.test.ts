import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../../src/engines/of/storage/memory.js";
import type { StagingRow } from "../../src/engines/of/types.js";

function row(videoId: string, cleanUrl = `https://example.com/${videoId}`): StagingRow {
  return {
    PLATFORM: "TikTok",
    DATE: "2026/8/18",
    CLEAN_URL: cleanUrl,
    VIDEO_ID: videoId,
    STATUS: "pending_review",
  };
}

describe("of MemoryStorage", () => {
  it("建索引時 trim key、略過空值、重複 key 保留第一列與實體列號", async () => {
    const first = row(" tt_1 ");
    const storage = new MemoryStorage([row("   "), first, row("tt_1"), row("tt_2")]);

    await expect(storage.ensureHeader()).resolves.toBeUndefined();
    const index = await storage.videoIdIndex();

    expect([...index.keys()]).toEqual(["tt_1", "tt_2"]);
    expect(index.get("tt_1")).toEqual({ row: first, rowNumber: 3 });
    await expect(storage.findByVideoId(" tt_1 ")).resolves.toEqual(index.get("tt_1"));
    await expect(storage.findByVideoId("missing")).resolves.toBeNull();
    await expect(storage.findByVideoId("   ")).resolves.toBeNull();
  });

  it("總表 URL seed 與查詢都 trim/clean，空值忽略，回傳集合副本", async () => {
    const storage = new MemoryStorage([], {
      approvedUrls: [
        " ",
        " https://youtu.be/abc?utm_source=test ",
      ],
    });

    expect(await storage.findApprovedByUrl(" https://youtu.be/abc?utm_medium=test ")).toBe(true);
    expect(await storage.findApprovedByUrl("   ")).toBe(false);
    expect(await storage.findApprovedByUrl("https://youtu.be/missing")).toBe(false);

    const urls = await storage.approvedUrlSet();
    urls.clear();
    expect((await storage.approvedUrlSet()).size).toBe(1);
  });

  it("總表 URL 欄不可用時 fail-soft 回空集合", async () => {
    const storage = new MemoryStorage([], {
      approvedUrls: ["https://youtu.be/abc"],
      approvedUrlColumnAvailable: false,
    });

    expect(await storage.approvedUrlSet()).toEqual(new Set());
    expect(await storage.findApprovedByUrl("https://youtu.be/abc")).toBe(false);
  });

  it("append/all 使用陣列副本，stats 委派純函式彙總", async () => {
    const storage = new MemoryStorage();
    const added = row("tt_3");

    await storage.append(added);
    const snapshot = storage.all();
    snapshot.length = 0;

    expect(storage.all()).toEqual([added]);
    await expect(
      storage.stats({ recentLimit: 1, nowMs: Date.UTC(2026, 7, 18) }),
    ).resolves.toMatchObject({ total: 1, byPlatform: { TikTok: 1 }, recent: [added] });
  });
});
