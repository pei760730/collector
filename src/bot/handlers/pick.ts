/**
 * /pick handler —— 把員工報的參考池編碼(R####)在「參考池」打勾,交 voc pick 搬進待拍。
 * runPick 不依賴 Telegraf,吃 PoolStore 介面,好用 MemoryPool 寫測試。
 */
import type { PoolStore } from "../../storage/poolPick.js";

export interface PickDeps {
  pool: PoolStore;
}

export interface PickResult {
  reply: string;
}

/** 從 "R1990 R2003, r12" 抽出編碼 token(含/不含 R 前綴皆可)。 */
export function parseCodes(text: string): string[] {
  return text.match(/[A-Za-z]*\d+/g) ?? [];
}

/** 兩編碼是否指同列:大小寫無關;允許省略 R 前綴只給數字(忽略前導零)。 */
function sameCode(refId: string, input: string): boolean {
  const a = refId.trim().toUpperCase();
  const b = input.trim().toUpperCase();
  if (a === b) return true;
  const da = a.replace(/\D/g, "");
  const db = b.replace(/\D/g, "");
  return da !== "" && db !== "" && Number(da) === Number(db);
}

export async function runPick(codesText: string, deps: PickDeps): Promise<PickResult> {
  const codes = parseCodes(codesText);
  if (codes.length === 0) {
    return {
      reply:
        "用法:/pick R1990(可一次多筆:/pick R1990 R2003)。\n把員工報的參考池編碼打勾,等 voc 搬進「待拍」。",
    };
  }

  const refs = await deps.pool.readPool();
  const ticked: string[] = [];
  const already: string[] = [];
  const notFound: string[] = [];

  for (const code of codes) {
    const ref = refs.find((r) => r.id && sameCode(r.id, code));
    if (!ref) {
      notFound.push(code);
      continue;
    }
    if (ref.checked) {
      already.push(ref.id);
      continue;
    }
    await deps.pool.setPick(ref.rowNumber);
    ref.checked = true; // 同次訊息重複編碼不重打
    ticked.push(ref.id);
  }

  const lines: string[] = [];
  if (ticked.length) lines.push(`✅ 已打勾 ${ticked.length} 筆:${ticked.join(" ")}`);
  if (already.length) lines.push(`♻️ 本來就打勾:${already.join(" ")}`);
  if (notFound.length) lines.push(`❓ 參考池找不到:${notFound.join(" ")}`);
  if (ticked.length) lines.push("等 voc pick 跑就會搬進「待拍」。");
  return { reply: lines.join("\n") };
}
