/**
 * 與 voc 對接契約的 drift-catcher(跨 repo,conformance)。
 *
 * 2026-06-26:從「手抄鏡像常數」升級成「載入 voc 發布的契約檔跑 conformance」。
 * 對手檔 = voc `contracts/schema.json` + `contracts/dedup_vectors.json`(由 voc schema.py +
 * normalize.py codegen),vendored 到 `contracts/voc/`(voc 是 private repo,svb public 無法跨 repo 抓;
 * voc 契約更新時重新 vendor —— 見 contracts/voc/README.md)。
 *
 * 驗三件:
 *  1. 參考池欄名/順序 == schema.columns
 *  2. bot 寫入的平台碼(非 Unknown)⊆ schema.platformCodes
 *  3. dedup 分群等價:bot groupKey 對 dedup_vectors 的 same_group 收斂、distinct 分開
 *     (跨語言契約的 TS 側;Python 側由 voc test_dedup_contract 守)。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { dedupKey } from "../src/pipeline/index.js";
import { detectPlatform } from "@pei760730/collector-core";
import { PLATFORM_CODE, POOL_COLUMNS, type Platform } from "../src/types.js";

interface EngineSchema {
  columns: string[];
  platformCodes: string[];
}
interface DedupVectors {
  same_group: { name: string; urls: string[] }[];
  distinct: { name: string; urls: string[] }[];
  edge_cases: { name: string; why: string; url: string; expect: "id" | "path" }[];
}

// schema.json 仍 vendored 在 contracts/voc/(由 voc schema.py codegen、core 不持有此檔)。
const load = <T>(rel: string): T =>
  JSON.parse(readFileSync(new URL(`../contracts/voc/${rel}`, import.meta.url), "utf8")) as T;

// dedup_vectors.json 改讀 @pei760730/collector-core 隨包發布的 canonical(core 是 TS pipeline SSOT,
// dedupKey 即 core groupKey,經 dep pin)。不再在本 repo vendor 這份;改去重規則 → 先改 core canonical → bump core tag。
const _vectorsPath = createRequire(import.meta.url).resolve(
  "@pei760730/collector-core/contracts/voc/dedup_vectors.json",
);

const schema = load<EngineSchema>("schema.json");
const vectors = JSON.parse(readFileSync(_vectorsPath, "utf8")) as DedupVectors;

describe("voc 契約:參考池 schema", () => {
  it("bot 寫的參考池欄名/順序 == voc schema.json columns", () => {
    expect(POOL_COLUMNS).toEqual(schema.columns);
  });

  it("bot 每個正式平台(非 Unknown)的碼都 ⊆ schema.platformCodes", () => {
    const allowed = new Set(schema.platformCodes);
    for (const p of Object.keys(PLATFORM_CODE) as Platform[]) {
      if (p === "Unknown") continue; // Unknown→"unknown" 是 fallback,不在引擎平台碼集合內
      expect(allowed.has(PLATFORM_CODE[p])).toBe(true);
    }
  });

  // 每平台一個代表性連結 → 偵測得出非 Unknown 平台(host 規則沒漏)。
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
  for (const [code, url] of samples) {
    it(`${url} → 偵測非 Unknown、碼=${code}`, () => {
      const platform = detectPlatform(url).platform;
      expect(platform).not.toBe("Unknown");
      expect(PLATFORM_CODE[platform]).toBe(code);
    });
  }
});

const isPathKey = (k: string) => k.startsWith("http");

describe("voc 契約:dedup 分群等價(TS groupKey 對 voc dedup_vectors)", () => {
  for (const g of vectors.same_group) {
    it(`same_group「${g.name}」收斂同一 key`, () => {
      const keys = new Set(g.urls.map(dedupKey));
      expect(keys.size).toBe(1);
    });
  }

  for (const g of vectors.distinct) {
    it(`distinct「${g.name}」互不同 key`, () => {
      const keys = g.urls.map(dedupKey);
      expect(new Set(keys).size).toBe(keys.length);
    });
  }

  // 2026-06-27 起所有 edge_case 兩語一致(裸 19 碼抽取已砍除,vt.tiktok 短路徑 TS 與 Python 都退路徑),
  // 不再有「靠展開消弭」的 TS/Python 分歧 → 全部都驗(無 skip)。
  for (const e of vectors.edge_cases) {
    it(`edge「${e.name}」TS groupKey 為 ${e.expect}`, () => {
      const got = isPathKey(dedupKey(e.url)) ? "path" : "id";
      expect(got).toBe(e.expect);
    });
  }
});
