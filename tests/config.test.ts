/**
 * chat id 白名單嚴格解析:白名單是公開 repo 的防灌池閘門,打錯一項就該紅燈,
 * 不能靠 Number() 把 "1e5"/"0x10"/"12.0" 這種寫法默默吞成「看起來合法」的錯 id
 * (白名單靜默失準,以為有保護其實開了)。用 /^-?\d+$/ 只認純十進位整數。
 * 嚴格 regex 原產於本 repo round-1 #58,後上移 collector-core(chatIdsEnv);
 * 本測釘住 core 行為不漂移,與 clip-collector tests/config.test.ts 同組守則、兩邊行為需一致。
 */
import { describe, it, expect, afterEach } from "vitest";
import { chatIdsEnv } from "../src/config.js";

const KEY = "TEST_CHAT_IDS_STRICT";

afterEach(() => {
  delete process.env[KEY];
});

function parse(raw: string): number[] {
  process.env[KEY] = raw;
  return chatIdsEnv(KEY);
}

describe("chatIdsEnv:嚴格純整數解析", () => {
  it("純十進位整數(含負號)通過", () => {
    expect(parse("123")).toEqual([123]);
    expect(parse("-100")).toEqual([-100]);
    expect(parse("123,-100, 456 ")).toEqual([123, -100, 456]);
  });

  it("未設 / 空字串 → 空陣列", () => {
    delete process.env[KEY];
    expect(chatIdsEnv(KEY)).toEqual([]);
    expect(parse("")).toEqual([]);
    expect(parse("   ")).toEqual([]);
  });

  // Number() 會把這些吞成合法整數 → 必須被 regex 擋下,否則白名單靜默失準
  it.each(["1e5", "0x10", "12.0", "0b1", "0o17", "1_000", "12abc", "abc", "+5", "１２３"])(
    "非純整數字面 '%s' → 丟錯",
    (bad) => {
      expect(() => parse(bad)).toThrow(/非整數 chat id/);
    },
  );

  it("有效項中夾一個壞項也整組丟錯(fail-fast)", () => {
    expect(() => parse("123,1e5,456")).toThrow(/非整數 chat id/);
  });
});
