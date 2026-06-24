/** 深挖:驗幾個可疑點。跑法:npx tsx scripts/audit-check.ts */
import { detectPlatform } from "../src/pipeline/detectPlatform.js";
import { extractVideoId } from "../src/pipeline/extractVideoId.js";
import { cleanUrl } from "../src/pipeline/cleanUrl.js";

console.log("--- A. detectPlatform 子字串誤判 ---");
for (const u of [
  "https://www.netflix.com/watch/81234567",
  "https://box.com/s/abc",
  "https://abcfb.com/x",
  "https://example.com/whatever",
]) {
  const r = detectPlatform(u);
  console.log(`${u}\n   → ${r.platform} (${r.confidence}/${r.method})`);
}

console.log("\n--- D. YouTube 抽到非影片 id(channel/@user)---");
for (const u of [
  "https://www.youtube.com/channel/UCabcdefghij",
  "https://www.youtube.com/@someusername11",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
]) {
  console.log(`${u} → ${extractVideoId("YouTube", u).videoId}`);
}

console.log("\n--- cleanUrl 非 ASCII / 編碼 ---");
for (const u of [
  "https://www.xiaohongshu.com/explore/abc?xsec_token=XYZ",
  "https://www.instagram.com/reel/CxYz/?igsh=abc==",
]) {
  console.log(`${u} → ${cleanUrl(u).cleanUrl}`);
}
