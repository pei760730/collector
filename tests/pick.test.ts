import { describe, it, expect } from "vitest";
import { runPick, parseCodes } from "../src/bot/handlers/pick.js";
import { MemoryPool, type PoolRef } from "../src/storage/poolPick.js";

function pool(refs: Partial<PoolRef>[]): MemoryPool {
  return new MemoryPool(
    refs.map((r, i) => ({
      rowNumber: r.rowNumber ?? i + 2,
      id: r.id ?? "",
      checked: r.checked ?? false,
    })),
  );
}

describe("parseCodes", () => {
  it("抽出含/不含 R 前綴、逗號分隔的編碼", () => {
    expect(parseCodes("R1990 R2003, r12  1990")).toEqual(["R1990", "R2003", "r12", "1990"]);
  });
  it("沒編碼回空", () => {
    expect(parseCodes("幫我挑")).toEqual([]);
  });
});

describe("runPick", () => {
  it("沒給編碼 → 回用法", async () => {
    const r = await runPick("", { pool: pool([]) });
    expect(r.reply).toContain("用法");
  });

  it("找到未勾的 → 打勾 + 提示等 voc 搬", async () => {
    const p = pool([{ id: "R1990", checked: false }]);
    const r = await runPick("R1990", { pool: p });
    expect(r.reply).toContain("已打勾 1 筆:R1990");
    expect(r.reply).toContain("待拍");
    expect((await p.readPool())[0]!.checked).toBe(true);
  });

  it("本來就打勾 → 不重打,回 ♻️", async () => {
    const p = pool([{ id: "R1990", checked: true }]);
    const r = await runPick("R1990", { pool: p });
    expect(r.reply).toContain("本來就打勾:R1990");
    expect(r.reply).not.toContain("已打勾 1 筆");
  });

  it("參考池找不到 → 回 ❓", async () => {
    const r = await runPick("R9999", { pool: pool([{ id: "R1990" }]) });
    expect(r.reply).toContain("找不到:R9999");
  });

  it("省略 R 前綴 / 前導零也對得上", async () => {
    const p = pool([{ id: "R0012", checked: false }]);
    const r = await runPick("12", { pool: p });
    expect(r.reply).toContain("已打勾 1 筆:R0012");
  });

  it("一次多筆:混合命中/已勾/找不到", async () => {
    const p = pool([
      { id: "R1", checked: false },
      { id: "R2", checked: true },
    ]);
    const r = await runPick("R1 R2 R3", { pool: p });
    expect(r.reply).toContain("已打勾 1 筆:R1");
    expect(r.reply).toContain("本來就打勾:R2");
    expect(r.reply).toContain("找不到:R3");
  });

  it("同次重複編碼只打一次", async () => {
    const p = pool([{ id: "R5", checked: false }]);
    const r = await runPick("R5 R5", { pool: p });
    expect(r.reply).toContain("已打勾 1 筆:R5");
    expect(r.reply).toContain("本來就打勾:R5");
  });
});
