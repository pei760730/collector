/**
 * 公開 Actions log 的錯誤輸出紀律(src/shared/errorSummary.ts)。
 *
 * drain/index 四個 entry 的最外層 catch 都走 logFatal;entry 本身 import 即執行(還會 process.exit),
 * 直接 import 進測試會把整支 entry 拉進 coverage 又測不到,所以在 helper 這層釘語意。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "@pei760730/collector-core";
import { errDetail, errSummary, logFatal, redactSecrets } from "../../src/shared/errorSummary.js";

const TOKEN_URL = "https://api.telegram.org/bot123456:AAH-x_y/getUpdates";

afterEach(() => vi.restoreAllMocks());

describe("logFatal(drain/index 最外層 catch)", () => {
  it("message 與 stack 的 Telegram token 都遮掉、不印 config.body、只印單一字串", () => {
    const failure = Object.assign(new Error(`body failed ${TOKEN_URL}`), {
      stack: `Error: ${TOKEN_URL}\n    at drain (fake:1:1)`,
      config: { body: "SECRETLINK" },
    });
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});

    logFatal("drain 失敗", failure);

    expect(error).toHaveBeenCalledOnce();
    const args = error.mock.calls[0]!;
    expect(args.every((arg) => typeof arg === "string")).toBe(true);
    const output = args.join(" ");
    expect(output).toContain("drain 失敗:");
    expect(output).toContain("body failed");
    expect(output).toContain("at drain (fake:1:1)");
    expect(output).toContain("/bot***");
    expect(output).not.toContain("AAH-x_y");
    expect(output).not.toContain("SECRETLINK");
  });
});

describe("errSummary / errDetail", () => {
  it("非物件錯誤 → String 後遮秘密", () => {
    expect(errSummary(`boom ${TOKEN_URL}`)).toBe("boom https://api.telegram.org/bot***/getUpdates");
    expect(errSummary(undefined)).toBe("undefined");
  });

  it("數字 code = HTTP 狀態;字串 code 另列;Google reason 取 errors[0].reason", () => {
    const quota = Object.assign(new Error("Rate Limit Exceeded"), {
      code: 403,
      errors: [{ reason: "userRateLimitExceeded" }],
    });
    expect(errSummary(quota)).toBe("Error: Rate Limit Exceeded status=403 reason=userRateLimitExceeded");

    const net = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(errSummary(net)).toBe("Error: socket hang up code=ECONNRESET");
  });

  it("response.status 與 response.data.error.errors[0].reason;不輸出 response.data 其他欄位", () => {
    const gaxios = Object.assign(new Error("The caller does not have permission"), {
      response: {
        status: 403,
        data: { error: { errors: [{ reason: "forbidden" }], message: "SECRETLINK in data" } },
      },
    });
    const summary = errSummary(gaxios);
    expect(summary).toBe("Error: The caller does not have permission status=403 reason=forbidden");
    expect(summary).not.toContain("SECRETLINK");
  });

  it("errDetail:沒有 stack 時只回摘要", () => {
    const plain = { name: "TelegramError", message: "Bad Request" };
    expect(errDetail(plain)).toBe("TelegramError: Bad Request");
  });

  it("redactSecrets 只動 /bot<id>:<token> 形態", () => {
    expect(redactSecrets("no secrets here /bot/ x")).toBe("no secrets here /bot/ x");
  });
});
