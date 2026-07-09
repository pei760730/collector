/**
 * 平台碼 → emoji 的單一 SSoT,已上移至 collector-core(code→icon 反查表 SSoT 派生自
 * PLATFORM_CODE × PLATFORM_ICON;core v0.3.0 起提供 iconFor / ICON_BY_CODE)。
 * 本檔保留為薄再匯出,維持既有 importer(stats.ts / templates.ts)的匯入路徑不變。
 * SUPPORTED_PLATFORMS 是本 repo 專屬(未抽 core),動態自 core 的 PLATFORM_CODE 派生
 * (對齊 clip-collector 同款做法)。
 */
export { iconFor, ICON_BY_CODE } from "@pei760730/collector-core";

import { PLATFORM_CODE, type Platform } from "./types.js";

/** 支援平台顯示名(排除 Unknown),動態自 PLATFORM_CODE 派生,避免手寫清單與 core 漂移。 */
export const SUPPORTED_PLATFORMS: string[] = (Object.keys(PLATFORM_CODE) as Platform[]).filter(
  (p) => p !== "Unknown",
);
