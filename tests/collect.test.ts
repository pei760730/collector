import { describe, it, expect } from "vitest";
import { runCollect } from "../src/bot/handlers/collect.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { todayIsoTaipei } from "../src/utils/date.js";
import type { RefRow } from "../src/types.js";

function deps(storage: MemoryStorage) {
  return { storage, expandShortUrls: false };
}

describe("runCollect", () => {
  it("合法連結 → 寫入參考池(4 欄、平台小寫)+ 成功訊息", async () => {
    const storage = new MemoryStorage();
    const r = await runCollect(
      { text: "https://www.tiktok.com/@u/video/7234567890 好笑" },
      deps(storage),
    );
    expect(r.error).toBeUndefined();
    expect(r.reply).toContain("已收進參考池");
    expect(r.reply).toContain("好笑"); // 備註顯示在回覆(不存表)
    const all = await storage.readAll();
    expect(all).toHaveLength(1);
    const row = all[0]!;
    expect(Object.keys(row)).toEqual(["平台", "連結", "挑", "加入日期"]);
    expect(row.平台).toBe("tiktok"); // 小寫碼
    expect(row.連結).toBe("https://www.tiktok.com/@u/video/7234567890");
    expect(row.挑).toBe(""); // 留空 = 還沒挑
    expect(row.加入日期).toBe(todayIsoTaipei()); // ISO YYYY-MM-DD
  });

  it("同連結重複 → 不寫第二筆", async () => {
    const storage = new MemoryStorage();
    const msg = { text: "https://youtu.be/dQw4w9WgXcQ 影片" };
    await runCollect(msg, deps(storage));
    const r2 = await runCollect(msg, deps(storage));
    expect(r2.reply).toContain("已經收過");
    expect(await storage.readAll()).toHaveLength(1);
  });

  it("同支 YouTube 影片不同形態(youtu.be / watch?v= / shorts)→ 收斂成一筆", async () => {
    const storage = new MemoryStorage();
    await runCollect({ text: "https://youtu.be/dQw4w9WgXcQ a" }, deps(storage));
    const r2 = await runCollect(
      { text: "https://www.youtube.com/watch?v=dQw4w9WgXcQ b" },
      deps(storage),
    );
    const r3 = await runCollect(
      { text: "https://www.youtube.com/shorts/dQw4w9WgXcQ c" },
      deps(storage),
    );
    expect(r2.reply).toContain("已經收過");
    expect(r3.reply).toContain("已經收過");
    expect(await storage.readAll()).toHaveLength(1);
  });

  it("不同影片 → 各自收一筆", async () => {
    const storage = new MemoryStorage();
    await runCollect({ text: "https://youtu.be/aaaaaaaaaaa x" }, deps(storage));
    await runCollect({ text: "https://youtu.be/bbbbbbbbbbb y" }, deps(storage));
    expect(await storage.readAll()).toHaveLength(2);
  });

  it("既有列已在參考池 → 同連結視為重複,不重寫", async () => {
    const seed: RefRow = {
      平台: "youtube",
      連結: "https://youtu.be/dQw4w9WgXcQ",
      挑: "",
      加入日期: "2025-01-01",
    };
    const storage = new MemoryStorage([seed]);
    const r = await runCollect(
      { text: "https://youtu.be/dQw4w9WgXcQ 又貼一次" },
      deps(storage),
    );
    expect(r.reply).toContain("已經收過");
    expect(await storage.readAll()).toHaveLength(1);
  });

  it("無網址 → 格式錯誤提示", async () => {
    const storage = new MemoryStorage();
    const r = await runCollect({ text: "亂打一通" }, deps(storage));
    expect(r.reply).toContain("看不懂");
    expect(await storage.readAll()).toHaveLength(0);
  });

  it("帶追蹤參數的行動版網址 → 清理後寫入", async () => {
    const storage = new MemoryStorage();
    await runCollect(
      {
        text: "https://m.tiktok.com/@u/video/7234567890?utm_source=ig&fbclid=x note",
      },
      deps(storage),
    );
    const row = (await storage.readAll())[0]!;
    expect(row.連結).toContain("www.tiktok.com");
    expect(row.連結).not.toContain("utm_source");
    expect(row.連結).not.toContain("fbclid");
  });

  it("Facebook fb.watch → 平台 facebook、抽得到 id(不再標不支援)", async () => {
    const storage = new MemoryStorage();
    const r = await runCollect(
      { text: "https://fb.watch/abc note" },
      deps(storage),
    );
    expect(r.reply).toContain("已收進參考池");
    expect(r.reply).not.toContain("抓不到 video ID");
    const row = (await storage.readAll())[0]!;
    expect(row.平台).toBe("facebook");
  });

  it("Facebook 同支影片 watch?v= 與 /videos/ 收斂同 key → 去重", async () => {
    const storage = new MemoryStorage();
    await runCollect(
      { text: "https://www.facebook.com/watch?v=778899 第一次" },
      deps(storage),
    );
    const r2 = await runCollect(
      { text: "https://www.facebook.com/u/videos/778899 又貼一次" },
      deps(storage),
    );
    expect(r2.reply).toContain("已經收過了");
    expect((await storage.readAll()).length).toBe(1);
  });

  it("未知網域 fallback → 平台 unknown(不誤猜 instagram)", async () => {
    const storage = new MemoryStorage();
    await runCollect(
      { text: "https://random.com/p/whatever 測試" },
      deps(storage),
    );
    const row = (await storage.readAll())[0]!;
    expect(row.平台).toBe("unknown");
  });

  it("FB 轉址包住 IG reel → 解開後正確收成 instagram、連結=內層", async () => {
    const storage = new MemoryStorage();
    const inner = "https://www.instagram.com/reel/CxYz_-1";
    const wrapped = `https://l.facebook.com/l.php?u=${encodeURIComponent(inner)}&fbclid=abc`;
    await runCollect({ text: `${wrapped} 分享來的` }, deps(storage));
    const row = (await storage.readAll())[0]!;
    expect(row.平台).toBe("instagram");
    expect(row.連結).toBe(inner);
  });

  it("寫入失敗 → 回錯誤 + error 通知", async () => {
    const storage = new MemoryStorage();
    storage.append = async () => {
      throw new Error("sheet 寫入炸了");
    };
    const r = await runCollect(
      { text: "https://youtu.be/dQw4w9WgXcQ x" },
      deps(storage),
    );
    expect(r.reply).toContain("寫入失敗");
    expect(r.error).toContain("sheet 寫入炸了");
  });

  it("寫入失敗 → 觸發 onPersistError(drain 靠它停在 offset、不丟資料)", async () => {
    const storage = new MemoryStorage();
    storage.append = async () => {
      throw new Error("sheet 寫入炸了");
    };
    let persistFailed = false;
    const r = await runCollect(
      { text: "https://youtu.be/dQw4w9WgXcQ x" },
      { ...deps(storage), onPersistError: () => (persistFailed = true) },
    );
    expect(persistFailed).toBe(true); // drain 收得到「沒持久化」訊號
    expect(r.error).toBeDefined(); // 同時 contract 不變(仍回 error)
  });

  it("成功寫入 → 不觸發 onPersistError", async () => {
    const storage = new MemoryStorage();
    let persistFailed = false;
    await runCollect(
      { text: "https://youtu.be/dQw4w9WgXcQ x" },
      { ...deps(storage), onPersistError: () => (persistFailed = true) },
    );
    expect(persistFailed).toBe(false);
  });

  it("expandShortUrls: true + 注入 fake 展開器 → 展開後的網址才被清理/去重/寫入(不打網路)", async () => {
    const storage = new MemoryStorage();
    const short = "https://bit.ly/abc123";
    const full = "https://www.tiktok.com/@u/video/7234567890";
    let calledWith: string | undefined;
    const fakeExpand = async (url: string) => {
      calledWith = url;
      return url === short ? full : url;
    };
    const r = await runCollect(
      { text: `${short} 短鏈` },
      { storage, expandShortUrls: true, expandShortUrl: fakeExpand },
    );
    expect(r.error).toBeUndefined();
    expect(calledWith).toBe(short); // fake 被呼叫、真網路 HEAD 沒被打
    const all = await storage.readAll();
    expect(all).toHaveLength(1);
    const row = all[0]!;
    // 存進去的是「展開後」的真網址,平台由展開結果判定
    expect(row.連結).toBe(full);
    expect(row.平台).toBe("tiktok");

    // 展開後與既有同支影片去重收斂成一筆(dedupKey 走展開網址)
    const r2 = await runCollect(
      { text: "https://www.tiktok.com/@other/video/7234567890 又貼" },
      deps(storage),
    );
    expect(r2.reply).toContain("已經收過");
    expect(await storage.readAll()).toHaveLength(1);
  });
});
