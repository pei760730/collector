/** Issue #130: real storage → handler → router → drain, with only external APIs faked. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "@telegraf/types";
import { logger } from "@pei760730/collector-core";
import { GoogleSheetsStorage as ShellStorage } from "../../src/storage/googleSheets.js";
import { GoogleSheetsStorage as OfStorage } from "../../src/engines/of/storage/googleSheets.js";
import { createBot as shellBot } from "../../src/bot/router.js";
import { createBot as ofBot } from "../../src/engines/of/bot/router.js";
import { runCollect } from "../../src/bot/handlers/collect.js";
import { runIngest } from "../../src/engines/of/bot/handlers/ingest.js";
import { VOC_TARGET, TBVOC_TARGET } from "../../src/targets.js";
import { STAGING_COLUMNS } from "../../src/engines/of/types.js";
import { drainUpdates, exitCodeFor } from "../../src/shared/drainLoop.js";

type Target = "voc" | "tbvoc" | "of" | "ofgay";
type AppendStep = "ok" | "before" | "lost" | "permanent";
interface Sheet {
  header: string[];
  rows: string[][];
  plan: AppendStep[];
  appends: number;
  reads: number;
  readFailure?: Error;
  writes: { range: string; valueInputOption: string; insertDataOption: string }[];
}
const { sheets } = vi.hoisted(() => ({ sheets: new Map<string, Sheet>() }));
const TARGETS: Target[] = ["voc", "tbvoc", "of", "ofgay"];
const URL = "https://www.tiktok.com/@fixture/video/7234567890";
const URL2 = "https://www.tiktok.com/@fixture/video/7234567891";
const URL3 = "https://www.tiktok.com/@fixture/video/7234567892";
const transient = () => Object.assign(new Error("fake append response lost"), { code: 503 });

vi.mock("googleapis", () => ({
  google: {
    auth: { JWT: class {} },
    sheets: () => ({
      spreadsheets: {
        get: async () => ({ data: { sheets: ["參考池", "暫存區", "總表"].map((title) => ({ properties: { title } })) } }),
        values: {
          get: async ({ spreadsheetId, range }: { spreadsheetId: string; range: string }) => {
            const sheet = sheets.get(spreadsheetId)!;
            if (range.startsWith("'總表'!")) {
              return { data: { values: range.endsWith("!1:1") ? [["影片連結"]] : [] } };
            }
            if (range.endsWith("!1:1")) return { data: { values: [[...sheet.header]] } };
            sheet.reads += 1;
            if (sheet.readFailure) throw sheet.readFailure;
            return { data: { values: sheet.rows.map((row) => [...row]) } };
          },
          append: async (args: {
            spreadsheetId: string; range: string; valueInputOption: string; insertDataOption: string;
            requestBody: { values: string[][] };
          }) => {
            const sheet = sheets.get(args.spreadsheetId)!;
            sheet.appends += 1;
            sheet.writes.push(args);
            const step = sheet.plan.shift() ?? "ok";
            if (step === "before") throw transient();
            if (step === "permanent") throw Object.assign(new Error("fake permission denied"), { code: 403 });
            sheet.rows.push([...args.requestBody.values[0]!]);
            if (step === "lost") throw transient();
            const row = sheet.rows.length + 1;
            return { data: { updates: { updatedRange: `${args.range.split("!")[0]}!A${row}:G${row}` } } };
          },
          update: async () => { throw new Error("unexpected update: fixture has nonempty headers"); },
        },
      },
    }),
  },
}));

function fixture(target: Target) {
  const columns = target === "voc" ? VOC_TARGET.columns : target === "tbvoc" ? TBVOC_TARGET.columns : STAGING_COLUMNS;
  // Reorder and add non-contract columns: real layout/projection must still work.
  const sheet: Sheet = { header: ["legacy", ...[...columns].reverse(), ""], rows: [], plan: [], appends: 0, reads: 0, writes: [] };
  sheets.set(target, sheet);
  return sheet;
}

function consumer(target: Target) {
  const persist = { failed: false };
  const hooks = { onPersistError: () => { persist.failed = true; } };
  const config = {
    telegramToken: `FAKE:${target}`, storage: "memory" as const, google: null,
    errorChatId: "999", allowedChatIds: [123], expandShortUrls: false, logLevel: "info",
  };
  const opts = { credentials: { client_email: "fixture@example.invalid", private_key: "fake" }, sheetId: target };
  const deps = { expandShortUrls: false, now: () => Date.UTC(2026, 9, 2), ...hooks };
  let bot;
  let prime: () => Promise<unknown>;
  let collect: (text: string) => Promise<{ reply: string; error?: string }>;
  if (target === "voc" || target === "tbvoc") {
    const spec = target === "voc" ? VOC_TARGET : TBVOC_TARGET;
    const storage = new ShellStorage({ ...opts, sheetName: "參考池", columns: spec.columns, owner: spec.owner });
    prime = () => storage.dedupIndex();
    collect = (text) => runCollect({ text }, { ...deps, storage, target: spec });
    bot = shellBot({ ...config, target }, storage, hooks, spec);
  } else {
    const storage = new OfStorage({ ...opts, sheetName: "暫存區", prodSheetName: "總表" });
    prime = () => storage.videoIdIndex();
    collect = (text) => runIngest({ text }, { ...deps, storage });
    bot = ofBot(config, storage, hooks);
  }
  bot.botInfo = { id: 1, is_bot: true, first_name: "fixture", username: "fixture_bot" } as typeof bot.botInfo;
  return { bot, persist, prime, collect };
}

function update(id: number, text = URL): Update {
  return {
    update_id: id,
    message: { message_id: id, date: 0, chat: { id: 123, type: "private", first_name: "fixture" },
      from: { id: 123, is_bot: false, first_name: "fixture" }, text },
  } as Update;
}

function queue(updates: Update[]) {
  return { pending: [...updates], offsets: [] as number[], failAck: false };
}

function drain(c: ReturnType<typeof consumer>, q: ReturnType<typeof queue>) {
  let calls = 0;
  vi.spyOn(c.bot.telegram, "getUpdates").mockImplementation(async (_timeout, _limit, offset) => {
    if (++calls > 6) throw new Error("fixture bound exceeded: ack did not advance");
    q.offsets.push(offset);
    // Crash boundary: request never reaches Telegram, so pending updates survive.
    if (q.failAck && offset > 0) throw new Error("fake crash before ack");
    q.pending = q.pending.filter((u) => u.update_id >= offset);
    return [...q.pending];
  });
  return drainUpdates(c.bot, c.persist, "fixture");
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  // Attach rejection handling before advancing timers (no unhandled-rejection false positives).
  const result = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  const outcome = await result;
  if ("error" in outcome) throw outcome.error;
  return outcome.value;
}

let failReplies = false;
let replies: string[] = [];
beforeEach(() => {
  sheets.clear();
  replies = [];
  failReplies = false;
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 2));
  for (const level of ["info", "warn", "error"] as const) vi.spyOn(logger, level).mockImplementation(() => {});
  vi.spyOn(Telegram.prototype, "callApi").mockImplementation(async (method, payload) => {
    if (method !== "sendMessage") throw new Error(`unexpected Telegram method: ${method}`);
    replies.push(String((payload as { text: string }).text));
    if (failReplies) throw new Error("fake reply failure");
    return {} as never;
  });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected external fetch"); }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(TARGETS)("%s actual consumer crash matrix", (target) => {
  it.each([
    { name: "before commit then success", plan: ["before", "ok"], appends: 2, reads: 2 },
    { name: "first commit loses response", plan: ["lost"], appends: 1, reads: 2 },
    { name: "late commit loses response", plan: ["before", "lost"], appends: 2, reads: 3 },
  ] satisfies { name: string; plan: AppendStep[]; appends: number; reads: number }[])("$name", async ({ plan, appends, reads }) => {
    const sheet = fixture(target);
    sheet.plan = [...plan];
    const q = queue([update(10)]);
    const c = consumer(target);
    expect(await settle(drain(c, q))).toEqual({ processed: 1, aborted: false });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.appends).toBe(appends);
    expect(sheet.reads).toBe(reads); // index + one fresh read per uncertain append before retry
    expect(q.pending).toEqual([]);
    expect(q.offsets).toEqual([0, 11]);
    // Warm-cache repeated delivery and a cold-cache restart both absorb this durable row.
    await settle(c.collect(URL));
    await settle(consumer(target).collect(URL));
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.appends).toBe(appends);
  });

  it.each([false, true])("late lost response with preexisting cache=%s", async (warm) => {
    const sheet = fixture(target);
    const c = consumer(target);
    if (warm) await c.prime();
    sheet.plan = ["before", "lost"];
    expect((await settle(c.collect(URL))).error).toBeUndefined();
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.appends).toBe(2);
    expect(sheet.reads).toBe(3);
  });

  it.each(["before", "lost", "permanent"] as const)("exhausted/permanent append (%s) stays unacked; cold replay recovers", async (last) => {
    const sheet = fixture(target);
    sheet.plan = last === "permanent" ? [last] : ["before", "before", "before", last];
    const q = queue([update(10)]);
    const result = await settle(drain(consumer(target), q));
    expect(result).toEqual({ processed: 0, aborted: true });
    expect(exitCodeFor(result)).toBe(2);
    expect(q.pending.map((u) => u.update_id)).toEqual([10]);
    expect(q.offsets).toEqual([0]);
    expect(sheet.rows).toHaveLength(last === "lost" ? 1 : 0);
    expect(sheet.appends).toBe(last === "permanent" ? 1 : 4);
    expect(sheet.reads).toBe(last === "permanent" ? 1 : 4); // at most 3 guard lookups
    expect(replies.some((text) => text.includes("已收進"))).toBe(false);
    expect(await settle(drain(consumer(target), q))).toEqual({ processed: 1, aborted: false });
    expect(sheet.rows).toHaveLength(1);
    expect(q.pending).toEqual([]);
  });

  it("commit then crash before ack → cold replay reads durable rows", async () => {
    const sheet = fixture(target);
    const q = queue([update(10)]);
    q.failAck = true;
    await expect(settle(drain(consumer(target), q))).rejects.toThrow("fake crash before ack");
    expect(sheet.rows).toHaveLength(1);
    expect(q.pending.map((u) => u.update_id)).toEqual([10]);
    q.failAck = false;
    expect(await settle(drain(consumer(target), q))).toEqual({ processed: 1, aborted: false });
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.appends).toBe(1);
    expect(q.pending).toEqual([]);
  });

  it("mixed batch stops on failed row; replay absorbs first row and processes the tail", async () => {
    const sheet = fixture(target);
    sheet.plan = ["ok", "before", "before", "before", "before"];
    const q = queue([update(10), update(11, URL2), update(12, URL3)]);
    expect(await settle(drain(consumer(target), q))).toEqual({ processed: 1, aborted: true });
    expect(sheet.rows).toHaveLength(1);
    expect(q.offsets).toEqual([0]);
    expect(q.pending.map((u) => u.update_id)).toEqual([10, 11, 12]);
    expect(await settle(drain(consumer(target), q))).toEqual({ processed: 3, aborted: false });
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.appends).toBe(7); // first success + 4 failed attempts + two replay writes
    expect(q.pending).toEqual([]);
  });

  it.each([false, true])("reply/notification failure does not change durable outcome (append failure=%s)", async (failAppend) => {
    const sheet = fixture(target);
    if (failAppend) sheet.plan = ["before", "before", "before", "before"];
    failReplies = true;
    const q = queue([update(10)]);
    expect(await settle(drain(consumer(target), q))).toEqual({ processed: failAppend ? 0 : 1, aborted: failAppend });
    expect(sheet.rows).toHaveLength(failAppend ? 0 : 1);
    expect(q.pending).toHaveLength(failAppend ? 1 : 0);
  });

  it("transient index read failure reaches router persist hook and preserves update", async () => {
    const sheet = fixture(target);
    sheet.readFailure = transient();
    const q = queue([update(10)]);
    expect(await settle(drain(consumer(target), q))).toEqual({ processed: 0, aborted: true });
    expect(sheet.appends).toBe(0);
    expect(q.pending).toHaveLength(1);
    sheet.readFailure = undefined;
    await settle(drain(consumer(target), q));
    expect(sheet.rows).toHaveLength(1);
  });

  it("existing concurrent handler entry serializes dedup and projects only target columns with RAW", async () => {
    const sheet = fixture(target);
    const c = consumer(target);
    await settle(Promise.all([c.collect(URL), c.collect(URL)]));
    expect(sheet.rows).toHaveLength(1);
    expect(sheet.appends).toBe(1);
    expect(sheet.rows[0]![0]).toBe("");
    expect(sheet.rows[0]!.at(-1)).toBe("");
    const named = Object.fromEntries(sheet.header.map((key, i) => [key, sheet.rows[0]![i]]));
    if (target === "voc" || target === "tbvoc") {
      expect(named).toMatchObject({ 平台: "tiktok", 連結: URL, 挑: "", 加入日期: "2026-10-02" });
      if (target === "tbvoc") expect(named.夯度).toBe("");
    } else {
      expect(named).toMatchObject({ PLATFORM: "TikTok", CLEAN_URL: URL, VIDEO_ID: "tt_7234567890", STATUS: "pending_review" });
    }
    expect(sheet.writes[0]).toMatchObject({ valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" });
  });

  it("missing required header fails before append", async () => {
    const sheet = fixture(target);
    sheet.header.splice(1, 1);
    await expect(consumer(target).prime()).rejects.toThrow();
    expect(sheet.appends).toBe(0);
  });

  it("duplicate required header fails before append", async () => {
    const sheet = fixture(target);
    sheet.header.push(sheet.header[1]!);
    await expect(consumer(target).prime()).rejects.toThrow(/重複/);
    expect(sheet.appends).toBe(0);
  });

  it("message without a URL is explicitly rejected and acked without a durable row", async () => {
    const sheet = fixture(target);
    const q = queue([update(10, "no link here")]);
    expect(await settle(drain(consumer(target), q))).toEqual({ processed: 1, aborted: false });
    expect(sheet.rows).toHaveLength(0);
    expect(sheet.appends).toBe(0);
    expect(q.pending).toEqual([]);
    expect(replies.some((text) => text.includes("看不懂"))).toBe(true);
  });
});

it("four targets with the same input retain separate sheets and caches", async () => {
  const fixtures = TARGETS.map(fixture);
  const consumers = TARGETS.map(consumer);
  // Only of has a late ambiguous write; other targets must not inherit its failure/cache.
  fixtures[2]!.plan = ["before", "lost"];
  await settle(Promise.all(consumers.map((c) => c.collect(URL))));
  await settle(Promise.all(consumers.map((c) => c.collect(URL))));
  for (const sheet of fixtures) expect(sheet.rows).toHaveLength(1);
  expect(fixtures.map((sheet) => sheet.appends)).toEqual([1, 1, 2, 1]);
});
