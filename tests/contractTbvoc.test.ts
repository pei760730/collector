/**
 * 與上游 TeaBus-VOC(tbvoc)引擎對接契約的 drift-catcher(port 自 clip-collector
 * tests/contract.test.ts)。對手檔 = vendored `contracts/tbvoc/schema.json`(上游 private,
 * 更新時重新 vendor,見 contracts/tbvoc/README.md)。
 * dedup 分群 conformance 與 voc 版共用同一份 core canonical,已由 tests/contract.test.ts 守,
 * 本檔不重複(同 dedupKey、同向量,雙跑無新訊號)。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLATFORM_CODE, type Platform } from "../src/types.js";
import { TBVOC_COLUMNS, TBVOC_HOT_VALUES } from "../src/targets.js";
import { detectPlatform } from "@pei760730/collector-core";

interface EngineSchema {
  schemaVersion: string;
  columns: string[];
  platformCodes: string[];
  hotValues: string[];
}

// vendored schema 過期偵測的最低門檻:上游 bump 了 schemaVersion 卻忘了重新 vendor 時,
// 這個常數會比 vendored copy 舊 → 斷言先紅。更新 vendored 檔時若上游真的 bump 版本,
// 這個常數要一起調上去(否則恆過、失去守門)。
const MIN_SCHEMA_VERSION = "1";

const schema: EngineSchema = JSON.parse(
  readFileSync(new URL("../contracts/tbvoc/schema.json", import.meta.url), "utf8"),
) as EngineSchema;

describe("tbvoc 契約:vendored schema 版本不落後", () => {
  it(`vendored schemaVersion(${schema.schemaVersion})>= 預期最低版本(${MIN_SCHEMA_VERSION})`, () => {
    expect(Number(schema.schemaVersion)).toBeGreaterThanOrEqual(Number(MIN_SCHEMA_VERSION));
  });
});

describe("tbvoc 契約:參考池欄名/順序", () => {
  it("tbvoc target 寫的參考池欄名/順序 == tbvoc schema.json columns", () => {
    expect(TBVOC_COLUMNS).toEqual(schema.columns);
  });

  it("夯度 必在最後一欄(init-sheet 只改表頭,插中間會錯位舊資料)", () => {
    expect(schema.columns[schema.columns.length - 1]).toBe("夯度");
    expect(TBVOC_COLUMNS[TBVOC_COLUMNS.length - 1]).toBe("夯度");
  });
});

describe("tbvoc 契約:夯度值集合", () => {
  it("inline 按鈕的 TBVOC_HOT_VALUES == tbvoc schema.json hotValues(值+順序)", () => {
    expect([...TBVOC_HOT_VALUES]).toEqual(schema.hotValues);
  });
});

describe("tbvoc 契約:bot 平台碼 ⊆ tbvoc 認得的小寫碼", () => {
  it("每個正式平台(非 Unknown)的碼都 ⊆ schema.platformCodes", () => {
    const allowed = new Set(schema.platformCodes);
    for (const p of Object.keys(PLATFORM_CODE) as Platform[]) {
      if (p === "Unknown") continue;
      expect(allowed.has(PLATFORM_CODE[p])).toBe(true);
    }
  });

  const samples: [string, string][] = [
    ["tiktok", "https://www.tiktok.com/@u/video/123"],
    ["youtube", "https://youtu.be/abcdefghijk"],
    ["facebook", "https://www.facebook.com/watch?v=1"],
    ["instagram", "https://www.instagram.com/reel/abc"],
    ["threads", "https://www.threads.net/@u/post/DZwtc9Jk7Yf"],
    ["x", "https://x.com/a/status/1"],
    ["douyin", "https://www.douyin.com/video/123"],
    ["xiaohongshu", "https://www.xiaohongshu.com/explore/abc123"],
  ];
  const allowed = new Set(schema.platformCodes);
  for (const [code, url] of samples) {
    it(`${url} → 偵測非 Unknown、碼=${code} 且 ⊆ 契約`, () => {
      const platform = detectPlatform(url).platform;
      expect(platform).not.toBe("Unknown");
      expect(PLATFORM_CODE[platform]).toBe(code);
      expect(allowed.has(code)).toBe(true);
    });
  }
});
