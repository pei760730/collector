import { describe, it, expect } from "vitest";
import { parseMessage, NoUrlError } from "../src/pipeline/parse.js";

describe("parseMessage", () => {
  it("抽出網址與備註", () => {
    const r = parseMessage({
      text: "https://www.tiktok.com/@u/video/123 健身梗很好笑",
    });
    expect(r.rawUrl).toBe("https://www.tiktok.com/@u/video/123");
    expect(r.note).toBe("健身梗很好笑");
  });

  it("備註在前、網址在後也能抽", () => {
    const r = parseMessage({ text: "好笑 https://youtu.be/abc" });
    expect(r.rawUrl).toBe("https://youtu.be/abc");
    expect(r.note).toBe("好笑");
  });

  it("沒網址丟 NoUrlError", () => {
    expect(() => parseMessage({ text: "今天天氣真好" })).toThrow(NoUrlError);
  });

  it("連結後黏中文(沒空格)→ 不吃進 URL", () => {
    const r = parseMessage({ text: "https://youtu.be/dQw4w9WgXcQ。很好笑" });
    expect(r.rawUrl).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(r.note).toContain("很好笑");
  });

  it("剝掉尾端標點", () => {
    expect(parseMessage({ text: "看 https://x.com/a/status/1)" }).rawUrl).toBe(
      "https://x.com/a/status/1",
    );
    expect(parseMessage({ text: "https://x.com/a/status/1, lol" }).rawUrl).toBe(
      "https://x.com/a/status/1",
    );
  });

  it("https:// 後面全是標點 → 視為沒網址", () => {
    expect(() => parseMessage({ text: "https://。。。" })).toThrow(NoUrlError);
  });

  it("連結直接黏 CJK 備註 → 備註不留開頭分隔標點", () => {
    const r = parseMessage({ text: "https://youtu.be/dQw4w9WgXcQ。健身梗" });
    expect(r.rawUrl).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(r.note).toBe("健身梗"); // 不再是「。健身梗」
  });

  it("連結被括號包住 → 備註不留殘餘括號", () => {
    const r = parseMessage({ text: "(https://youtu.be/dQw4w9WgXcQ)" });
    expect(r.rawUrl).toBe("https://youtu.be/dQw4w9WgXcQ");
    expect(r.note).toBe("");
  });

  it("備註結尾語氣標點要保留", () => {
    const r = parseMessage({ text: "https://youtu.be/dQw4w9WgXcQ 太好笑了!" });
    expect(r.note).toBe("太好笑了!");
  });

  it("備註裡含與 URL 相同片段不被誤切", () => {
    const r = parseMessage({ text: "看 https://x.com/a 這個 x.com 帳號" });
    expect(r.rawUrl).toBe("https://x.com/a");
    expect(r.note).toBe("看 這個 x.com 帳號");
  });
});
