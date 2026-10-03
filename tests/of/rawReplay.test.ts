import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleSheetsStorage } from "../../src/engines/of/storage/googleSheets.js";
import { MemoryStorage } from "../../src/engines/of/storage/memory.js";
import { runIngest } from "../../src/engines/of/bot/handlers/ingest.js";
import { drainUpdates } from "../../src/shared/drainLoop.js";
import { STAGING_COLUMNS, type StagingRow } from "../../src/engines/of/types.js";

const NOW = Date.UTC(2026, 9, 2, 4);
const DATE = "2026/10/2";
const A = "https://example.invalid/a?q=1";
const B = "https://example.invalid/b?q=1";
function row(url: string, id = `raw_${NOW}`, date = DATE): StagingRow {
  return { PLATFORM: "Other", DATE: date, CLEAN_URL: url, VIDEO_ID: id, STATUS: "unsupported" };
}
type Fault = "before" | "lost" | "permanent" | "no-range" | "ok";
function fixture(target: string, seed: StagingRow[] = []) {
  const header = ["legacy", ...STAGING_COLUMNS.slice().reverse()];
  const cells = seed.map(r => header.map(c => r[c as keyof StagingRow] ?? ""));
  const faults: Fault[] = [];
  let reads = 0, appends = 0;
  const api = { spreadsheets: {
    get: vi.fn(async () => ({ data: { sheets: [{ properties: { title: "pool" } }] } })),
    values: {
      get: vi.fn(async ({ range }: { range: string }) => {
        if (range.includes("prod")) return { data: { values: range.endsWith("1:1") ? [["影片連結"]] : [] } };
        if (range.endsWith("1:1")) return { data: { values: [header] } };
        reads++;
        return { data: { values: cells.map(r => [...r]) } };
      }),
      append: vi.fn(async (req: { valueInputOption: string; requestBody: { values: string[][] } }) => {
        appends++;
        expect(req.valueInputOption).toBe("RAW");
        const fault = faults.shift() ?? "ok";
        if (fault === "before" || fault === "permanent") throw { code: fault === "before" ? 503 : 400 };
        cells.push([...req.requestBody.values[0]!]);
        if (fault === "lost") throw { code: 503 };
        return { data: { updates: fault === "no-range" ? {} : { updatedRange: `'pool'!A${cells.length + 1}:F${cells.length + 1}` } } };
      }),
    },
  } };
  const make = () => {
    const storage = new GoogleSheetsStorage({ credentials: { client_email: "fake@example.invalid", private_key: "fake" }, sheetId: `fake-${target}`, sheetName: "pool", prodSheetName: "prod" });
    (storage as unknown as { sheets: unknown }).sheets = api;
    return storage;
  };
  let storage = make();
  const persist = { failed: false };
  const run = (url: string, now = NOW) => runIngest({ text: url }, { storage, now: () => now, expandShortUrls: false, onPersistError: () => { persist.failed = true; } });
  const drain = async (url: string, now = NOW) => {
    const offsets: number[] = [];
    const result = await drainUpdates({ telegram: { getUpdates: async (_t, _l, offset) => { offsets.push(offset); return offsets.length === 1 ? [{ update_id: 71 } as never] : []; } }, handleUpdate: async () => { await run(url, now); } }, persist, "fake staging");
    return { result, offsets };
  };
  return { run, drain, faults, persist, get storage() { return storage; }, restart() { storage = make(); }, rows: () => cells.map(r => Object.fromEntries(STAGING_COLUMNS.map(c => [c, r[header.indexOf(c)]])) as unknown as StagingRow), get reads() { return reads; }, get appends() { return appends; } };
}
afterEach(() => vi.restoreAllMocks());
describe("raw collision repair (real adapter / handler / drain; fake external APIs)", () => {
  for (const target of ["of", "ofgay"]) describe(target, () => {
    it("COLLISION_REPLAY: both colliding raw candidates survive cold replay", async () => {
      const f = fixture(target); await f.run(A); await f.run(B); expect(f.rows()).toHaveLength(2);
      f.restart(); await f.run(B, NOW + 1); expect(f.rows()).toHaveLength(2);
    });
    it("COLLISION_LOSS: unrelated ID cannot fake durability before commit", async () => {
      const f = fixture(target, [row(A)]); f.faults.push("before");
      const r = await f.run(B); expect(r.error).toBeUndefined();
      expect(f.rows().map(r => r.CLEAN_URL)).toEqual([A, B]); expect(f.appends).toBe(2);
    });
    it("same ID / URL on another date cannot prove a failed append durable", async () => {
      const f = fixture(target, [row(B, `raw_${NOW}`, "2026/10/1")]);
      f.faults.push("before");
      await f.run(B);
      expect(f.rows().map(r => r.DATE)).toEqual(["2026/10/1", DATE]);
      expect(f.appends).toBe(2);
    });
    it("COLLISION_ACK: four pre-commit failures retain update; restart writes once", async () => {
      const f = fixture(target, [row(A)]); f.faults.push("before", "before", "before", "before");
      const failed = await f.drain(B); expect(failed).toEqual({ result: { processed: 0, aborted: true }, offsets: [0] });
      expect(f.rows().map(r => r.CLEAN_URL)).toEqual([A]); expect(f.appends).toBe(4);
      f.restart(); const recovered = await f.drain(B, NOW + 1);
      expect(recovered).toEqual({ result: { processed: 1, aborted: false }, offsets: [0, 72] });
      f.restart(); await f.drain(B, NOW + 2); expect(f.rows()).toHaveLength(2);
    });
    it("warm successful append updates raw view even when map already has the ID", async () => {
      const f = fixture(target, [row(A)]); const index = await f.storage.videoIdIndex();
      await f.run(B); await f.run(B, NOW + 1);
      expect(f.rows()).toHaveLength(2); expect(f.reads).toBe(1);
      expect(index.get(`raw_${NOW}`)?.row.CLEAN_URL).toBe(A);
      expect((await f.storage.findRawReplay(B, DATE))?.rowNumber).toBe(3);
    });
    it("same URL / same date matches regardless of timestamp; different date does not", async () => {
      const f = fixture(target, [row(A), row(B)]);
      await f.run(B, NOW + 1); expect(f.rows()).toHaveLength(2);
      await f.run(B, Date.UTC(2026, 9, 2, 16)); expect(f.rows()).toHaveLength(3);
    });
    it("exact URL query/case and non-raw scope remain distinct", async () => {
      const f = fixture(target, [row(A), row(B, "tt_9")]);
      await f.run(A.replace("q=1", "q=2")); await f.run(A.replace("/a?", "/A?"), NOW + 1); await f.run(B, NOW + 2);
      expect(f.rows()).toHaveLength(5);
    });
    it("lost response proves matching raw row, invalidates both views, then replays once", async () => {
      const f = fixture(target, [row(A)]); await f.storage.videoIdIndex(); f.faults.push("lost");
      await f.run(B); expect(f.appends).toBe(1); expect(f.rows()).toHaveLength(2);
      const reads = f.reads; await f.run(B, NOW + 1); expect(f.reads).toBe(reads + 1);
      expect((await f.storage.findRawReplay(B, DATE))?.rowNumber).toBe(3);
    });
    it("later commit/lost response uses fresh proof after an earlier empty lookup", async () => {
      const f = fixture(target, [row(A)]); f.faults.push("before", "lost");
      await f.run(B); expect(f.rows()).toHaveLength(2); expect(f.appends).toBe(2); expect(f.reads).toBe(3);
    });
    it("missing updatedRange invalidates raw view despite colliding ID", async () => {
      const f = fixture(target, [row(A)]); await f.storage.videoIdIndex(); f.faults.push("no-range");
      await f.run(B); await f.run(B, NOW + 1); expect(f.rows()).toHaveLength(2); expect(f.reads).toBe(2);
      expect((await f.storage.findRawReplay(B, DATE))?.rowNumber).toBe(3);
    });
    it("uncertain last commit remains unacked and cold replay confirms it", async () => {
      const f = fixture(target, [row(A)]); f.faults.push("before", "before", "before", "lost");
      const r = await f.drain(B); expect(r.result).toEqual({ processed: 0, aborted: true }); expect(r.offsets).toEqual([0]);
      expect(f.rows()).toHaveLength(2); const reads = f.reads;
      await f.run(B, NOW + 1); expect(f.rows()).toHaveLength(2); expect(f.reads).toBe(reads + 1);
      f.restart(); await f.drain(B, NOW + 2); expect(f.rows()).toHaveLength(2);
    });
    it("permanent error remains one attempt / retained update with no positive cache", async () => {
      const f = fixture(target, [row(A)]); f.faults.push("permanent");
      expect((await f.drain(B)).result).toEqual({ processed: 0, aborted: true }); expect(f.appends).toBe(1);
      await f.run(B, NOW + 1); expect(f.rows()).toHaveLength(2);
    });
    it("supported first-hit map, trimmed lookup and real rowNumber stay unchanged", async () => {
      const first = row(A, " tt_7 "); const f = fixture(target, [first, row(B, "tt_7"), row(A), row(B)]);
      const index = await f.storage.videoIdIndex();
      expect([...index.keys()]).toEqual(["tt_7", `raw_${NOW}`]);
      expect(await f.storage.findByVideoId(" tt_7 ")).toEqual({ row: first, rowNumber: 2 });
      expect((await f.storage.findRawReplay(B, DATE))?.rowNumber).toBe(5); expect(f.reads).toBe(1);
    });
  });
  it("target raw caches stay isolated", async () => {
    const a = fixture("of"), b = fixture("ofgay"); await Promise.all([a.run(A), b.run(A)]);
    expect(a.rows()).toHaveLength(1); expect(b.rows()).toHaveLength(1);
  });
});
describe("MemoryStorage keeps the same raw and first-hit contracts", () => {
  it("all raw candidates remain discoverable and appended collisions update replay", async () => {
    const s = new MemoryStorage([row(A), row(B)]);
    expect((await s.videoIdIndex()).size).toBe(1);
    expect((await s.findRawReplay(B, DATE))?.rowNumber).toBe(3);
    await s.append(row("https://example.invalid/c"));
    expect((await s.findRawReplay("https://example.invalid/c", DATE))?.rowNumber).toBe(4);
    expect(await s.findRawReplay(B, "2026/10/3")).toBeNull();
  });
  it("trim existing URL only, preserve case/query and ignore non-raw candidates", async () => {
    const s = new MemoryStorage([row(` ${A} `), row(B, "tt_1")]);
    expect(await s.findRawReplay(A, DATE)).not.toBeNull();
    expect(await s.findRawReplay(A.replace("q=1", "q=2"), DATE)).toBeNull();
    expect(await s.findRawReplay(B, DATE)).toBeNull();
  });
});
