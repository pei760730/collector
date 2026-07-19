/** of 專屬 gate 告警：flush 等送完、每輪至多一則、送失敗不拋出。 */
import { describe, it, expect, vi } from "vitest";
import { makeGateAlerter } from "../../src/engines/of/drainLoop.js";

describe("makeGateAlerter:gate 告警要活過 process.exit(flush 等送完)", () => {
  it("send 同步觸發、flush 等 sendMessage resolve 完才回(exit 前不砍在途告警)", async () => {
    let resolveSend!: () => void;
    let sent = false;
    const sendMessage = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveSend = () => {
            sent = true;
            res();
          };
        }),
    );
    const alerter = makeGateAlerter("424242", sendMessage);
    alerter.send("總表去重跳過:gate 失效");
    expect(sendMessage).toHaveBeenCalledWith("424242", "🐞 總表去重跳過:gate 失效");

    const flushed = vi.fn();
    const flushing = alerter.flush().then(flushed);
    await Promise.resolve(); // 讓 microtask 跑:sendMessage 未 resolve,flush 不得先完成
    expect(flushed).not.toHaveBeenCalled();
    resolveSend();
    await flushing;
    expect(sent).toBe(true); // flush 回來時告警已真的送出
  });

  it("每輪至多一則:第二次 send 不再發", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const alerter = makeGateAlerter("424242", sendMessage);
    alerter.send("第一則");
    alerter.send("第二則(同輪,應吞掉)");
    await alerter.flush();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("errorChatId 空 → no-op,不發也不炸", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const alerter = makeGateAlerter("", sendMessage);
    alerter.send("gate 失效");
    await alerter.flush();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sendMessage 失敗 → flush 不拋出(告警失敗不影響 exit code)", async () => {
    const alerter = makeGateAlerter("424242", () => Promise.reject(new Error("blocked")));
    alerter.send("gate 失效");
    await expect(alerter.flush()).resolves.toBeUndefined();
  });
});
