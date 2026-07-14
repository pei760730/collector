/**
 * 跨語言去重契約 conformance(feed 側,模型翻譯版)。
 *
 * feed 是 staging 模型、抽取規則自成一份:`tt_` 前綴、抽不到 → `raw_<ts>`(unsupported、不去重),
 * 與 collector-core 的 groupKey(抽不到退「連結路徑 key」)模型不同。本檔對 voc canonical
 * `contracts/voc/dedup_vectors.json` 做**模型翻譯**後 conformance,釘住「feed 抽取對 voc 的
 * 分群意圖不漂移」——任何人改 feed extractVideoId 而與 canonical 分叉,這裡先紅。
 *
 *   翻譯:feed 的 `unsupported`(raw_) ⟺ canonical 的 `path`(都是「抽不到 id、不靠 id 收斂」)。
 *   抖音:2026-07-06 feed 已接抖音(extractVideoId 映 `dy_`),抖音向量不再 skip、實跑守門
 *   (見下方 describe 前註;舊「feed 不支援抖音、same_group skip」例外已失效)。
 *
 * 對手檔 = canonical `@pei760730/collector-core` 隨包發布的 contracts/voc/dedup_vectors.json
 * (core 是 TS pipeline SSOT;tbvoc/sv-bot/clip 共跑同一份)。改去重規則 → 先改 core canonical → bump core tag。
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extractVideoId } from "../../src/engines/of/pipeline/extractVideoId.js";

interface DedupVectors {
  same_group: { name: string; urls: string[] }[];
  distinct: { name: string; urls: string[] }[];
  edge_cases: { name: string; why: string; url: string; expect: "id" | "path" }[];
}

// canonical 去重向量 = @pei760730/collector-core 隨包發布的 contracts/voc/dedup_vectors.json
// (core 是 TS pipeline SSOT)。不再 vendor 進本 repo;改去重規則 → 先改 core canonical → bump core tag。
const _vectorsPath = createRequire(import.meta.url).resolve(
  "@pei760730/collector-core/contracts/voc/dedup_vectors.json",
);
const vectors: DedupVectors = JSON.parse(readFileSync(_vectorsPath, "utf8"));

const FIXED = () => 1_700_000_000_000; // 固定時戳:讓 unsupported 的 raw_<ts> 在同組內可比較

/** feed 去重身分:抽得到 → videoId(帶平台前綴);抽不到(unsupported)→ "PATH"(對應 canonical path)。 */
const feedKey = (url: string): string => {
  const r = extractVideoId(url, FIXED);
  return r.unsupported ? "PATH" : r.videoId;
};

// 2026-07-06 feed 已接抖音(extractVideoId 映 dy_),抖音向量不再 skip、實跑守門。
describe("voc 去重契約(feed 模型):same_group 收斂同一 key", () => {
  for (const g of vectors.same_group) {
    it(`「${g.name}」`, () => {
      const keys = new Set(g.urls.map(feedKey));
      expect(keys.size).toBe(1);
      // 真正收斂(抽到 id),而非「全部 unsupported 湊巧相等」。
      expect([...keys][0]).not.toBe("PATH");
    });
  }
});

describe("voc 去重契約(feed 模型):distinct 互不同 key", () => {
  for (const g of vectors.distinct) {
    it(`「${g.name}」`, () => {
      const keys = g.urls.map(feedKey);
      expect(new Set(keys).size).toBe(keys.length);
    });
  }
});

describe("voc 去重契約(feed 模型):edge_cases id/path(path ⟺ feed unsupported)", () => {
  for (const e of vectors.edge_cases) {
    it(`「${e.name}」→ ${e.expect}`, () => {
      const got = feedKey(e.url) === "PATH" ? "path" : "id";
      expect(got).toBe(e.expect);
    });
  }
});
