/**
 * 擋回流閘門的比對鍵 —— **單一來源**。
 *
 * 這道閘門問的是「這支片是不是已經在總表(已產出/待拍池)裡了」。原本拿 core cleanUrl 的
 * 輸出做**精確字串比對**,於是它對「參數」與「網址形態」都敏感:
 *   - 同一支片換一種分享形態(youtu.be ↔ watch?v= ↔ shorts)→ 字串不同 → 穿過閘門
 *   - 帶一個 TRACKING_PARAMS 還沒收錄的新分享參數 → 字串不同 → 穿過閘門
 * 每次平台改分享參數就要追一次清單,是打不完的地鼠。
 *
 * groupKey 本來就是「同一支片同一把鍵」的演算法(跨語言契約 contracts/voc 守著),
 * 拿它當閘門鍵就把整個「參數/形態敏感」類別一次消掉。
 *
 * ⚠️ 兩件事讓這個改動不會過度攔截:
 *   1. 閘門只在 `!ex.unsupported`(core 真的抽到 video id)時才被查 —— 進來的鍵一定是
 *      `平台_id` 形態,不會是 groupKey 的路徑 fallback(那個會砍掉 query)。
 *   2. 歷史列即使算出路徑 key 也只是躺在集合裡:路徑 key 以 `http` 開頭,永遠不可能
 *      等於 id key。tests/of/approvedGate.test.ts 有負向測試釘住這條界線。
 *
 * 建集合(歷史列)與查詢(新進連結)兩側都必須走這支,否則就是兩個手抄的正規化流程,
 * 遲早分叉 —— 那正是這道閘門 2026-08-01(M11)已經踩過一次的坑。
 */
import { cleanUrl as coreCleanUrl, groupKey } from "@pei760730/collector-core";

/**
 * 連結 → 閘門比對鍵。空字串(或全空白)回空字串,由呼叫端當「無命中」處理。
 * 冪等:已經是乾淨連結的輸入不會被改壞(cleanUrl 冪等,groupKey 純函式)。
 */
export function approvedGateKey(url: string): string {
  const trimmed = url.trim();
  // 介面契約:空字串視為無命中(呼叫端拿空鍵去查集合也永遠不會中,但早退比較誠實)。
  if (!trimmed) return "";
  return groupKey(coreCleanUrl(trimmed).cleanUrl);
}
