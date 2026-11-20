/**
 * collect.yml 的 Step Summary:拿 drainLoop 真的會印的收尾行(formatDrainSummary)餵給
 * workflow 裡真的那段 bash,釘住「完成 / 有訊息失敗未寫入 / 中止 / 已處理但沒回條 / 沒跑 /
 * 沒有收尾行」各自顯示不同標籤,且 step 永遠綠(exit 0)。
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { formatDrainSummary, newDrainTally, type DrainTally } from "../../src/shared/drainLoop.js";

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
  });
  return { status: result.status, summary: readFileSync(summaryFile, "utf8") };
}

const tally = (over: Partial<DrainTally>): DrainTally => ({ ...newDrainTally(), ...over });
const stamp = (line: string) => `[2026-11-21T00:00:00.000Z] INFO ${line}\n`;

describe("collect.yml Step Summary:多批時「會重領」與「已被收走需重新操作」兩件事同時顯示", () => {
  const lost = { processed: 2, saved: 1, unwritten: 1, acked: 1, ackedUnwritten: 1 };
  it.each([
    ["中斷", formatDrainSummary(null, tally(lost))],
    ["中止", formatDrainSummary({ processed: 2, aborted: true }, tally(lost))],
  ])("%s:標籤同時含未確認段重領與已被確認收走需重新操作", (_n, line) => {
    const { status, summary } = runStep(stamp(line));
    expect(status).toBe(0);
    const label = summary.split("\n")[1]!;
    expect(label).toContain("下輪重領");
    expect(label).toContain("已被確認收走");
    expect(label).toContain("連結重貼、夯度重按");
  });
});

describe("collect.yml job 層失敗通知:不再無條件說「佇列沒排空、需要重跑」", () => {
  it("failure 分支的文字提示:收尾行寫「已被確認收走」= 佇列已排空、重跑領不回", () => {
    const workflow = readFileSync(workflowPath, "utf8");
    const block = workflow.slice(workflow.indexOf("  notify-broken:"));
    const failureText = block.match(/\|\| '(🔴 collector drain 失敗[^']*)'/)?.[1] ?? "";
    expect(failureText).toContain("已被確認收走");
    expect(failureText).toContain("不用重跑");
    // 公共尾巴不得再把「需要重跑」套在 failure 上(cancelled 分支才保留)
    expect(block).not.toMatch(/\}\} —— 這輪抓片佇列沒排空,需要重跑 —/);
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
      "A 已寫入但沒回條",
      formatDrainSummary(null, tally({ processed: 2, saved: 2 })),
      "🔴 有更新已處理但沒回條",
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
