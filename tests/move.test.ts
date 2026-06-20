import { describe, it, expect } from "vitest";
import { runMove } from "../src/bot/handlers/move.js";
import { MemoryStorage } from "../src/storage/memory.js";
import type { StagingRow } from "../src/types.js";

function row(videoId: string, status = "active"): StagingRow {
  return {
    PLATFORM: "TikTok",
    VIDEO_REF: `https://x/${videoId}`,
    DATE: "2026/6/20",
    NOTE: "",
    CLEAN_URL: `https://x/${videoId}`,
    VIDEO_ID: videoId,
    SENDER: "Pei",
    STATUS: status,
  };
}

describe("runMove", () => {
  it("無參數 → 把所有 active 標成 moved", async () => {
    const s = new MemoryStorage([row("a"), row("b", "moved"), row("c")]);
    const msg = await runMove("", { storage: s });
    expect(msg).toContain("2");
    const all = await s.readAll();
    expect(all.map((r) => r.STATUS)).toEqual(["moved", "moved", "moved"]);
  });

  it("帶 VIDEO_ID → 只標那一筆", async () => {
    const s = new MemoryStorage([row("a"), row("b"), row("c")]);
    await runMove("b", { storage: s });
    const all = await s.readAll();
    expect(all.map((r) => r.STATUS)).toEqual(["active", "moved", "active"]);
  });

  it("沒有 active → 回提示,不動資料", async () => {
    const s = new MemoryStorage([row("a", "moved")]);
    const msg = await runMove("", { storage: s });
    expect(msg).toContain("沒有");
    expect((await s.readAll())[0]!.STATUS).toBe("moved");
  });
});
