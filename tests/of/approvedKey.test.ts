/**
 * 擋回流閘門比對鍵(approvedGateKey)的單元契約。
 *
 * 這支函式是閘門的**單一來源**:建集合(總表歷史列)與查詢(新進連結)兩側都走它。
 * 本檔釘的是它自己的性質;端到端行為在 tests/of/approvedGate.test.ts。
 */
import { describe, expect, it } from "vitest";

import { approvedGateKey } from "../../src/engines/of/storage/approvedKey.js";

describe("approvedGateKey", () => {
  it("空字串 / 純空白 → 空鍵(介面契約:視為無命中)", () => {
    expect(approvedGateKey("")).toBe("");
    expect(approvedGateKey("   ")).toBe("");
    expect(approvedGateKey("\t\n ")).toBe("");
  });

  it("同一支片的各種形態收斂成同一把鍵", () => {
    const k = approvedGateKey("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(k).toBe("yt_dqw4w9wgxcq");
    for (const form of [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&utm_source=ig",
      "  https://youtu.be/dQw4w9WgXcQ  ",
    ]) {
      expect(approvedGateKey(form), form).toBe(k);
    }
  });

  it("不同片不同鍵", () => {
    expect(approvedGateKey("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).not.toBe(
      approvedGateKey("https://www.youtube.com/watch?v=AAAAAAAAAAA"),
    );
  });

  it("抽不到 id → 路徑 key,且**以 http 開頭**", () => {
    // 閘門的安全性建立在這條不變式上:閘門只在抽得到 id 時才被查(鍵是 `平台_id`),
    // 而路徑 key 以 http 開頭 → 歷史列即使算出路徑 key 也永遠不可能等於查詢用的 id key,
    // 所以 groupKey 路徑 fallback 會砍 query 這件事不會造成過度攔截。
    const pathKey = approvedGateKey("https://example.com/some/page?a=1");
    expect(pathKey.startsWith("http")).toBe(true);
    expect(approvedGateKey("https://www.youtube.com/watch?v=dQw4w9WgXcQ").startsWith("http")).toBe(
      false,
    );
  });
});
