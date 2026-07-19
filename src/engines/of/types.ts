/**
 * 共用型別 + Google Sheet「暫存區」schema(SSOT)。
 * 改欄位只改這裡;storage / messages / handlers 都引用這份。
 *
 * ⚠️ 跨 repo 契約(改 STAGING_COLUMNS / STATUS 值 / 平台清單前先讀):
 *   此 schema 被下游 of-content-engine 的 `tests/fixtures/gas_contract.json` 手動鏡像、
 *   由 `tests/test_gas_contract.py` 守門(GAS 消化端讀「暫存區」搬「總表」)。改任一欄名 /
 *   STATUS 值 / 平台 → 必須同步那份 fixture,否則本 repo 綠、下游 GAS 靜默漂移。
 *   (WORKER_RUN 教訓:producer 單邊改欄、consumer 手動鏡像沒跟 = 收集鏈斷,見 CLAUDE.md 頂部。)
 *

 * 與姊妹專案 short-video-bot 的差異:
 * - 5 欄(不含 SENDER / NOTE / AGE / icon);worker 退役後不再帶下游專用欄。
 * - STATUS 只有 pending_review / unsupported(可解析待選 / 無法解析待人工看)。
 * - 平台前綴 tt_/dy_ 等(非 core 的 tiktok_/douyin_;對照表在 pipeline/extractVideoId.ts),抓不到為 raw_<ts>。
 */

/** 支援平台(寫進 PLATFORM 欄的顯示名)。 */
export type Platform =
  | "Instagram"
  | "TikTok"
  | "YouTube"
  | "Facebook"
  | "X"
  | "小紅書"
  | "Threads"
  | "抖音" // 2026-07-06 隨接 core 新支援(dy_ 前綴)
  | "Other";

/**
 * STATUS 取值:
 * - pending_review:新、可解析,待人工選片 / 下游 GAS 接手。
 * - unsupported:無法解析(VIDEO_ID 為 raw_*),待人工看。
 */
export const STATUS = {
  PENDING_REVIEW: "pending_review",
  UNSUPPORTED: "unsupported",
} as const;
export type Status = (typeof STATUS)[keyof typeof STATUS];

/**
 * 「暫存區」一列 —— 欄位順序即 Sheet 表頭順序,不要改順序。
 */
export interface StagingRow {
  PLATFORM: string;
  DATE: string; // YYYY/M/D (Asia/Taipei)
  CLEAN_URL: string;
  VIDEO_ID: string;
  STATUS: string; // pending_review | unsupported
}

/** 「暫存區」表頭順序(SSOT)。 */
export const STAGING_COLUMNS: (keyof StagingRow)[] = [
  "PLATFORM",
  "DATE",
  "CLEAN_URL",
  "VIDEO_ID",
  "STATUS",
];
