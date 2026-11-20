/**
 * collect.yml 的 Step Summary:拿 drainLoop 真的會印的收尾行(formatDrainSummary)餵給
 * workflow 裡真的那段 bash,釘住「完成 / 有訊息失敗未寫入 / 中止 / 確認結果不明 / 沒跑 /
 * 沒有收尾行」各自顯示不同標籤,且 step 永遠綠(exit 0)。
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { formatDrainSummary, newDrainTally, type DrainTally } from "../../src/shared/drainLoop.js";

// 每個 case 都 spawn Git Bash(Windows 上單次就可能數百 ms~1s,高負載更久),預設 5s 不夠。
vi.setConfig({ testTimeout: 60_000 });

const bash = process.platform === "win32" ? "C:/Program Files/Git/usr/bin/bash.exe" : "bash";
const workflowPath = new URL("../../.github/workflows/collect.yml", import.meta.url);

function stepScript(): string {
  const workflow = readFileSync(workflowPath, "utf8");
  const start = workflow.indexOf("- name: Step summary");
  if (start < 0) throw new Error("collect.yml 缺少 Step summary step");
  const block = workflow.slice(start).match(/        run: \|\r?\n((?:          .*\r?\n|\r?\n)+)/)?.[1];
  if (!block) throw new Error("Step summary 缺少 run block");
  return block.replace(/^ {10}/gm, "").replaceAll("${{ matrix.target }}", "voc");
}

/** 把 log 內容寫成 drain.log 跑 step,回 Step Summary 內容與 exit code。 */
function runStep(logContent: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "collect-summary-"));
  const summaryFile = join(dir, "summary");
  writeFileSync(summaryFile, "");
  if (logContent !== null) writeFileSync(join(dir, "drain.log"), logContent);
  const result = spawnSync(bash, ["-e", "-o", "pipefail", "-c", stepScript()], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile },
    timeout: 50_000, // 卡住就明確失敗(status=null),不是靜默等到測試逾時
  });
  return { status: result.status, summary: readFileSync(summaryFile, "utf8") };
}

const tally = (over: Partial<DrainTally>): DrainTally => ({ ...newDrainTally(), ...over });
const stamp = (line: string) => `[2026-11-21T00:00:00.000Z] INFO ${line}\n`;

describe("collect.yml Step Summary:多批時「未確認段」與「已被收走需重新操作」兩件事同時顯示", () => {
  const lost = { processed: 2, saved: 1, unwritten: 1, acked: 1, ackedUnwritten: 1 };
  it("中斷:標籤講確認結果不明(不承諾重領)+ 已被確認收走需重新操作", () => {
    const { status, summary } = runStep(stamp(formatDrainSummary(null, tally(lost))));
    expect(status).toBe(0);
    const label = summary.split("\n")[1]!;
    expect(label).toContain("確認結果不明");
    expect(label).not.toContain("下輪重領,去重");
    expect(label).toContain("另有已被確認收走");
    expect(label).toContain("連結重貼、夯度重按");
  });
  it("中止:標籤講因中止沒送出確認、下輪重領 + 已被確認收走需重新操作", () => {
    const { status, summary } = runStep(
      stamp(formatDrainSummary({ processed: 2, aborted: true }, tally(lost))),
    );
    expect(status).toBe(0);
    const label = summary.split("\n")[1]!;
    expect(label).toContain("因中止沒送出確認");
    expect(label).toContain("下輪重領");
    expect(label).toContain("另有已被確認收走");
    expect(label).toContain("連結重貼、夯度重按");
  });
  it("中斷但沒有 K、只有 U(確認結果不明段裡有未寫入):標籤提醒核對表,且不誤報成 K", () => {
    const { summary } = runStep(
      stamp(formatDrainSummary(null, tally({ processed: 1, unwritten: 1 }))),
    );
    const label = summary.split("\n")[1]!;
    expect(label).toContain("確認結果不明");
    expect(label).toContain("請核對表上有沒有");
    expect(label).not.toContain("另有已被確認收走");
  });
});

describe("collect.yml Step Summary:只認摘要行,log 裡別的含「已處理」的行不會被取錯", () => {
  const real = formatDrainSummary(
    { processed: 2, aborted: false },
    tally({ processed: 2, saved: 2, acked: 2 }),
  );
  it("前後都有雜訊行時仍取到真正的摘要行", () => {
    const log =
      "[2026-11-21T00:00:00.000Z] INFO 舊資料已處理 99 筆(雜訊)\n" +
      "[2026-11-21T00:00:01.000Z] ERROR 已處理 7 筆失敗 drain 中斷(假的)\n" +
      stamp(real) +
      "[2026-11-21T00:00:02.000Z] INFO 另一段已處理 5 筆\n";
    const { status, summary } = runStep(log);
    expect(status).toBe(0);
    expect(summary).toContain("✅ 正常收尾");
    expect(summary).toContain(real);
    expect(summary).not.toContain("99");
    expect(summary).not.toContain("另一段");
  });
  it("只有雜訊行(沒有真正的摘要行)→ fallback,不把雜訊當摘要", () => {
    const { status, summary } = runStep("[x] INFO 舊資料已處理 99 筆(雜訊)\n");
    expect(status).toBe(0);
    expect(summary).toContain("沒有「已處理」行");
    expect(summary).not.toContain("99");
  });
});

