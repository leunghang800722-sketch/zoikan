// WA-9 (7)：GuardMatchIndex 的姓名視圖（簡繁正規化後）——名單／caption 配對用。
import type { GuardMatchIndex } from "@/lib/roster-upload/match";
import { normNameVariant } from "@/lib/names/variants";

export interface NameView {
  /** 簡繁正規化姓名／別名 → guardIds */
  byVariant: Map<string, string[]>;
  /** 全部已知姓名（正規化後），供名單拆黏名／合併 */
  known: Set<string>;
}

const cache = new WeakMap<GuardMatchIndex, NameView>();

export function nameViewOf(idx: GuardMatchIndex): NameView {
  const hit = cache.get(idx);
  if (hit) return hit;
  const byVariant = new Map<string, string[]>();
  const add = (k: string, ids: readonly string[]): void => {
    const nk = normNameVariant(k);
    if (!nk) return;
    const cur = byVariant.get(nk) ?? [];
    for (const g of ids) if (!cur.includes(g)) cur.push(g);
    byVariant.set(nk, cur);
  };
  for (const [k, ids] of idx.byName) add(k, ids);
  for (const [k, ids] of idx.byAlias) add(k, ids);
  const v: NameView = { byVariant, known: new Set(byVariant.keys()) };
  cache.set(idx, v);
  return v;
}

/** 名 → 全體配到嘅 guardIds（簡繁容錯）。 */
export const guardsByName = (idx: GuardMatchIndex, name: string): string[] => nameViewOf(idx).byVariant.get(normNameVariant(name)) ?? [];

/** 文字入面有冇出現過已知姓名（2–4 字滑動視窗；判頭群 assume_today 用）。 */
export function textHasKnownName(idx: GuardMatchIndex, text: string): boolean {
  const { known } = nameViewOf(idx);
  const t = text.normalize("NFKC");
  for (let i = 0; i < t.length; i++) for (let len = 2; len <= 4 && i + len <= t.length; len++) if (known.has(normNameVariant(t.slice(i, i + len)))) return true;
  return false;
}
