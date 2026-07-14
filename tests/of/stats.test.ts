import { describe, it, expect } from "vitest";
import { computeStats } from "../../src/engines/of/storage/computeStats.js";
import { runStats } from "../../src/engines/of/bot/handlers/stats.js";
import { MemoryStorage } from "../../src/engines/of/storage/memory.js";
import { todayTaipei } from "../../src/engines/of/utils/date.js";
import type { StagingRow } from "../../src/engines/of/types.js";

const NOW = 1_750_000_000_000; // 固定注入時間
const TODAY = todayTaipei(NOW);

function row(p: string, videoId: string, status: string, date: string): StagingRow {
  return {
    PLATFORM: p,
    DATE: date,
    CLEAN_URL: `https://x/${videoId}`,
    VIDEO_ID: videoId,
    STATUS: status,
  };
}

const SEED: StagingRow[] = [
  row("Instagram", "ig_a", "pending_review", TODAY),
  row("Instagram", "ig_b", "pending_review", TODAY),
  row("TikTok", "tt_c", "unsupported", "2020/1/1"), // 很舊 → 不計入本週/本月
];

describe("computeStats — 純函式彙總", () => {
  it("total / byPlatform / byStatus 正確", () => {
    const s = computeStats(SEED, { recentLimit: 5, nowMs: NOW });
    expect(s.total).toBe(3);
    expect(s.byPlatform).toEqual({ Instagram: 2, TikTok: 1 });
    expect(s.byStatus).toEqual({ pending_review: 2, unsupported: 1 });
  });

  it("本週/本月只算窗內;DATE 壞掉/過舊不計入", () => {
    const s = computeStats(SEED, { recentLimit: 5, nowMs: NOW });
    expect(s.addedThisWeek).toBe(2); // 兩筆今天
    expect(s.addedThisMonth).toBe(2);
  });

  it("recent 由新到舊(append 在尾端)", () => {
    const s = computeStats(SEED, { recentLimit: 2, nowMs: NOW });
    expect(s.recent.map((r) => r.VIDEO_ID)).toEqual(["tt_c", "ig_b"]);
  });

  it("空資料 → total 0、recent 空", () => {
    const s = computeStats([], { recentLimit: 5, nowMs: NOW });
    expect(s.total).toBe(0);
    expect(s.recent).toHaveLength(0);
  });
});

describe("runStats — 訊息格式", () => {
  it("空暫存區 → 回空的提示", async () => {
    const reply = await runStats({ storage: new MemoryStorage(), now: () => NOW });
    expect(reply).toContain("空的");
  });

  it("有資料 → 含總筆數 / 平台 / 狀態 / 最近筆", async () => {
    const reply = await runStats({
      storage: new MemoryStorage(SEED),
      now: () => NOW,
    });
    expect(reply).toContain("共 3 筆");
    expect(reply).toContain("Instagram:2");
    expect(reply).toContain("pending_review:2");
    expect(reply).toContain("ig_b"); // 最近筆有列出
  });

  it("Other 桶(不在 core PLATFORM_ICON)最近筆退回 🔗 圖示", async () => {
    const reply = await runStats({
      storage: new MemoryStorage([row("Other", "raw_x", "unsupported", TODAY)]),
      now: () => NOW,
    });
    expect(reply).toContain("🔗 raw_x");
    expect(reply).not.toContain("• raw_x"); // v0.3.0 退回 "•" 的回歸防護
  });
});
