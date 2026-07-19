/**
 * shell/of 共用 append 冪等護欄的整合契約。
 *
 * 同一組案例各跑兩個 storage adapter，確認兩 target 都保留三態：fresh 查詢成功只讀一次、
 * 查到已落表提早收手、查詢失敗不快取；另釘住空 dedupKey/VIDEO_ID 時退回原重試行為。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeaderLayout } from "@pei760730/collector-core";
import { GoogleSheetsStorage as ShellGoogleSheetsStorage } from "../../src/storage/googleSheets.js";
import type { RefRow } from "../../src/types.js";
import { GoogleSheetsStorage as OfGoogleSheetsStorage } from "../../src/engines/of/storage/googleSheets.js";
import type { StagingRow } from "../../src/engines/of/types.js";

const SHELL_LAYOUT: HeaderLayout = {
  indexOf: { 平台: 0, 連結: 1, 挑: 2, 加入日期: 3 },
  width: 4,
};
const SHELL_ROW: RefRow = {
  平台: "youtube",
  連結: "https://youtu.be/dQw4w9WgXcQ",
  挑: "",
  加入日期: "2026-06-26",
};

const OF_LAYOUT: HeaderLayout = {
  indexOf: { PLATFORM: 0, DATE: 1, CLEAN_URL: 2, VIDEO_ID: 3, STATUS: 4 },
  width: 5,
};
const OF_ROW: StagingRow = {
  PLATFORM: "TikTok",
  DATE: "2026-07-08",
  CLEAN_URL: "https://www.tiktok.com/@u/video/123",
  VIDEO_ID: "tt_123",
  STATUS: "pending_review",
};
const OF_ROW_CELLS = ["TikTok", "2026-07-08", OF_ROW.CLEAN_URL, "tt_123", "pending_review"];

type AppendImpl = () => Promise<unknown>;
type FreshContainsKey = () => Promise<boolean>;

interface AppendHarness {
  run(): Promise<void>;
  appendCalls(): number;
  guardReadCalls(): number;
}

type HarnessFactory = (
  appendImpl: AppendImpl,
  freshContainsKey: FreshContainsKey,
  emptyKey?: boolean,
) => AppendHarness;

function makeShellHarness(
  appendImpl: AppendImpl,
  freshContainsKey: FreshContainsKey,
  emptyKey = false,
): AppendHarness {
  const storage = new ShellGoogleSheetsStorage({
    credentials: {
      client_email: "x@y.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
    },
    sheetId: "sid",
    sheetName: "參考池",
  });
  (storage as unknown as { layoutCache?: HeaderLayout }).layoutCache = SHELL_LAYOUT;

  const appendSpy = vi.fn(appendImpl);
  (storage as unknown as { sheets: { spreadsheets: { values: { append: unknown } } } }).sheets = {
    spreadsheets: { values: { append: appendSpy } },
  } as never;
  const guardReadSpy = vi.spyOn(storage, "readRows").mockImplementation(async () =>
    (await freshContainsKey()) ? [{ row: SHELL_ROW, rowNumber: 2 }] : [],
  );
  const row = emptyKey ? { ...SHELL_ROW, 連結: "" } : SHELL_ROW;

  return {
    run: () => storage.append(row),
    appendCalls: () => appendSpy.mock.calls.length,
    guardReadCalls: () => guardReadSpy.mock.calls.length,
  };
}

function makeOfHarness(
  appendImpl: AppendImpl,
  freshContainsKey: FreshContainsKey,
  emptyKey = false,
): AppendHarness {
  const storage = new OfGoogleSheetsStorage({
    credentials: {
      client_email: "x@y.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
    },
    sheetId: "sid",
    sheetName: "暫存區",
    prodSheetName: "總表",
  });
  (storage as unknown as { layoutCache?: HeaderLayout }).layoutCache = OF_LAYOUT;

  const appendSpy = vi.fn(appendImpl);
  (storage as unknown as { sheets: { spreadsheets: { values: { append: unknown } } } }).sheets = {
    spreadsheets: { values: { append: appendSpy } },
  } as never;
  const guardReadSpy = vi
    .spyOn(
      storage as unknown as {
        rawRows: (layout: HeaderLayout) => Promise<{ rowNumber: number; cells: string[] }[]>;
      },
      "rawRows",
    )
    .mockImplementation(async () =>
      (await freshContainsKey()) ? [{ rowNumber: 2, cells: OF_ROW_CELLS }] : [],
    );
  const row = emptyKey ? { ...OF_ROW, VIDEO_ID: "" } : OF_ROW;

  return {
    run: () => storage.append(row),
    appendCalls: () => appendSpy.mock.calls.length,
    guardReadCalls: () => guardReadSpy.mock.calls.length,
  };
}

const TARGETS: { name: string; create: HarnessFactory }[] = [
  { name: "shell(dedupKey)", create: makeShellHarness },
  { name: "of(VIDEO_ID)", create: makeOfHarness },
];

function rateLimit(): Error & { code: number } {
  const err = new Error("rate limit") as Error & { code: number };
  err.code = 429;
  return err;
}

function appendSuccess() {
  return { data: { updates: { updatedRange: "'暫存區'!A2:E2" } } };
}

async function settleRetries(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    const pending = run();
    await vi.runAllTimersAsync();
    await pending;
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(TARGETS)("$name append 冪等護欄", ({ create }) => {
  it("fresh 查詢成功 → 整個重試窗只讀一次", async () => {
    let attempts = 0;
    const harness = create(async () => {
      attempts += 1;
      if (attempts < 3) throw rateLimit();
      return appendSuccess();
    }, async () => false);

    await settleRetries(harness.run);

    expect(harness.appendCalls()).toBe(3);
    expect(harness.guardReadCalls()).toBe(1);
  });

  it("server 已提交但回應遺失 → fresh key 命中後提早收手，不產生重複列", async () => {
    let committedRows = 0;
    const harness = create(async () => {
      committedRows += 1; // 模擬 Google server 已落表
      if (committedRows === 1) throw rateLimit(); // 但 client 收到暫態錯誤
      return appendSuccess();
    }, async () => committedRows > 0);

    await settleRetries(harness.run);

    expect(harness.appendCalls()).toBe(1);
    expect(harness.guardReadCalls()).toBe(1);
    expect(committedRows).toBe(1);
  });

  it("fresh 查詢失敗 → 不快取失敗，下一次重試再查", async () => {
    let attempts = 0;
    const harness = create(async () => {
      attempts += 1;
      if (attempts < 3) throw rateLimit();
      return appendSuccess();
    }, async () => {
      throw new Error("guard read failed");
    });

    await settleRetries(harness.run);

    expect(harness.appendCalls()).toBe(3);
    expect(harness.guardReadCalls()).toBe(2);
  });

  it("空 key → 不查 fresh keys，退回原本的 withRetry 行為", async () => {
    let attempts = 0;
    const harness = create(async () => {
      attempts += 1;
      if (attempts < 3) throw rateLimit();
      return appendSuccess();
    }, async () => true, true);

    await settleRetries(harness.run);

    expect(harness.appendCalls()).toBe(3);
    expect(harness.guardReadCalls()).toBe(0);
  });

  it("每次 append 各自持有 fresh key cache，不與同 instance 下一次 append 串味", async () => {
    let attempts = 0;
    const harness = create(async () => {
      attempts += 1;
      if (attempts % 3 !== 0) throw rateLimit();
      return appendSuccess();
    }, async () => false);

    await settleRetries(harness.run);
    await settleRetries(harness.run);

    expect(harness.appendCalls()).toBe(6);
    expect(harness.guardReadCalls()).toBe(2);
  });
});
