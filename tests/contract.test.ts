/**
 * 與 voc 對接契約的 drift-catcher(跨 repo)。
 *
 * 這份測試把「散文契約」(兩邊 CLAUDE.md §6)變成 CI 守的不變式:任何一方
 * 改欄名 / 改平台碼,這裡先紅,不會等到線上靜默漏資料才發現。
 *
 * 對手檔:voc `src/voc/schema.py`(REFS)+ `src/voc/normalize.py`(平台碼)。
 * 下面的 VOC_* 常數是 voc 端現況的**鏡像**,改 voc 那邊要同步改這裡
 * (故意手抄、不 import,因為跨語言 repo)。
 *
 * 2026-06-22:bot 改成直接寫 voc「參考池」(廢「暫存區」中間層),契約對象從
 * 「暫存區欄名 + voc sync._PLATFORM_MAP」改為「參考池欄名 + voc 小寫平台碼」。
 */
import { describe, it, expect } from "vitest";
import { POOL_COLUMNS, PLATFORM_CODE, type Platform } from "../src/types.js";
import { detectPlatform } from "../src/pipeline/detectPlatform.js";

// voc schema.REFS.columns(參考池表頭,順序也要對上 —— bot append 用固定欄序硬塞)。
// 2026-06-24:砍掉 id(4 欄)。
const VOC_REFS_COLUMNS = ["平台", "連結", "挑", "加入日期"] as const;

// voc 全系統認得的小寫平台碼(normalize.parse_url 產出的平台 + 參考池慣例)。
const VOC_PLATFORM_CODES = new Set([
  "instagram",
  "youtube",
  "tiktok",
  "xiaohongshu",
  "threads",
  "facebook",
  "x",
  "douyin",
]);

describe("voc 契約:參考池欄名/順序", () => {
  it("bot 寫的參考池 4 欄必須與 voc schema.REFS 完全對上(含順序)", () => {
    expect(POOL_COLUMNS).toEqual([...VOC_REFS_COLUMNS]);
  });
});

describe("voc 契約:bot 平台碼是 voc 認得的小寫碼", () => {
  // 每平台一個代表性連結 → bot 偵測 → PLATFORM_CODE 小寫碼,要落在 voc 認得的集合。
  // 涵蓋 bot RULES 全部 8 個平台(Unknown 不在契約內 → 落 "unknown")。
  const samples: string[] = [
    "https://www.tiktok.com/@u/video/123",
    "https://youtu.be/abcdefghijk",
    "https://www.facebook.com/watch?v=1",
    "https://www.instagram.com/reel/abc",
    "https://www.threads.net/@u/post/DZwtc9Jk7Yf",
    "https://x.com/a/status/1",
    "https://www.douyin.com/video/123",
    "https://www.xiaohongshu.com/explore/abc",
  ];

  for (const url of samples) {
    const platform = detectPlatform(url).platform;
    const code = PLATFORM_CODE[platform];
    it(`「${platform}」(${url}) → 碼「${code}」是 voc 認得的`, () => {
      expect(platform).not.toBe("Unknown");
      expect(VOC_PLATFORM_CODES.has(code)).toBe(true);
    });
  }

  it("每個正式平台(非 Unknown)的碼都是 voc 認得的小寫碼", () => {
    for (const p of Object.keys(PLATFORM_CODE) as Platform[]) {
      if (p === "Unknown") continue;
      expect(VOC_PLATFORM_CODES.has(PLATFORM_CODE[p])).toBe(true);
    }
  });
});
