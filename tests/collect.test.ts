import { describe, it, expect } from "vitest";
import { runCollect } from "../src/bot/handlers/collect.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { todayTaipei } from "../src/utils/date.js";
import type { StagingRow } from "../src/types.js";

function deps(storage: MemoryStorage, dedupePeriodDays = 180) {
  return { storage, dedupePeriodDays, expandShortUrls: false };
}

describe("runCollect", () => {
  it("合法連結 → 寫入 + 成功訊息", async () => {
    const storage = new MemoryStorage();
    const r = await runCollect(
      { text: "https://www.tiktok.com/@u/video/7234567890 好笑", senderName: "Pei" },
      deps(storage),
    );
    expect(r.error).toBeUndefined();
    expect(r.reply).toContain("已收進暫存區");
    const all = await storage.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.VIDEO_ID).toBe("tiktok_7234567890");
    expect(all[0]!.NOTE).toBe("好笑");
    expect(all[0]!.STATUS).toBe("active");
  });

  it("N 天內重複 → 不寫第二筆", async () => {
    const storage = new MemoryStorage();
    const msg = { text: "https://youtu.be/dQw4w9WgXcQ 影片", senderName: "Pei" };
    await runCollect(msg, deps(storage));
    const r2 = await runCollect(msg, deps(storage));
    expect(r2.reply).toContain("已經收過");
    expect(await storage.readAll()).toHaveLength(1);
  });

  it("超出去重窗 → 視為新筆", async () => {
    const old: StagingRow = {
      PLATFORM: "YouTube",
      VIDEO_REF: "https://youtu.be/dQw4w9WgXcQ",
      DATE: "2020/1/1",
      NOTE: "舊的",
      CLEAN_URL: "https://youtu.be/dQw4w9WgXcQ",
      VIDEO_ID: "yt_dQw4w9WgXcQ",
      SENDER: "Pei",
      STATUS: "active",
    };
    const storage = new MemoryStorage([old]);
    const r = await runCollect(
      { text: "https://youtu.be/dQw4w9WgXcQ 新的", senderName: "Pei" },
      deps(storage, 180),
    );
    expect(r.reply).toContain("已收進暫存區");
    expect(await storage.readAll()).toHaveLength(2);
  });

  it("DATE 壞掉(解析不出)的同 VIDEO_ID 仍當重複,不重寫", async () => {
    const broken: StagingRow = {
      PLATFORM: "YouTube",
      VIDEO_REF: "https://youtu.be/dQw4w9WgXcQ",
      DATE: "壞掉的日期",
      NOTE: "舊的",
      CLEAN_URL: "https://youtu.be/dQw4w9WgXcQ",
      VIDEO_ID: "yt_dQw4w9WgXcQ",
      SENDER: "Pei",
      STATUS: "active",
    };
    const storage = new MemoryStorage([broken]);
    const r = await runCollect(
      { text: "https://youtu.be/dQw4w9WgXcQ 又貼一次", senderName: "Pei" },
      deps(storage, 180),
    );
    expect(r.reply).toContain("已經收過");
    expect(await storage.readAll()).toHaveLength(1);
  });

  it("無網址 → 格式錯誤提示", async () => {
    const storage = new MemoryStorage();
    const r = await runCollect({ text: "亂打一通", senderName: "Pei" }, deps(storage));
    expect(r.reply).toContain("看不懂");
    expect(await storage.readAll()).toHaveLength(0);
  });

  it("帶追蹤參數的行動版網址 → 清理後寫入", async () => {
    const storage = new MemoryStorage();
    await runCollect(
      {
        text: "https://m.tiktok.com/@u/video/7234567890?utm_source=ig&fbclid=x note",
        senderName: "Pei",
      },
      deps(storage),
    );
    const row = (await storage.readAll())[0]!;
    expect(row.CLEAN_URL).toContain("www.tiktok.com");
    expect(row.CLEAN_URL).not.toContain("utm_source");
    expect(row.CLEAN_URL).not.toContain("fbclid");
  });

  it("不支援平台(FB)→ unknown 但仍寫入", async () => {
    const storage = new MemoryStorage();
    const r = await runCollect(
      { text: "https://fb.watch/abc note", senderName: "Pei" },
      deps(storage),
    );
    expect(r.reply).toContain("已收進暫存區");
    const row = (await storage.readAll())[0]!;
    expect(row.VIDEO_ID).toMatch(/^unknown_/);
    expect(row.PLATFORM).toBe("Facebook");
  });

  it("未知網域 fallback → 不造假 ig_ id(標 unknown)", async () => {
    const storage = new MemoryStorage();
    await runCollect(
      { text: "https://random.com/p/whatever 測試", senderName: "Pei" },
      deps(storage),
    );
    const row = (await storage.readAll())[0]!;
    expect(row.VIDEO_ID).toMatch(/^unknown_/);
    expect(row.VIDEO_ID).not.toMatch(/^ig_/);
  });

  it("寫入失敗 → 回錯誤 + error 通知", async () => {
    const storage = new MemoryStorage();
    storage.append = async () => {
      throw new Error("sheet 寫入炸了");
    };
    const r = await runCollect(
      { text: "https://youtu.be/dQw4w9WgXcQ x", senderName: "Pei" },
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
      { text: "https://youtu.be/dQw4w9WgXcQ x", senderName: "Pei" },
      { ...deps(storage), onPersistError: () => (persistFailed = true) },
    );
    expect(persistFailed).toBe(true); // drain 收得到「沒持久化」訊號
    expect(r.error).toBeDefined(); // 同時 contract 不變(仍回 error)
  });

  it("成功寫入 → 不觸發 onPersistError", async () => {
    const storage = new MemoryStorage();
    let persistFailed = false;
    await runCollect(
      { text: "https://youtu.be/dQw4w9WgXcQ x", senderName: "Pei" },
      { ...deps(storage), onPersistError: () => (persistFailed = true) },
    );
    expect(persistFailed).toBe(false);
  });

  it("DATE 寫今天(台北)", async () => {
    const storage = new MemoryStorage();
    await runCollect(
      { text: "https://youtu.be/dQw4w9WgXcQ x", senderName: "Pei" },
      deps(storage),
    );
    expect((await storage.readAll())[0]!.DATE).toBe(todayTaipei());
  });
});