describe("collect.yml job 層失敗通知:每種收尾下文字各自為真", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const block = workflow.slice(workflow.indexOf("  notify-broken:"));
  // failure 分支的兩段文字(annotation 與 kai-notify 內文)都含「不用重跑」那一句。
  const failureTexts = [...block.matchAll(/\|\| '([^']*不用重跑[^']*)'/g)].map((m) => m[1]!);

  it("找得到 annotation 與 kai-notify 兩段 failure 文字", () => {
    expect(failureTexts).toHaveLength(2);
  });

  it.each([0, 1])("文字 #%i:只有「純 B(drain 有訊息失敗未寫入)」才說佇列已排空/不用重跑", (i) => {
    const clauses = failureTexts[i]!.split(/[;;]/);
    const noRerun = clauses.filter((c) => c.includes("不用重跑"));
    expect(noRerun).toHaveLength(1);
    expect(noRerun[0]).toContain("drain 有訊息失敗未寫入");
    expect(noRerun[0]).not.toContain("drain 中斷");
    expect(noRerun[0]).not.toContain("drain 中止");
  });

  it.each([0, 1])("文字 #%i:中斷/中止帶「已被確認收走」時講成兩件事(下輪自動重領 + 需重新操作)", (i) => {
    const clause = failureTexts[i]!.split(/[;;]/).find((c) => c.includes("drain 中斷"));
    expect(clause).toBeDefined();
    expect(clause).toContain("drain 中止");
    expect(clause).toContain("已被確認收走、不會重領");
    expect(clause).toContain("中止的未確認段下輪會自動重領");
    expect(clause).toContain("中斷的未確認段確認結果不明");
    expect(clause).toContain("重新操作");
    expect(clause).not.toContain("不用重跑");
    expect(clause).not.toContain("佇列已排空");
  });

  it("cancelled 分支只說「可能沒排空」;公共尾巴不再無條件套「需要重跑」", () => {
    expect(block).toContain("被中止(逾時或人為按停) —— 這輪抓片佇列可能沒排空");
    expect(block).not.toContain("佇列沒排空"); // cancelled 可能發生在已排空之後,不斷言
    expect(block).not.toMatch(/\}\} —— 這輪抓片佇列沒排空,需要重跑 —/);
    expect(block).not.toMatch(/\}\} — .*沒做完的話需要重跑/);
  });
});

describe("collect.yml Step Summary:各種收尾各自顯示不同文字", () => {
  const cases: Array<[string, string, string]> = [
    [
      "正常完成",
      formatDrainSummary({ processed: 2, aborted: false }, tally({ processed: 2, saved: 2, acked: 2 })),
      "✅ 正常收尾",
    ],
    [
      "B 沒寫入卻被確認收走",
      formatDrainSummary(
        { processed: 3, aborted: false },
        tally({ processed: 3, unwritten: 3, acked: 3, ackedUnwritten: 3 }),
      ),
      "🔴 有訊息被確認收走但沒寫進表",
    ],
    [
      "中止(寫入失敗)",
      formatDrainSummary({ processed: 1, aborted: true }, tally({ processed: 1, saved: 1 })),
      "🔴 寫入失敗中止",
    ],
    [
      "A 確認結果不明",
      formatDrainSummary(null, tally({ processed: 2, saved: 2 })),
      "🔴 有更新已處理但確認結果不明",
    ],
    ["沒跑(一筆都沒領到)", formatDrainSummary(null, tally({})), "🔴 沒跑:一筆都沒領到"],
  ];

  it.each(cases)("%s", (_name, line, label) => {
    const { status, summary } = runStep(stamp(line));
    expect(status).toBe(0);
    expect(summary).toContain("### drain voc");
    expect(summary).toContain(label);
    expect(summary).toContain(line); // 完整行仍原樣附上
  });

  it("五種標籤彼此不同", () => {
    const labels = cases.map(([, line]) => {
      const { summary } = runStep(stamp(line));
      return summary.split("\n")[1];
    });
    expect(new Set(labels).size).toBe(cases.length);
  });

  it("沒有「已處理」行(守門擋下/沒跑到收尾)→ 退回 fallback 標籤、step 仍綠", () => {
    const noFile = runStep(null);
    expect(noFile.status).toBe(0);
    expect(noFile.summary).toContain("沒有「已處理」行");
    const noLine = runStep("[x] ERROR drain 失敗:boom\n");
    expect(noLine.status).toBe(0);
    expect(noLine.summary).toContain("沒有「已處理」行");
  });
});
