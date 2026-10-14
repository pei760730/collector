import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@pei760730/collector-core";

const { failure } = vi.hoisted(() => ({
  failure: Object.assign(new Error("body failed https://api.telegram.org/bot123456:AAH-x_y/getUpdates"), {
    stack: "Error: https://api.telegram.org/bot123456:AAH-x_y/getUpdates\n    at drain (fake:1:1)",
    config: { body: "SECRETLINK" },
  }),
}));

// 在設定邊界注入失敗，實際執行兩個 entry 的最外層 catch；不連 Telegram / Sheets。
vi.mock("../../src/config.js", () => ({ loadConfig: () => { throw failure; } }));
vi.mock("../../src/engines/of/config.js", () => ({ loadConfig: () => { throw failure; } }));
vi.mock("../../src/targets.js", () => ({ isOfTarget: () => false, getTarget: () => ({}) }));

afterEach(() => vi.restoreAllMocks());

describe("drain 公開錯誤 log", () => {
  it.each([
    ["shell", () => import("../../src/drain.js")],
    ["of", () => import("../../src/engines/of/drain.js")],
  ] as const)("%s 最外層 catch 遮蔽 message 與 stack 的 Telegram token，只印字串", async (_name, load) => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    await load();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    const output = error.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    expect(output).toContain("body failed");
    expect(output).toContain("at drain (fake:1:1)");
    expect(output).not.toContain("AAH-x_y");
    expect(output).not.toContain("SECRETLINK");
    expect(error.mock.calls.every((call) => call.every((arg) => typeof arg === "string"))).toBe(true);
  });
});
