// WP-STAFF-IMPORT B3 / §26.2.4：導入人 ↔ 本系統保安員對齊決策（純函數；伺服器對自己個 DB 做）。
// 次序：hkid → 工號（任何 scheme）→ 電話 → （姓名相同且唯一＋輔助判斷 a–e：見 decideNameOnly）。
// 結果 link／create／conflict／needs_review，理由碼同 Stage A `04-match-plan.ts` 一致
// （script 改 import 呢份，唔再有第二套）。
import { normZh, normTel8 } from "./text";
import { normalizeStaffNumber } from "@/lib/guards/staff-numbers";

export type Action = "link" | "create" | "conflict" | "needs_review";

export interface DbGuard {
  id: string;
  nameZh: string | null;
  hkid: string | null; // canonical
  tels: string[];
  staffNos: string[];
  /** 出生日期 YYYY-MM-DD（無就 null／undefined） */
  dob?: string | null;
}

/** 更表（未作廢上載）入面某 guard 出現過嘅原始工號／電話；批量預載（唔准 N+1）。只計有獨立鍵（工號／電話）配對嘅行，淨靠姓名嘅行唔計（循環佐證）。 */
export interface RosterEvidence {
  staffNoRaws: string[];
  telRaws: string[];
}

export interface MatchInput {
  staffNos: string[]; // 一個人可以有幾個工號（MP 舊號＋U 新號）
  hkid: string | null; // canonical
  hkidValid: boolean; // check digit 通過
  /** hkid 欄狀態唔係 confirmed → 唔准做 hkid 層 link（跌落工號／電話層；都冇就 needs_review）。預設 true。 */
  hkidConfirmed?: boolean;
  nameZh: string | null;
  phone: string | null;
  /** 導入者 confirmed 出生日期（YYYY-MM-DD）；非 confirmed 傳 null */
  dob?: string | null;
  /** 導入者 nameZh status=confirmed；輔助判斷 (b)(c) 要求 true */
  nameConfirmed?: boolean;
  grade: "auto_ok" | "review" | "fail";
  gradeReasons: string[];
}

export interface MatchDecision {
  action: Action;
  guardId: string | null;
  candidates: string[];
  basis: string[];
  reasons: string[];
}

export interface DbIndex {
  byHkid: Map<string, DbGuard[]>;
  byNo: Map<string, DbGuard[]>;
  byTel: Map<string, DbGuard[]>;
  byZh: Map<string, DbGuard[]>;
  /** guardId → 更表佐證；冇就當冇佐證 */
  roster: Map<string, RosterEvidence>;
}

export function buildDbIndex(gs: DbGuard[], roster?: Map<string, RosterEvidence>): DbIndex {
  const idx: DbIndex = { byHkid: new Map(), byNo: new Map(), byTel: new Map(), byZh: new Map(), roster: roster ?? new Map() };
  const add = (m: Map<string, DbGuard[]>, k: string | null, g: DbGuard) => {
    if (!k) return;
    const a = m.get(k) ?? [];
    if (!a.includes(g)) a.push(g);
    m.set(k, a);
  };
  for (const g of gs) {
    add(idx.byHkid, g.hkid, g);
    g.staffNos.forEach((n) => add(idx.byNo, normalizeStaffNumber(n), g));
    g.tels.forEach((t) => add(idx.byTel, normTel8(t), g));
    add(idx.byZh, normZh(g.nameZh), g);
  }
  return idx;
}

const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 更表原始工號（正規化後）係咪包含導入者其中一個工號（要喺英數字邊界，U123 唔會撞 U1234）。 */
export function rosterHasStaffNo(raws: readonly string[], nos: readonly string[]): boolean {
  for (const raw of raws) {
    const up = raw.toUpperCase();
    const flat = normalizeStaffNumber(raw);
    for (const n of nos) {
      if (!n) continue;
      if (flat === n || new RegExp(`(^|[^A-Z0-9])${escRe(n)}($|[^A-Z0-9])`).test(up)) return true;
    }
  }
  return false;
}

