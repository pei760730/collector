/** Project 17: real handlers/storage/drain; only neutral .invalid URLs and fake I/O. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Telegram } from "telegraf";
import type { Update } from "@telegraf/types";
import { logger } from "@pei760730/collector-core";
import { GoogleSheetsStorage as ShellStorage } from "../../src/storage/googleSheets.js";
import { GoogleSheetsStorage as OfStorage } from "../../src/engines/of/storage/googleSheets.js";
import { createBot as shellBot } from "../../src/bot/router.js";
import { createBot as ofBot } from "../../src/engines/of/bot/router.js";
import { VOC_TARGET, TBVOC_TARGET } from "../../src/targets.js";
import { STAGING_COLUMNS } from "../../src/engines/of/types.js";
import { drainUpdates, exitCodeFor } from "../../src/shared/drainLoop.js";

type Target = "voc" | "tbvoc" | "of" | "ofgay";
type Step = "ok" | "before" | "lost" | "lost-unreadable";
interface Sheet {
  id: string;
  tab: string;
  header: string[];
  rows: string[][];
  plan: Step[];
  appends: number;
  unreadable: boolean;
  pause?: Promise<void>;
  entered?: () => void;
}
const { sheets } = vi.hoisted(() => ({ sheets: new Map<string, Sheet>() }));
const TARGETS: Target[] = ["voc", "tbvoc", "of", "ofgay"];
const URL = "https://intake.example.invalid/item/17";
const transient = () => Object.assign(new Error("fake response lost"), { code: 503 });

vi.mock("googleapis", () => ({
  google: {
    auth: { JWT: class {} },
    sheets: () => ({ spreadsheets: {
      get: async ({ spreadsheetId }: { spreadsheetId: string }) => ({ data: {
        sheets: [...sheets.values()].filter((s) => s.id === spreadsheetId)
          .map((s) => ({ properties: { title: s.tab } })),
      } }),
      values: {
        get: async ({ spreadsheetId, range }: { spreadsheetId: string; range: string }) => {
          const tab = range.split("!")[0]!.slice(1, -1);
          const s = sheets.get(`${spreadsheetId}/${tab}`);
          if (!s) throw new Error("unexpected fake destination");
          if (range.endsWith("!1:1")) return { data: { values: [[...s.header]] } };
          if (s.unreadable) throw transient();
          return { data: { values: s.rows.map((row) => [...row]) } };
        },
        append: async (args: {
          spreadsheetId: string; range: string; valueInputOption: string;
          insertDataOption: string; requestBody: { values: string[][] };
        }) => {
          const tab = args.range.split("!")[0]!.slice(1, -1);
          const s = sheets.get(`${args.spreadsheetId}/${tab}`);
          if (!s) throw new Error("unexpected fake destination");
          expect(args.valueInputOption).toBe("RAW");
          expect(args.insertDataOption).toBe("INSERT_ROWS");
          s.appends++;
          s.entered?.();
          if (s.pause) await s.pause;
          const step = s.plan.shift() ?? "ok";
          if (step === "before") throw transient();
          s.rows.push([...args.requestBody.values[0]!]);
          if (step === "lost-unreadable") s.unreadable = true;
          if (step === "lost" || step === "lost-unreadable") throw transient();
          return { data: { updates: { updatedRange: `'${tab}'!A${s.rows.length + 1}:G${s.rows.length + 1}` } } };
        },
        update: async () => { throw new Error("unexpected fake sheet update"); },
      },
    } }),
  },
}));

function fixture(target: Target, sharedSheet = false): Sheet {
  const columns = target === "voc" ? VOC_TARGET.columns : target === "tbvoc" ? TBVOC_TARGET.columns : STAGING_COLUMNS;
  const s: Sheet = {
    id: sharedSheet ? "fixture-shared" : `fixture-${target}`, tab: `fixture-${target}`,
    header: ["extra", ...[...columns].reverse(), ""], rows: [], plan: [], appends: 0, unreadable: false,
  };
  sheets.set(`${s.id}/${s.tab}`, s);
  return s;
}

function consumer(target: Target, s: Sheet) {
  const persist = { failed: false };
  const hooks = { onPersistError: () => { persist.failed = true; } };
  const config = {
    telegramToken: `FAKE:${target}`, storage: "memory" as const, google: null,
    errorChatId: "", allowedChatIds: [123], expandShortUrls: false, logLevel: "info",
  };
  const opts = { credentials: { client_email: "fixture@example.invalid", private_key: "fake" }, sheetId: s.id, sheetName: s.tab };
  const bot = target === "voc" || target === "tbvoc"
    ? shellBot({ ...config, target }, new ShellStorage({ ...opts, columns: (target === "voc" ? VOC_TARGET : TBVOC_TARGET).columns }), hooks, target === "voc" ? VOC_TARGET : TBVOC_TARGET)
    : ofBot(config, new OfStorage({ ...opts, prodSheetName: "unused-fixture-approved" }), hooks);
  bot.botInfo = { id: 1, is_bot: true, first_name: "fixture", username: "fixture_bot" } as typeof bot.botInfo;
  return { bot, persist };
}

function update(id = 17, chat = 123): Update {
  return { update_id: id, message: {
    message_id: id, date: 0, chat: { id: chat, type: "private", first_name: "fixture" },
    from: { id: chat, is_bot: false, first_name: "fixture" }, text: URL,
  } } as Update;
}
function queue() { return { pending: [update()], offsets: [] as number[], failAck: false }; }
function drain(c: ReturnType<typeof consumer>, q: ReturnType<typeof queue>) {
  vi.spyOn(c.bot.telegram, "getUpdates").mockImplementation(async (_t, _l, offset) => {
    q.offsets.push(offset);
    if (q.failAck && offset > 0) throw new Error("fake crash before ack");
    q.pending = q.pending.filter((u) => u.update_id >= offset);
    return [...q.pending];
  });
  return drainUpdates(c.bot, c.persist, "fixture");
}
async function settle<T>(promise: Promise<T>): Promise<T> {
  const caught = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.runAllTimersAsync();
  const result = await caught;
  if ("error" in result) throw result.error;
  return result.value;
}
function expectRecorded(reply: string) {
  expect(reply).toMatch(/已收進參考池|已以 unsupported 收錄/);
  expect(reply).not.toContain("待查證");
}
function expectPending(reply: string) {
  expect(reply).toContain("待查證");
  expect(reply).not.toMatch(/沒有存進|已收進|已以 unsupported 收錄/);
}

let replies: string[];
beforeEach(() => {
  sheets.clear();
  replies = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T03:00:00Z"));
  for (const level of ["info", "warn", "error"] as const) vi.spyOn(logger, level).mockImplementation(() => {});
  vi.spyOn(Telegram.prototype, "callApi").mockImplementation(async (method, payload) => {
    if (method !== "sendMessage") throw new Error(`unexpected fake Telegram method: ${method}`);
    replies.push(String((payload as { text: string }).text));
    return {} as never;
  });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external fetch prohibited"); }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(TARGETS)("%s neutral intake verification", (target) => {
  it("accepted handler entry has no recorded reply while append is still pending", async () => {
    const s = fixture(target);
    let release!: () => void;
    s.pause = new Promise((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { s.entered = resolve; });
    const q = queue();
    const pending = drain(consumer(target, s), q);
    await entered;
    expect(s.rows).toHaveLength(0);
    expect(replies).toEqual([]);
    expect(q.offsets).toEqual([0]);
    release();
    expect(await settle(pending)).toEqual({ processed: 1, aborted: false });
    expect(s.rows).toHaveLength(1);
    expectRecorded(replies[0]!);
    expect(q.pending).toEqual([]);
  });

  it.each(["ok", "before", "lost"] as const)("%s then warm/cold repeated delivery records one row", async (first) => {
    const s = fixture(target);
    s.plan = [first];
    const c = consumer(target, s);
    await settle(c.bot.handleUpdate(update()));
    expectRecorded(replies[0]!);
    await settle(c.bot.handleUpdate(update()));
    await settle(consumer(target, s).bot.handleUpdate(update()));
    expect(replies.slice(1).every((reply) => reply.includes("沒有重複寫入"))).toBe(true);
    expect(s.rows).toHaveLength(1);
    expect(s.appends).toBe(first === "before" ? 2 : 1);
  });

  it.each(["exhausted-before", "exhausted-lost", "lost-unreadable"] as const)("%s is pending verification and remains unacked until cold replay", async (scenario) => {
    const s = fixture(target);
    s.plan = scenario === "lost-unreadable" ? ["lost-unreadable"] : ["before", "before", "before", scenario === "exhausted-lost" ? "lost" : "before"];
    const q = queue();
    const result = await settle(drain(consumer(target, s), q));
    expect(result).toEqual({ processed: 0, aborted: true });
    expect(exitCodeFor(result)).toBe(2);
    expectPending(replies[0]!);
    expect(q.offsets).toEqual([0]);
    expect(q.pending).toHaveLength(1);
    expect(s.rows).toHaveLength(scenario === "exhausted-before" ? 0 : 1);
    expect(s.appends).toBe(scenario === "lost-unreadable" ? 1 : 4);
    s.unreadable = false;
    const previousAppends = s.appends;
    expect(await settle(drain(consumer(target, s), q))).toEqual({ processed: 1, aborted: false });
    expect(s.rows).toHaveLength(1);
    expect(s.appends).toBe(previousAppends + (scenario === "exhausted-before" ? 1 : 0));
    expect(q.pending).toEqual([]);
    if (scenario === "exhausted-before") expectRecorded(replies[1]!);
    else expect(replies[1]).toContain("沒有重複寫入");
  });

  it("committed row survives crash before ack and cold replay does not append again", async () => {
    const s = fixture(target);
    const q = queue();
    q.failAck = true;
    await expect(settle(drain(consumer(target, s), q))).rejects.toThrow("fake crash before ack");
    expect(s.rows).toHaveLength(1);
    expect(q.pending).toHaveLength(1);
    q.failAck = false;
    await settle(drain(consumer(target, s), q));
    expect(s.appends).toBe(1);
    expect(q.pending).toEqual([]);
    expect(replies[1]).toContain("沒有重複寫入");
  });

  it("unauthorized fake source is not accepted into storage", async () => {
    const s = fixture(target);
    await settle(consumer(target, s).bot.handleUpdate(update(17, 999)));
    expect(s.appends).toBe(0);
    expect(s.rows).toEqual([]);
  });
});

it.each([false, true])("four destinations keep same URL/update id separate (shared sheet=%s)", async (sharedSheet) => {
  const fixtures = TARGETS.map((target) => fixture(target, sharedSheet));
  fixtures[2]!.plan = ["lost-unreadable"];
  const consumers = TARGETS.map((target, i) => consumer(target, fixtures[i]!));
  const queues = TARGETS.map(queue);
  const results = await settle(Promise.all(consumers.map((c, i) => drain(c, queues[i]!))));
  expect(results.map((r) => r.aborted)).toEqual([false, false, true, false]);
  expect(queues.map((q) => q.pending.length)).toEqual([0, 0, 1, 0]);
  fixtures[2]!.unreadable = false;
  await settle(drain(consumer("of", fixtures[2]!), queues[2]!));
  for (const s of fixtures) {
    expect(s.rows).toHaveLength(1);
    expect(s.appends).toBe(1);
    const named = Object.fromEntries(s.header.map((key, i) => [key, s.rows[0]![i]]));
    expect(named.連結 ?? named.CLEAN_URL).toBe(URL);
    expect(s.rows[0]![0]).toBe("");
    expect(s.rows[0]!.at(-1)).toBe("");
  }
});

// Characterization only: existing raw replay policy deliberately permits cross-day re-posts.
it.each(["of", "ofgay"] as const)("known %s boundary: the same unacked raw update across Taipei midnight creates a second row", async (target) => {
  const s = fixture(target);
  const q = queue();
  vi.setSystemTime(new Date("2026-11-15T15:59:59Z"));
  q.failAck = true;
  await expect(settle(drain(consumer(target, s), q))).rejects.toThrow("fake crash before ack");
  vi.setSystemTime(new Date("2026-11-15T16:00:01Z"));
  q.failAck = false;
  await settle(drain(consumer(target, s), q));
  expect(s.rows).toHaveLength(2);
  expect(s.appends).toBe(2);
});

// A retained failed shell instance must refresh its index before retrying,
// just as the next production drain's fresh instance verifies the committed row.
it.each(["voc", "tbvoc"] as const)("%s: reusing the failed warm instance verifies the terminal committed row", async (target) => {
  const s = fixture(target);
  s.plan = ["before", "before", "before", "lost"];
  const c = consumer(target, s);
  await settle(c.bot.handleUpdate(update()));
  expectPending(replies[0]!);
  expect(c.persist.failed).toBe(true);
  expect(s.rows).toHaveLength(1);
  await settle(c.bot.handleUpdate(update()));
  expect(replies[1]).toContain("沒有重複寫入");
  expect(s.rows).toHaveLength(1);
  expect(s.appends).toBe(4);
});
