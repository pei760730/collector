/**
 * runCollect(tbvoc target)—— port 自 clip-collector tests/collect.test.ts。
 * 鎖住 tbvoc 專屬行為:5 欄(含夯度留空)、hotKey 回傳、活潑版文案(「超過上限的部分已剪掉」)。
 * voc 版行為由 tests/collect.test.ts(預設 target)鎖住,文案互斥、不能共用斷言。
 */
import { describe, it, expect } from "vitest";
import { runCollect } from "../src/bot/handlers/collect.js";
import { MemoryStorage } from "../src/storage/memory.js";
import { todayIsoTaipei } from "../src/utils/date.js";
import { TBVOC_TARGET } from "../src/targets.js";
import type { RefRow } from "../src/types.js";

function deps(storage: MemoryStorage) {
  return { storage, expandShortUrls: false, target: TBVOC_TARGET };
}

describe("runCollect(tbvoc)", () => {
  it("合法連結 → 寫入參考池(5 欄、平台小寫、夯度留空)+ 成功訊息 + hotKey", async () => {
    const storage = new MemoryStorage();
    const r = await runCollect(
      { text: "https://www.tiktok.com/@u/video/7234567890 好笑" },
      deps(storage),
    );
    expect(r.error).toBeUndefined();
    expect(r.reply).toContain("已收進參考池");
    expect(r.reply).toContain("好笑"); // 備註顯示在回覆(不存表)
    expect(r.reply).toContain("標個夯度"); // tbvoc 版尾行
    const all = await storage.readAll();
    expect(all).toHaveLength(1);
    const row = all[0]!;
    expect(Object.keys(row)).toEqual(["平台", "連結", "挑", "加入日期", "夯度"]);
    expect(row.平台).toBe("tiktok");
    expect(row.連結).toBe("https://www.tiktok.com/@u/video/7234567890");
    expect(row.挑).toBe("");
    expect(row.加入日期).toBe(todayIsoTaipei());
    expect(row.夯度).toBe(""); // 收錄時留空,等分享者點按鈕
    expect(r.hotKey).toBeTruthy(); // 帶 key 讓 router 掛夯度按鈕
  });

  it("同連結重複 → 不寫第二筆,且仍帶 hotKey(已收過也能重標)", async () => {
    const storage = new MemoryStorage();
    const msg = { text: "https://youtu.be/dQw4w9WgXcQ 影片" };
    await runCollect(msg, deps(storage));
    const r2 = await runCollect(msg, deps(storage));
    expect(r2.reply).toContain("已經收過");
    expect(r2.hotKey).toBeTruthy();
    expect(await storage.readAll()).toHaveLength(1);
  });

  it("既有 5 欄列已在參考池 → 同連結視為重複,不重寫", async () => {
    const seed: RefRow = {
      平台: "youtube",
      連結: "https://youtu.be/dQw4w9WgXcQ",
      挑: "",
      加入日期: "2025-01-01",
      夯度: "",
    };
    const storage = new MemoryStorage([seed]);
    const r = await runCollect({ text: "https://youtu.be/dQw4w9WgXcQ 又貼一次" }, deps(storage));
    expect(r.reply).toContain("已經收過");
    expect(await storage.readAll()).toHaveLength(1);
  });

  it("看不懂 / 寫入失敗 → 不帶 hotKey(不掛按鈕)", async () => {
    const storage = new MemoryStorage();
    const r1 = await runCollect({ text: "亂打一通" }, deps(storage));
    expect(r1.hotKey).toBeUndefined();
    storage.append = async () => {
      throw new Error("sheet 寫入炸了");
    };
    const r2 = await runCollect({ text: "https://youtu.be/dQw4w9WgXcQ x" }, deps(storage));
    expect(r2.reply).toContain("寫入失敗");
    expect(r2.hotKey).toBeUndefined();
  });

  it("expandShortUrls:true + 注入 fake 展開器 → 收「展開後」網址、hotKey 含影片 id", async () => {
    const storage = new MemoryStorage();
    const shortUrl = "https://vt.tiktok.com/ZSabc123";
    const fullUrl = "https://www.tiktok.com/@u/video/7234567890";
    let called = "";
    const r = await runCollect(
      { text: `${shortUrl} 短鏈分享` },
      {
        storage,
        expandShortUrls: true,
        target: TBVOC_TARGET,
        expandShortUrl: async (url) => {
          called = url;
          return url === shortUrl ? fullUrl : url;
        },
      },
    );
    expect(called).toBe(shortUrl);
    expect(r.error).toBeUndefined();
    const row = (await storage.readAll())[0]!;
    expect(row.連結).toBe(fullUrl);
    expect(r.hotKey).toContain("tiktok_7234567890");
  });

  it("備註超長(>2000)被 core 截斷 → tbvoc 版截斷文案「超過上限的部分已剪掉」", async () => {
    const storage = new MemoryStorage();
    const longNote = "笑".repeat(2100);
    const r = await runCollect({ text: `https://youtu.be/dQw4w9WgXcQ ${longNote}` }, deps(storage));
    expect(r.error).toBeUndefined();
    expect(r.reply).toContain("已收進參考池");
    expect(r.reply).toContain("超過上限的部分已剪掉"); // clip 既有文案,與 voc 版「已截斷收錄」互斥
    expect(await storage.readAll()).toHaveLength(1);
  });

  it("正常長度訊息 → 不出現截斷提示", async () => {
    const storage = new MemoryStorage();
    const r = await runCollect({ text: "https://youtu.be/dQw4w9WgXcQ 正常備註" }, deps(storage));
    expect(r.reply).toContain("已收進參考池");
    expect(r.reply).not.toContain("剪掉");
  });
});
