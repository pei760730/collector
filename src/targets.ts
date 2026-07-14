/**
 * Target 定義 —— #9 三併一:一份殼 + N 份 target(2026-07-06 拍板)。
 * 「會隨表不同而變」的東西全收在這:欄位 schema、夯度按鈕、成功文案、擁有者提示、
 * drain 中止告警開關。殼(router/collect/storage/drain)一律吃 TargetSpec,不認識任何一張表。
 *
 * 對外行為零變更是鐵律:voc target = 既有 short-video-bot 行為逐字;tbvoc target = 既有
 * clip-collector 行為逐字。改這裡的字串 = 改對外行為,動之前先想清楚。
 *
 * 生產組裝點只有一個:drain.ts 依 config.target(env COLLECTOR_TARGET,預設 voc)取 spec。
 * 測試與殼內各處的預設參數(= voc)只是讓既有 voc 測試零改動,不是第二個組裝點。
 */
import type { RefRow } from "./types.js";
import { POOL_COLUMNS } from "./types.js";
import { successMsg as vocSuccessMsg } from "./messages/templates.js";
import { iconFor } from "./platformIcon.js";

export type TargetName = "voc" | "tbvoc";

export interface SuccessOpts {
  unsupported: boolean;
  isShortUrl: boolean;
  note?: string;
  truncated?: boolean;
}

export interface TargetSpec {
  name: TargetName;
  /** 「參考池」表頭順序(SSOT),= 該 target 契約 schema.columns。 */
  columns: readonly (keyof RefRow)[];
  /**
   * 夯度可選值(有 = 掛 inline 按鈕 + 註冊 setHot callback;順序 = 按鈕順序 = callback 索引)。
   * voc 無此功能 → undefined,殼內所有夯度路徑整段不啟用。
   */
  hotValues?: readonly string[];
  /** 收錄成功回覆(兩 target 文案刻意不同,測試各自釘住,勿統一)。 */
  successMsg(row: RefRow, opts: SuccessOpts): string;
  /** fail-fast 文案參數:「參考池由 {name} 擁有,請先用 {initCmd} init-sheet 建表」。 */
  owner: { name: string; initCmd: string };
  /**
   * drain 因寫入失敗中止時,是否直發一則「🐞 drain 中止」到 ERROR_CHAT_ID。
   * clip-collector 既有行為 = true;short-video-bot 既有行為 = false(只靠 exit 2 紅燈
   * + router notifyError)。零變更原則:voc 維持 false,要開請 Kai 拍板(一行 flag)。
   */
  drainAbortAlert: boolean;
}

/** tbvoc 夯度可選值(鏡像 TeaBus-VOC schema.HOT_VALUES;順序=按鈕順序=callback 索引)。 */
export const TBVOC_HOT_VALUES = ["夯爆了", "NPC", "拉完了"] as const;

/** tbvoc「參考池」5 欄(夯度一律最後,tbvoc init-sheet 不錯位)。 */
export const TBVOC_COLUMNS: (keyof RefRow)[] = ["平台", "連結", "挑", "加入日期", "夯度"];

/** clip-collector 既有成功文案,逐字搬入(活潑版;測試釘住,勿與 voc 版統一)。 */
function tbvocSuccessMsg(row: RefRow, opts: SuccessOpts): string {
  const lines = [
    "✅ 已收進參考池!",
    `${iconFor(row.平台)} 平台:${row.平台}`,
    `🔗 連結:${row.連結}`,
  ];
  if (opts.note) lines.push(`📝 備註:${opts.note}`);
  lines.push(`📅 加入日期:${row.加入日期}`);
  if (opts.unsupported) {
    lines.push("⚠️ 這個平台抓不到 video ID,以連結本身去重收錄。");
  }
  if (opts.isShortUrl) {
    lines.push("🔗 偵測到短網址,已標記。");
  }
  if (opts.truncated) {
    lines.push("⚠️ 連結/備註太長,超過上限的部分已剪掉囉!");
  }
  lines.push("👇 順手幫這支標個夯度?");
  return lines.join("\n");
}

export const VOC_TARGET: TargetSpec = {
  name: "voc",
  columns: POOL_COLUMNS,
  successMsg: vocSuccessMsg,
  owner: { name: "voc", initCmd: "voc" },
  drainAbortAlert: false,
};

export const TBVOC_TARGET: TargetSpec = {
  name: "tbvoc",
  columns: TBVOC_COLUMNS,
  hotValues: TBVOC_HOT_VALUES,
  successMsg: tbvocSuccessMsg,
  owner: { name: "TeaBus-VOC", initCmd: "tbvoc" },
  drainAbortAlert: true,
};

const TARGETS: Record<TargetName, TargetSpec> = { voc: VOC_TARGET, tbvoc: TBVOC_TARGET };

export function getTarget(name: TargetName): TargetSpec {
  return TARGETS[name];
}
