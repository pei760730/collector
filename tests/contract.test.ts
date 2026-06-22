/**
 * 與 voc 對接契約的 drift-catcher(跨 repo)。
 *
 * 這份測試把「散文契約」(兩邊 CLAUDE.md §6)變成 CI 守的不變式:任何一方
 * 改欄名 / 改平台碼,這裡先紅,不會等到線上 sync 靜默漏資料才發現。
 *
 * 對手檔:voc `src/voc/sync.py`。下面的 VOC_* 常數是 voc 端現況的**鏡像**,
 * 改 voc 那邊要同步改這裡(故意手抄、不 import,因為跨語言 repo)。
 */
import { describe, it, expect } from "vitest";
import { STAGING_COLUMNS } from "../src/types.js";
import { detectPlatform } from "../src/pipeline/detectPlatform.js";

// voc sync.py 只按表頭名讀這 3 欄(build() 的 ci = {PLATFORM, CLEAN_URL, DATE})。
// 改名要兩 repo 一起改 —— 這裡擋的就是「只改單邊」。
const VOC_CONSUMED_COLUMNS = ["PLATFORM", "CLEAN_URL", "DATE"] as const;

// voc sync.py `_PLATFORM_MAP` 的 key(bot Platform 顯示名經 .lower() 後要落得進去)。
// voc `_norm_platform` 做 _PLATFORM_MAP.get(p.lower(), ...);CJK 平台 .lower() 是 no-op。
const VOC_PLATFORM_MAP_KEYS = new Set([
  "instagram",
  "tiktok",
  "youtube",
  "facebook",
  "x",
  "抖音",
  "小紅書",
  "threads",
]);

describe("voc 契約:暫存區欄名", () => {
  for (const col of VOC_CONSUMED_COLUMNS) {
    it(`暫存區表頭必須含 voc 消費的「${col}」欄`, () => {
      expect(STAGING_COLUMNS).toContain(col);
    });
  }
});

describe("voc 契約:bot 平台碼對得上 voc _PLATFORM_MAP", () => {
  // 每平台一個代表性連結 → bot 偵測出的 Platform 顯示名。
  // 涵蓋 bot RULES 全部 8 個平台(Unknown 不在契約內,voc 自我校正會接手)。
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
    it(`「${platform}」(${url}) 經 .lower() 後是 voc 認得的碼`, () => {
      expect(platform).not.toBe("Unknown");
      expect(VOC_PLATFORM_MAP_KEYS.has(platform.toLowerCase())).toBe(true);
    });
  }
});
