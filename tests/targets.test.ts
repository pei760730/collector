/**
 * isOfTarget —— of 委派判定(drain.ts / index.ts 兩個 entry 共用的唯一判定點)。
 * 釘住 trim + lowercase 正規化:殼內 enumEnv(core)容忍前後空白,委派判定若比 raw env,
 * "of "(尾空白)/"OF"(大寫)會漏委派、落殼後 enumEnv 丟「只能是 voc/tbvoc」誤導排查。
 */
import { describe, it, expect } from "vitest";
import { isOfTarget } from "../src/targets.js";

describe("isOfTarget — of 委派判定(trim + lowercase)", () => {
  it('"of" → 委派', () => {
    expect(isOfTarget("of")).toBe(true);
  });

  it('"of "(尾空白)→ 委派(enumEnv 容忍空白,委派判定也要)', () => {
    expect(isOfTarget("of ")).toBe(true);
  });

  it('"OF"(大寫變體)→ 委派(修 raw 比對漏大寫的誤導)', () => {
    expect(isOfTarget("OF")).toBe(true);
  });

  it('"voc" → 不委派(走殼)', () => {
    expect(isOfTarget("voc")).toBe(false);
  });

  it("未帶參數且 env 未設 → 預設 voc,不委派", () => {
    delete process.env.COLLECTOR_TARGET;
    expect(isOfTarget()).toBe(false);
  });
});
