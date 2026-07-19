/** of 專屬總表 gate 告警；共用 drain 迴圈在 ../../shared/drainLoop.ts。 */
import { logger } from "./utils/logger.js";

/**
 * 總表 gate 失效告警追蹤器(feed 專屬:svb/cc 無 gate)。
 * send 維持同步 fire(onGateSkip 在 handleUpdate 深處呼叫,不能 await);
 * 但 promise 要留著 —— drain 收尾改成 process.exit(exitCodeFor) 後,exit 會砍在途 I/O,
 * entry 必須先 await flush() 再退出,否則 gate 告警被砍(fire-and-forget 的舊寫法就是這樣丟的)。
 * 每輪 drain 至多告警一次(一輪失效通常整輪失效,逐訊息轟炸沒有資訊量);errorChatId 空 = no-op。
 */
export function makeGateAlerter(
  errorChatId: string,
  sendMessage: (chatId: string, text: string) => Promise<unknown>,
): { send: (detail: string) => void; flush: () => Promise<void> } {
  let alerted = false;
  let pending: Promise<void> = Promise.resolve();
  return {
    send(detail: string): void {
      if (alerted || !errorChatId) return;
      alerted = true;
      pending = sendMessage(errorChatId, `🐞 ${detail}`).then(
        () => undefined,
        // 告警本身失敗不能拋出(不影響 drain 結果/exit code),記錄即可。
        (e) => logger.error("通知 error chat 失敗", e),
      );
    },
    async flush(): Promise<void> {
      await pending;
    },
  };
}
