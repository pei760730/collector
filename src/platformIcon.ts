/**
 * 平台碼 → emoji 的單一 SSoT,已上移至 collector-core(code→icon 反查表 SSoT 派生自
 * PLATFORM_CODE × PLATFORM_ICON;core v0.3.0 起提供 iconFor / ICON_BY_CODE)。
 * 本檔保留為薄再匯出,維持既有 importer(stats.ts / templates.ts)的匯入路徑不變。
 */
export { iconFor, ICON_BY_CODE } from "@pei760730/collector-core";
