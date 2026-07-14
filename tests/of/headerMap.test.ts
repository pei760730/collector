/**
 * 表頭飄移防護(drift-catcher):暫存區 5 欄欄位對映改「依實際表頭具名解析」後,
 * 重排 / 前面多一欄 / 後面空欄 都不該把值寫到錯欄或整輪打掛;必要欄整個缺席才 fail-fast。
 * 對映用純函式,免 mock googleapis。
 */
import { describe, it, expect } from "vitest";
import { resolveHeaderIndexes, placeRow, readNamedRow } from "@pei760730/collector-core";
import { STAGING_COLUMNS } from "../../src/engines/of/types.js";

const CANONICAL = ["PLATFORM", "DATE", "CLEAN_URL", "VIDEO_ID", "STATUS"];

describe("resolveHeaderIndexes:暫存區依名解析", () => {
  it("正規 5 欄 → 索引照欄序", () => {
    const layout = resolveHeaderIndexes(CANONICAL, STAGING_COLUMNS, "暫存區");
    expect(layout.width).toBe(5);
    expect(layout.indexOf.PLATFORM).toBe(0);
    expect(layout.indexOf.STATUS).toBe(4);
  });

  it("重排 + 前置序號欄 → 仍對到正確具名欄", () => {
    const drift = ["序號", "CLEAN_URL", "PLATFORM", "VIDEO_ID", "DATE", "STATUS"];
    const layout = resolveHeaderIndexes(drift, STAGING_COLUMNS, "暫存區");
    expect(layout.indexOf.CLEAN_URL).toBe(1);
    expect(layout.indexOf.PLATFORM).toBe(2);
    expect(layout.indexOf.STATUS).toBe(5);
  });

  it("缺必要欄 → fail-fast", () => {
    expect(() => resolveHeaderIndexes(["PLATFORM", "DATE", "CLEAN_URL"], STAGING_COLUMNS, "暫存區")).toThrow(
      /VIDEO_ID|STATUS|缺少/,
    );
  });

  it("placeRow / readNamedRow 來回", () => {
    const layout = resolveHeaderIndexes(CANONICAL, STAGING_COLUMNS, "暫存區");
    const cells = placeRow(
      {
        PLATFORM: "TikTok",
        DATE: "2026/6/26",
        CLEAN_URL: "https://www.tiktok.com/@u/video/1",
        VIDEO_ID: "tt_1",
        STATUS: "pending_review",
      },
      STAGING_COLUMNS,
      layout,
    );
    expect(cells).toEqual(["TikTok", "2026/6/26", "https://www.tiktok.com/@u/video/1", "tt_1", "pending_review"]);
    expect(readNamedRow(cells, STAGING_COLUMNS, layout).VIDEO_ID).toBe("tt_1");
  });
});
