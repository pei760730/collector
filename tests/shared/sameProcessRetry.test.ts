/** Project 17: failed-instance retries must reverify the destination before writing/acking. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@pei760730/collector-core";
import type { Update } from "@telegraf/types";
import { Telegram } from "telegraf";
import { GoogleSheetsStorage as ShellStorage } from "../../src/storage/googleSheets.js";
import { GoogleSheetsStorage as OfStorage } from "../../src/engines/of/storage/googleSheets.js";
import { runCollect } from "../../src/bot/handlers/collect.js";
import { runIngest } from "../../src/engines/of/bot/handlers/ingest.js";
import { createBot as shellBot } from "../../src/bot/router.js";
import { createBot as ofBot } from "../../src/engines/of/bot/router.js";
import { VOC_TARGET, TBVOC_TARGET } from "../../src/targets.js";
import { STAGING_COLUMNS, type StagingRow } from "../../src/engines/of/types.js";
import { drainUpdates, exitCodeFor } from "../../src/shared/drainLoop.js";

type Target = "voc" | "tbvoc" | "of" | "ofgay";
type Step = "ok" | "before" | "denied" | "lost" | "lost-unreadable";
interface Sheet {
  header: string[];
  rows: string[][];
  plan: Step[];
  appends: number;
  reads: number;
  unreadable: boolean;
  readCode?: number;
}
const { sheets } = vi.hoisted(() => ({ sheets: new Map<string, Sheet>() }));
const URL = "https://retry.example.invalid/synthetic/17";
const TARGETS: Target[] = ["voc", "tbvoc", "of", "ofgay"];
const transient = () => Object.assign(new Error("synthetic append/read failure"), { code: 503 });

vi.mock("googleapis", () => ({ google: {
  auth: { JWT: class {} },
  sheets: () => ({ spreadsheets: {
    get: async () => ({ data: { sheets: [{ properties: { title: "fixture" } }] } }),
    values: {
      get: async ({ spreadsheetId, range }: { spreadsheetId: string; range: string }) => {
        const s = sheets.get(spreadsheetId);
        if (!s || !range.startsWith("'fixture'!")) throw new Error("unexpected synthetic read");
        if (range.endsWith("!1:1")) return { data: { values: [[...s.header]] } };
        s.reads++;
        if (s.unreadable) throw Object.assign(new Error("synthetic destination read failure"), { code: s.readCode ?? 503 });
        return { data: { values: s.rows.map((r) => [...r]) } };
      },
      append: async (args: {
        spreadsheetId: string; range: string; valueInputOption: string;
        insertDataOption: string; requestBody: { values: string[][] };
      }) => {
        const s = sheets.get(args.spreadsheetId);
        if (!s || !args.range.startsWith("'fixture'!")) throw new Error("unexpected synthetic append");
        expect(args.valueInputOption).toBe("RAW");
        expect(args.insertDataOption).toBe("INSERT_ROWS");
        s.appends++;
        const step = s.plan.shift() ?? "ok";
        if (step === "before") throw transient(); // Known absent in the fake server only.
        if (step === "denied") throw Object.assign(new Error("synthetic permission failure"), { code: 403 });
        s.rows.push([...args.requestBody.values[0]!]);
        if (step === "lost-unreadable") s.unreadable = true;
        if (step === "lost" || step === "lost-unreadable") throw transient();
        return { data: { updates: { updatedRange: `'fixture'!A${s.rows.length + 1}:G${s.rows.length + 1}` } } };
      },
      update: async () => { throw new Error("unexpected synthetic update"); },
    },
  } }),
} }));

function fixture(target: Target) {
  const columns = target === "voc" ? VOC_TARGET.columns : target === "tbvoc" ? TBVOC_TARGET.columns : STAGING_COLUMNS;
  const sheet: Sheet = { header: ["extra", ...[...columns].reverse(), ""], rows: [], plan: [], appends: 0, reads: 0, unreadable: false };
  sheets.set(target, sheet);
  return sheet;
}

function consumer(target: Target) {
  const persist = { failed: false };
  const deps = { expandShortUrls: false, onPersistError: () => { persist.failed = true; } };
  const opts = { credentials: { client_email: "synthetic@example.invalid", private_key: "fake" }, sheetId: target, sheetName: "fixture" };
  const config = { telegramToken: "FAKE:synthetic", storage: "memory" as const, google: null, errorChatId: "", allowedChatIds: [17], expandShortUrls: false, logLevel: "info" };
  let collect: () => Promise<{ reply: string; error?: string }>;
  let bot;
  if (target === "voc" || target === "tbvoc") {
    const spec = target === "voc" ? VOC_TARGET : TBVOC_TARGET;
    const storage = new ShellStorage({ ...opts, columns: spec.columns, owner: spec.owner });
    collect = () => runCollect({ text: URL }, { ...deps, storage, target: spec });
    bot = shellBot({ ...config, target }, storage, deps, spec);
  } else {
    const storage = new OfStorage({ ...opts, prodSheetName: "unused" });
    collect = () => runIngest({ text: URL }, { ...deps, storage });
    bot = ofBot(config, storage, deps);
  }
  bot.botInfo = { id: 1, is_bot: true, first_name: "synthetic", username: "synthetic_bot" } as typeof bot.botInfo;
  const results: { reply: string; error?: string }[] = [];
  const run = collect;
  return { collect: async () => { const result = await run(); results.push(result); return result; }, persist, results, bot };
}

function queue() {
  const pending: Update[] = [{ update_id: 17, message: {
    message_id: 17, date: 0, chat: { id: 17, type: "private", first_name: "synthetic" }, text: URL,
    from: { id: 17, is_bot: false, first_name: "synthetic" },
  } }];
  return { pending, offsets: [] as number[] };
}
function drain(c: ReturnType<typeof consumer>, q: ReturnType<typeof queue>, throughRouter = false) {
  return drainUpdates({
    telegram: { getUpdates: async (_t, _l, offset) => {
      q.offsets.push(offset);
      q.pending = q.pending.filter((u) => u.update_id >= offset);
      return q.pending;
    } },
    handleUpdate: throughRouter ? (update) => c.bot.handleUpdate(update) : c.collect,
  }, c.persist, "synthetic");
}
async function settle<T>(promise: Promise<T>): Promise<T> {
  const caught = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  const result = await caught;
  if ("error" in result) throw result.error;
  return result.value;
}

const replies: string[] = [];
beforeEach(() => {
  sheets.clear();
  replies.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T03:00:00Z"));
  for (const level of ["info", "warn", "error"] as const) vi.spyOn(logger, level).mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external fetch prohibited"); }));
  vi.spyOn(Telegram.prototype, "callApi").mockImplementation(async (method, payload) => {
    if (method !== "sendMessage") throw new Error("unexpected synthetic Telegram method");
    replies.push(String((payload as { text: string }).text));
    return {} as never;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(TARGETS)("%s retained-instance retry (synthetic raw URL)", (target) => {
  it.each(["ok", "lost"] as const)("verified %s commit survives same-instance redelivery", async (step) => {
    const s = fixture(target), c = consumer(target);
    s.plan = [step];
    const result = await settle(c.collect());
    expect(result.error).toBeUndefined(); // lost is verified by a fresh read within this call.
    expect(c.persist.failed).toBe(false);
    const reads = s.reads;
    expect((await settle(c.collect())).reply).toContain("沒有重複寫入");
    expect(s.rows).toHaveLength(1);
    expect(s.appends).toBe(1);
    if (step === "ok") expect(s.reads).toBe(1); // Fast success retains its warm-cache read budget.
    if (step === "lost") expect(reads).toBe(2); // initial index + proof of commit.
  });

  it("failed before every append retains update, then same instance writes exactly one row", async () => {
    const s = fixture(target), c = consumer(target), q = queue();
    s.plan = ["before", "before", "before", "before"];
    const failed = await settle(drain(c, q));
    expect(failed).toEqual({ processed: 0, aborted: true });
    expect(exitCodeFor(failed)).toBe(2);
    expect(q.offsets).toEqual([0]);
    expect(q.pending).toHaveLength(1);
    expect(s.rows).toHaveLength(0);
    expect(s.appends).toBe(4);
    expect(await settle(drain(c, q))).toEqual({ processed: 1, aborted: false });
    expect(s.rows).toHaveLength(1);
    expect(s.appends).toBe(5);
    expect(q.pending).toEqual([]);
  });

  it.each(["terminal-lost", "lost-unreadable"] as const)("%s: cold and retained instances both absorb the committed row", async (scenario) => {
    const s = fixture(target), c = consumer(target), q = queue();
    s.plan = scenario === "terminal-lost" ? ["before", "before", "before", "lost"] : ["lost-unreadable"];
    expect(await settle(drain(c, q))).toEqual({ processed: 0, aborted: true });
    expect(c.persist.failed).toBe(true);
    expect(q.offsets).toEqual([0]);
    expect(q.pending).toHaveLength(1);
    expect(s.rows).toHaveLength(1); // Fake-server truth; original caller still has uncertain outcome.
    const appends = scenario === "terminal-lost" ? 4 : 1;
    expect(s.appends).toBe(appends);
    s.unreadable = false;
    // Fresh instance sees committed data; it does not repair the retained instance's cache.
    expect((await settle(consumer(target).collect())).reply).toContain("沒有重複寫入");
    expect(s.appends).toBe(appends);
    const reads = s.reads;
    expect(await settle(drain(c, q))).toEqual({ processed: 1, aborted: false });
    expect(s.rows).toHaveLength(1);
    expect(s.appends).toBe(appends);
    expect(s.reads).toBe(reads + 1);
    expect(q.pending).toEqual([]);
  });

  it.each([[false, 503], [true, 503], [false, 403], [true, 403]] as const)("verification failure never writes or acks (committed=%s, readCode=%s)", async (committed, readCode) => {
    const s = fixture(target), c = consumer(target), q = queue();
    s.plan = ["before", "before", "before", committed ? "lost" : "before"];
    expect(await settle(drain(c, q))).toEqual({ processed: 0, aborted: true });
    const appends = s.appends;
    s.unreadable = true;
    s.readCode = readCode;
    for (let retry = 0; retry < 2; retry++) {
      expect(await settle(drain(c, q))).toEqual({ processed: 0, aborted: true });
      expect(c.persist.failed).toBe(true);
      expect(c.results.at(-1)?.error).toBeDefined();
      expect(c.results.at(-1)?.error).toContain("待查證");
      expect(c.results.at(-1)?.reply).not.toMatch(/已收進|已以 unsupported 收錄|沒有重複寫入/);
      expect(q.pending).toHaveLength(1);
      expect(s.appends).toBe(appends);
      expect(s.rows).toHaveLength(committed ? 1 : 0);
    }
    expect(q.offsets).toEqual([0, 0, 0]);
    s.unreadable = false;
    expect(await settle(drain(c, q))).toEqual({ processed: 1, aborted: false });
    expect(s.rows).toHaveLength(1);
    expect(s.appends).toBe(appends + (committed ? 0 : 1));
    expect(q.pending).toEqual([]);
  });

  it("real router retains unverifiable retry and keeps unauthorized sources outside storage", async () => {
    const s = fixture(target), c = consumer(target), q = queue();
    s.plan = ["before", "before", "before", "lost"];
    expect(await settle(drain(c, q, true))).toEqual({ processed: 0, aborted: true });
    s.unreadable = true;
    s.readCode = 403; // Even a non-transient verification failure cannot prove prior absence.
    const reads = s.reads;
    const unauthorized: Update = { update_id: 18, message: {
      message_id: 18, date: 0, chat: { id: 999, type: "private", first_name: "synthetic" },
      from: { id: 999, is_bot: false, first_name: "synthetic" }, text: URL,
    } };
    await settle(c.bot.handleUpdate(unauthorized));
    expect(s.reads).toBe(reads);
    expect(s.appends).toBe(4);
    expect(await settle(drain(c, q, true))).toEqual({ processed: 0, aborted: true });
    expect(q.offsets).toEqual([0, 0]);
    expect(q.pending).toHaveLength(1);
    expect(replies.at(-1)).not.toMatch(/已收進|已以 unsupported 收錄|沒有重複寫入/);
    s.unreadable = false;
    expect(await settle(drain(c, q, true))).toEqual({ processed: 1, aborted: false });
    expect(s.rows).toHaveLength(1);
    expect(s.appends).toBe(4);
    expect(replies.at(-1)).toContain("沒有重複寫入");
  });

  it("explicit no-write rejection is one attempt; later retry can still save", async () => {
    const s = fixture(target), c = consumer(target);
    s.plan = ["denied"];
    expect((await settle(c.collect())).error).toBeDefined();
    expect(s.appends).toBe(1);
    expect(s.rows).toHaveLength(0);
    expect((await settle(c.collect())).error).toBeUndefined();
    expect(s.appends).toBe(2);
    expect(s.rows).toHaveLength(1);
  });

  it.each([false, true])("cold restart verifies destination and retains a transient unreadable retry (committed=%s)", async (committed) => {
    const s = fixture(target), first = consumer(target), q = queue();
    s.plan = ["before", "before", "before", committed ? "lost" : "before"];
    expect(await settle(drain(first, q, true))).toEqual({ processed: 0, aborted: true });
    const restarted = consumer(target);
    s.unreadable = true;
    expect(await settle(drain(restarted, q, true))).toEqual({ processed: 0, aborted: true });
    expect(s.appends).toBe(4);
    expect(q.pending).toHaveLength(1);
    s.unreadable = false;
    expect(await settle(drain(restarted, q, true))).toEqual({ processed: 1, aborted: false });
    expect(s.rows).toHaveLength(1);
    expect(s.appends).toBe(committed ? 4 : 5);
    expect(q.pending).toEqual([]);
  });

  it.each([false, true])("concurrent reentry stays serialized after failure (committed=%s)", async (committed) => {
    const s = fixture(target), c = consumer(target);
    s.plan = ["before", "before", "before", committed ? "lost" : "before"];
    expect((await settle(c.collect())).error).toBeDefined();
    const results = await settle(Promise.all([c.collect(), c.collect()]));
    expect(results.every((r) => r.error === undefined)).toBe(true);
    expect(results.filter((r) => r.reply.includes("沒有重複寫入"))).toHaveLength(committed ? 2 : 1);
    expect(s.rows).toHaveLength(1);
    expect(s.appends).toBe(committed ? 4 : 5);
  });

  it("preserves Taipei-midnight policy on the same instance", async () => {
    const s = fixture(target), c = consumer(target);
    vi.setSystemTime(new Date("2026-11-15T15:59:59Z"));
    await settle(c.collect());
    vi.setSystemTime(new Date("2026-11-15T16:00:01Z"));
    await settle(c.collect());
    expect(s.rows).toHaveLength(target === "voc" || target === "tbvoc" ? 1 : 2);
  });

  it("uncertain append crossing Taipei midnight retains the existing raw date boundary", async () => {
    const s = fixture(target), c = consumer(target);
    vi.setSystemTime(new Date("2026-11-15T15:59:40Z"));
    s.plan = ["before", "before", "before", "lost"];
    expect((await settle(c.collect())).error).toBeDefined();
    expect(s.rows).toHaveLength(1);
    vi.setSystemTime(new Date("2026-11-15T16:00:01Z"));
    expect((await settle(c.collect())).error).toBeUndefined();
    expect(s.rows).toHaveLength(target === "voc" || target === "tbvoc" ? 1 : 2);
    expect(s.appends).toBe(target === "voc" || target === "tbvoc" ? 4 : 5);
  });
});

// Adapter-only non-raw boundary: no real platform URL and no mocked parser/core.
// Uses the public lookup→append sequence of supported ingest; not an extraction E2E test.
describe.each(["of", "ofgay"] as const)("%s non-raw adapter retry", (target) => {
  it.each(["terminal-lost", "lost-unreadable"] as const)("%s invalidates the retained index and verifies current destination", async (scenario) => {
    const s = fixture(target);
    const make = () => new OfStorage({ credentials: { client_email: "synthetic@example.invalid", private_key: "fake" }, sheetId: target, sheetName: "fixture", prodSheetName: "unused" });
    const storage = make();
    const row: StagingRow = { PLATFORM: "YouTube", DATE: "2026/11/15", CLEAN_URL: URL, VIDEO_ID: "yt_synthetic17", STATUS: "pending_review" };
    expect(await storage.findByVideoId(row.VIDEO_ID)).toBeNull(); // Prime empty cache.
    s.plan = scenario === "terminal-lost" ? ["before", "before", "before", "lost"] : ["lost-unreadable"];
    await expect(settle(storage.append(row))).rejects.toThrow();
    expect(s.rows).toHaveLength(1);
    const appends = s.appends;
    s.unreadable = true;
    await expect(settle(storage.findByVideoId(row.VIDEO_ID))).rejects.toThrow();
    expect(s.appends).toBe(appends);
    s.unreadable = false;
    expect((await make().findByVideoId(row.VIDEO_ID))?.rowNumber).toBe(2);
    expect((await storage.findByVideoId(row.VIDEO_ID))?.rowNumber).toBe(2);
    expect(s.rows).toHaveLength(1);
    expect(s.appends).toBe(appends);
  });
});
