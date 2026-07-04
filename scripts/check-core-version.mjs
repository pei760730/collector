// CI 守門:package.json 宣稱的 collector-core git tag 版本,必須等於實際安裝到的版本。
//
// 為什麼需要:npm ci 對 git dep 只比對 spec 字串,不驗 lock 的 resolved commit
// 是否真的對應那個 tag。spec 改了、lock 沒重生 → CI 綠著裝舊版(PR #49 實案:
// 宣稱 v0.2.2,生產默默跑 v0.2.1)。這一步讓「宣稱 == 實裝」恆真。
// 三支 collector(short-video-bot / clip-collector / feed-collector)共用同款。
import { readFileSync } from "node:fs";

const DEP = "@pei760730/collector-core";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const spec = (pkg.dependencies ?? {})[DEP] ?? "";
const m = spec.match(/#v(.+)$/);
if (!m) {
  console.log(`[check-core-version] ${DEP} spec "${spec}" 非 git tag 形態,略過`);
  process.exit(0);
}
const claimed = m[1];
const installed = JSON.parse(
  readFileSync(`node_modules/${DEP}/package.json`, "utf8"),
).version;
if (installed !== claimed) {
  console.error(
    `[check-core-version] 宣稱 v${claimed} != 實裝 v${installed} —— ` +
      `package-lock.json 的 resolved 沒跟上 tag,重生/修正 lock 該條目再來。`,
  );
  process.exit(1);
}
console.log(`[check-core-version] OK:宣稱 == 實裝 == v${installed}`);