/** 群組層面（同 hkid 多檔／跨人）衝突理由 → 一律 conflict。 */
export function decideMatch(i: MatchInput, db: DbIndex, groupReasons: readonly string[] = []): MatchDecision {
  const reasons: string[] = [];
  const basis: string[] = [];
  const candidates = new Set<string>();
  const out = (action: Action, guardId: string | null): MatchDecision => ({ action, guardId, candidates: [...candidates], basis, reasons: [...new Set(reasons)] });

  const staffNos = i.staffNos.map(normalizeStaffNumber);
  const tel = normTel8(i.phone);
  if (groupReasons.length) {
    reasons.push(...groupReasons);
    return out("conflict", null);
  }

  if (i.grade === "fail" || !i.hkid || !i.hkidValid) {
    reasons.push("extract_fail", ...i.gradeReasons.slice(0, 5));
    // 即使 fail，工號對到嘅 guard 都列為候選方便人手處理
    staffNos.forEach((n) => db.byNo.get(n)?.forEach((g) => candidates.add(g.id)));
    return out("needs_review", null);
  }

  const hkidConfirmed = i.hkidConfirmed !== false;
  const gHkid = hkidConfirmed ? db.byHkid.get(i.hkid) ?? [] : [];
  const gNo = [...new Map(staffNos.flatMap((n) => db.byNo.get(n) ?? []).map((g) => [g.id, g])).values()];
  const gTel = tel ? db.byTel.get(tel) ?? [] : [];
  [...gHkid, ...gNo, ...gTel].forEach((g) => candidates.add(g.id));

  if (gHkid.length > 1) {
    reasons.push("hkid_multi_guard");
    return out("conflict", null);
  }
  if (gNo.length > 1) {
    reasons.push("staffno_multi_guard");
    return out("conflict", null);
  }
  if (gHkid[0] && gNo[0] && gHkid[0].id !== gNo[0].id) {
    reasons.push("hkid_vs_staffno_differ");
    return out("conflict", null);
  }
  const g = gHkid[0] ?? gNo[0] ?? null;
  if (g) {
    if (g.hkid && g.hkid !== i.hkid) {
      reasons.push("guard_hkid_differs");
      return out("conflict", g.id);
    }
    if (gTel.length && !gTel.some((t) => t.id === g.id)) {
      reasons.push("tel_belongs_to_other_guard");
      return out("conflict", g.id);
    }
    if (gHkid[0]) basis.push("hkid");
    if (gNo[0]) basis.push("staff_no");
    if (gTel.some((t) => t.id === g.id)) basis.push("tel");
    if (i.nameZh && g.nameZh && normZh(i.nameZh) !== normZh(g.nameZh)) reasons.push("name_differs_from_guard");
    return out("link", g.id);
  }
  // 冇 hkid／工號對應——試電話
  if (gTel.length === 1) {
    const t = gTel[0]!;
    if (t.hkid && t.hkid !== i.hkid) {
      reasons.push("tel_guard_has_other_hkid");
      return out("conflict", t.id);
    }
    const nameSame = !!i.nameZh && !!t.nameZh && normZh(i.nameZh) === normZh(t.nameZh);
    if (nameSame) {
      basis.push("tel", "name");
      return out("link", t.id);
    }
    reasons.push("tel_only_candidate");
    return out("needs_review", null);
  }
  if (gTel.length > 1) {
    reasons.push("tel_multi_guard");
    return out("conflict", null);
  }
  // 淨姓名（冇 hkid／工號／電話層對應）→ 唯一候選做輔助判斷 a–e；多個候選唔改，要人手
  const gName = i.nameZh ? db.byZh.get(normZh(i.nameZh) ?? "") ?? [] : [];
  gName.forEach((x) => candidates.add(x.id));
  if (gName.length > 1) {
    reasons.push("name_multi_candidate");
    return out("needs_review", null);
  }
  if (gName.length === 1) {
    const c = gName[0]!;
    // (a) G 有另一個 hkid：導入者 hkid confirmed → 唔係同一人，行 create 路徑；未 confirmed → 任何輔助依據都唔准 link，人手
    if (c.hkid && c.hkid !== i.hkid) {
      if (hkidConfirmed) {
        reasons.push("same_name_different_hkid");
        candidates.delete(c.id);
        return decideCreate(true);
      }
      reasons.push("guard_has_other_hkid_unconfirmed");
      return out("needs_review", null);
    }
    // 輔助判斷 (b)(c) 要求導入者 nameZh confirmed；冇硬證據一律留人手
    if (i.nameConfirmed === true) {
      // (b) 出生日期（導入者 dob 已係 confirmed 先會傳入）：相同 → link；唔同 → 人手（G 嘅 dob 可能係舊資料入錯，唔自動 create）
      if (i.dob && c.dob) {
        if (c.dob === i.dob) {
          basis.push("name_dob");
          return out("link", c.id);
        }
        reasons.push("same_name_different_dob");
        return out("needs_review", null);
      }
      // (c) 更表佐證：只計有獨立鍵（工號／電話）配對嘅行；工號或電話
      const ev = db.roster.get(c.id);
      if (ev && (rosterHasStaffNo(ev.staffNoRaws, staffNos) || (tel && ev.telRaws.some((t) => normTel8(t) === tel)))) {
        basis.push("name_roster_evidence");
        return out("link", c.id);
      }
    }
    // (e) 分唔到 → 人手（英文名唔做自動 link 依據：多數係中文名拼音，冇額外鑑別力）
    reasons.push("name_only_candidate");
    return out("needs_review", null);
  }
  return decideCreate(hkidConfirmed);

  function decideCreate(confirmed: boolean): MatchDecision {
    if (!confirmed) {
      reasons.push("hkid_not_confirmed_no_other_key");
      return out("needs_review", null);
    }
    basis.push("no_existing_guard");
    return out("create", null);
  }
}
