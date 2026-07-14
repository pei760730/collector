import { describe, it, expect } from "vitest";
import { runIngest } from "../../src/engines/of/bot/handlers/ingest.js";
import { MemoryStorage } from "../../src/engines/of/storage/memory.js";
import type { Storage } from "../../src/engines/of/storage/Storage.js";

const FIXED = () => 1_700_000_000_000;
const deps = (storage: Storage) => ({ storage, expandShortUrls: false, now: FIXED });

describe("runIngest — 核心流程", () => {
  it("新的可解析連結 → pending_review 並寫入", async () => {
    const s = new MemoryStorage();
    const r = await runIngest({ text: "https://www.instagram.com/reel/CxYz_-1" }, deps(s));
    expect(r.reply).toContain("待處理");
    const rows = s.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.STATUS).toBe("pending_review");
    expect(rows[0]!.VIDEO_ID).toBe("ig_CxYz_-1");
  });

  it("重複連結 → 回已存在,且不重複寫入", async () => {
    const s = new MemoryStorage();
    await runIngest({ text: "https://www.tiktok.com/@u/video/7234567890" }, deps(s));
    const r = await runIngest({ text: "https://www.tiktok.com/@u/video/7234567890" }, deps(s));
    expect(r.reply).toContain("已經存在");
    expect(r.reply).toContain("暫存區");
    expect(s.all()).toHaveLength(1);
  });

  it("總表已存在 CLEAN_URL → 回已存在總表,且不寫入暫存區", async () => {
    const url = "https://www.instagram.com/reel/CxYz_-1";
    const s = new MemoryStorage([], { approvedUrls: [` ${url} `] });
    const r = await runIngest({ text: url }, deps(s));
    expect(r.reply).toContain("總表/待拍池");
    expect(s.all()).toHaveLength(0);
  });

  it("無法解析(Other)→ unsupported 但仍寫入(不查重)", async () => {
    const s = new MemoryStorage([], { approvedUrls: ["https://example.com/foo"] });
    const r = await runIngest({ text: "https://example.com/foo" }, deps(s));
    expect(r.reply).toContain("unsupported");
    const rows = s.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.STATUS).toBe("unsupported");
    expect(rows[0]!.VIDEO_ID).toBe("raw_1700000000000");
  });

  it("unsupported 即使 VIDEO_ID 相同也不去重(各自存)", async () => {
    const s = new MemoryStorage();
    await runIngest({ text: "https://example.com/a" }, deps(s));
    await runIngest({ text: "https://example.com/b" }, deps(s));
    // 同一注入時間 → 同 raw_ id,但 unsupported 不查重 → 兩列
    expect(s.all()).toHaveLength(2);
  });

  it("總表 URL 欄不可用 → fail-soft,照常 append", async () => {
    const url = "https://www.instagram.com/reel/CxYz_-1";
    const s = new MemoryStorage([], {
      approvedUrls: [url],
      approvedUrlColumnAvailable: false,
    });
    const r = await runIngest({ text: url }, deps(s));
    expect(r.reply).toContain("待處理");
    expect(s.all()).toHaveLength(1);
  });

  it("沒有網址 → 格式錯誤提示,不寫入", async () => {
    const s = new MemoryStorage();
    const r = await runIngest({ text: "隨便打字" }, deps(s));
    expect(r.reply).toContain("沒有抓到網址");
    expect(s.all()).toHaveLength(0);
  });

  it("儲存失敗 → 失敗訊息 + error 欄", async () => {
    const failing: Storage = {
      ensureHeader: async () => {},
      findByVideoId: async () => null,
      videoIdIndex: async () => new Map(),
      findApprovedByUrl: async () => false,
      approvedUrlSet: async () => new Set(),
      stats: async () => ({
        total: 0,
        byPlatform: {},
        byStatus: {},
        addedThisWeek: 0,
        addedThisMonth: 0,
        recent: [],
      }),
      append: async () => {
        throw new Error("boom");
      },
    };
    const r = await runIngest(
      { text: "https://www.instagram.com/reel/CxYz_-1" },
      deps(failing),
    );
    expect(r.reply).toContain("寫入失敗");
    expect(r.error).toContain("boom");
  });

  it("儲存失敗 → 觸發 onPersistError(drain 靠它停在 offset、不靜默丟資料)", async () => {
    const failing: Storage = {
      ensureHeader: async () => {},
      findByVideoId: async () => null,
      videoIdIndex: async () => new Map(),
      findApprovedByUrl: async () => false,
      approvedUrlSet: async () => new Set(),
      stats: async () => ({
        total: 0,
        byPlatform: {},
        byStatus: {},
        addedThisWeek: 0,
        addedThisMonth: 0,
        recent: [],
      }),
      append: async () => {
        throw new Error("sheet 寫入炸了");
      },
    };
    let persistFailed = false;
    const r = await runIngest(
      { text: "https://www.instagram.com/reel/CxYz_-1" },
      { ...deps(failing), onPersistError: () => (persistFailed = true) },
    );
    expect(persistFailed).toBe(true); // drain 收得到「沒持久化」訊號
    expect(r.error).toBeDefined(); // 同時 contract 不變(仍回 error)
  });

  it("成功寫入 → 不觸發 onPersistError", async () => {
    const s = new MemoryStorage();
    let persistFailed = false;
    await runIngest(
      { text: "https://www.instagram.com/reel/CxYz_-1" },
      { ...deps(s), onPersistError: () => (persistFailed = true) },
    );
    expect(persistFailed).toBe(false);
  });

  it("expandShortUrls:true + 注入 fake 展開器 → 用展開後的長鏈 clean/去重/存(不打網路)", async () => {
    const s = new MemoryStorage();
    const fakeExpand = async (u: string) =>
      u.includes("vt.tiktok")
        ? "https://www.tiktok.com/@x/video/7999"
        : u;
    const r = await runIngest(
      { text: "https://vt.tiktok.com/ZSabc123/" },
      { storage: s, expandShortUrls: true, expandShortUrl: fakeExpand, now: FIXED },
    );
    expect(r.reply).toContain("待處理");
    const rows = s.all();
    expect(rows).toHaveLength(1);
    // 存的是展開後的長鏈,而非原短鏈
    expect(rows[0]!.PLATFORM).toBe("TikTok");
    expect(rows[0]!.CLEAN_URL).toBe("https://www.tiktok.com/@x/video/7999");
    expect(rows[0]!.VIDEO_ID).toBe("tt_7999");
  });

  it("expandShortUrls:false → 不展開(false 分支照舊,短鏈原樣進 pipeline)", async () => {
    const s = new MemoryStorage();
    let called = false;
    const spyExpand = async (u: string) => {
      called = true;
      return u;
    };
    await runIngest(
      { text: "https://vt.tiktok.com/ZSabc123/" },
      { storage: s, expandShortUrls: false, expandShortUrl: spyExpand, now: FIXED },
    );
    // gate 關閉 → 展開器根本不該被呼叫
    expect(called).toBe(false);
  });

  it("備註超長被 core 截斷 → 成功收錄回覆帶截斷提醒", async () => {
    const s = new MemoryStorage();
    const longNote = "x".repeat(2100); // > core MAX_NOTE_LEN(2000)
    const r = await runIngest(
      { text: `https://www.instagram.com/reel/CxYz_-1 ${longNote}` },
      deps(s),
    );
    expect(r.reply).toContain("待處理"); // 照常收錄
    expect(r.reply).toContain("已截斷"); // 但要明講截斷
    expect(s.all()).toHaveLength(1);
  });

  it("備註超長 + unsupported(raw_)→ 回覆也帶截斷提醒(免得人工審核對半截值困惑)", async () => {
    const s = new MemoryStorage();
    const longNote = "x".repeat(2100);
    const r = await runIngest(
      { text: `https://example.com/foo ${longNote}` },
      deps(s),
    );
    expect(r.reply).toContain("unsupported"); // 照常走 raw_ 收錄
    expect(r.reply).toContain("已截斷");
    expect(s.all()).toHaveLength(1);
  });

  it("正常長度訊息 → 回覆不帶截斷提醒", async () => {
    const s = new MemoryStorage();
    const r = await runIngest(
      { text: "https://www.instagram.com/reel/CxYz_-1 正常備註" },
      deps(s),
    );
    expect(r.reply).toContain("待處理");
    expect(r.reply).not.toContain("已截斷");
  });

  it("FB 轉址 → 還原內層平台並寫入", async () => {
    const s = new MemoryStorage();
    const inner = "https://www.instagram.com/reel/CxYz_-1";
    const wrapped = `https://l.facebook.com/l.php?u=${encodeURIComponent(inner)}`;
    await runIngest({ text: wrapped }, deps(s));
    const rows = s.all();
    expect(rows[0]!.PLATFORM).toBe("Instagram");
    expect(rows[0]!.CLEAN_URL).toBe(inner);
    expect(rows[0]!.VIDEO_ID).toBe("ig_CxYz_-1");
  });
});
