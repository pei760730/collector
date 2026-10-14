import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const bash = process.platform === "win32" ? "C:/Program Files/Git/usr/bin/bash.exe" : "bash";
const workflowPath = new URL("../../.github/workflows/heartbeat.yml", import.meta.url);

function watchdogScript(): string {
  const workflow = readFileSync(workflowPath, "utf8");
  const block = workflow.match(/        run: \|\r?\n((?:          .*\r?\n|\r?\n)+)/)?.[1];
  if (!block) throw new Error("heartbeat 缺少 bash watchdog run block");
  return block.replace(/^ {10}/gm, "");
}

function runStub(ageHours: number | null, dispatchFails = false, apiFails = false) {
  const createdAt = ageHours === null ? "" : new Date(Date.now() - ageHours * 3_600_000).toISOString();
  const script = `
    gh() {
      if [ "$1" = api ]; then
        if [ "$STUB_API_FAILS" = true ]; then return 1; fi
        printf '%s\\n' "$STUB_CREATED_AT"
      elif [ "$1" = workflow ] && [ "$2" = run ]; then
        echo STUB_DISPATCH
        if [ "$STUB_DISPATCH_FAILS" = true ]; then return 1; fi
      elif [ "$1" = workflow ] && [ "$2" = enable ]; then
        echo STUB_ENABLE
        return 1 # 模擬已啟用／enable 失敗：明確 best-effort，不阻擋 freshness check。
      else
        echo "unexpected gh call: $*" >&2
        return 2
      fi
    }
    ${watchdogScript()}
  `;
  // GITHUB_OUTPUT / STEP_SUMMARY 用暫存檔(Windows Git Bash 在 spawnSync 下沒有 /dev/stdout),
  // 跑完把兩檔內容併進 stdout 供斷言。
  const dir = mkdtempSync(join(tmpdir(), "heartbeat-"));
  const outputFile = join(dir, "output");
  const summaryFile = join(dir, "summary");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");
  const result = spawnSync(bash, ["-e", "-o", "pipefail", "-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      GH_REPO: "stub/collector",
      GH_TOKEN: "stub-token",
      RUN_URL: "https://example.com/actions/runs/123",
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      STUB_CREATED_AT: createdAt,
      STUB_DISPATCH_FAILS: String(dispatchFails),
      STUB_API_FAILS: String(apiFails),
    },
  });
  return {
    ...result,
    stdout: `${result.stdout}${readFileSync(outputFile, "utf8")}${readFileSync(summaryFile, "utf8")}`,
  };
}

describe("heartbeat bash watchdog", () => {
  it("實際 run block 通過 bash -n", () => {
    const result = spawnSync(bash, ["-n"], { input: watchdogScript(), encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["現在", 0, false, false],
    ["7h 前", 7, true, false],
    ["20h 前", 20, true, true],
    ["空", null, true, true],
  ] as const)("created_at=%s → dispatch=%s / alert=%s", (_label, age, dispatch, alert) => {
    const result = runStub(age);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.includes("STUB_DISPATCH")).toBe(dispatch);
    expect(result.stdout).toContain(`alert=${alert}`);
    if (dispatch) expect(result.stdout).toContain("已自動補觸發");
    if (alert) expect(result.stdout).toContain("Telegram 只留 24h");
  });

  it("7h 前自癒失敗 → alert=true 並明講補觸發失敗", () => {
    const result = runStub(7, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("alert=true");
    expect(result.stdout).toContain("自動補觸發失敗");
  });

  it("查詢 API 失敗 → step 非 0，交由 job 層 failure 通知", () => {
    const result = runStub(0, false, true);
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("STUB_DISPATCH");
  });
});

describe("collect failure message", () => {
  it("ERR 在截斷前遮蔽 Telegram token，即使 token 跨過 280 字元邊界", () => {
    const workflow = readFileSync(new URL("../../.github/workflows/collect.yml", import.meta.url), "utf8");
    const errLine = workflow.split(/\r?\n/).find((line) => line.trim().startsWith("ERR=$(grep"));
    expect(errLine).toBeDefined();
    const script = `
      grep() { if [ "$1" = -iE ]; then printf '%s\\n' "$STUB_ERR"; else command grep "$@"; fi; }
      python3() { head -c 280; }
      ${errLine}
      printf '%s' "$ERR"
    `;
    const result = spawnSync(bash, ["-c", script], {
      encoding: "utf8",
      // 填到 240 字:未遮的 `/bot123456:AAH-x_y` 落在 264–282,正好跨過 280 截斷點。
      // 若先截斷再遮,會留下半截 `/bot123456:AAH-x`(sed 吃不到不完整的形態也照樣外洩)。
      env: { ...process.env, STUB_ERR: "Error: ".padEnd(240, ".") + "https://api.telegram.org/bot123456:AAH-x_y/getUpdates" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("/bot***");
    expect(result.stdout).not.toContain("123456:AAH");
    expect(errLine!.indexOf("sed -E")).toBeGreaterThan(0);
    expect(errLine!.indexOf("sed -E")).toBeLessThan(errLine!.indexOf("python3"));
  });
});
