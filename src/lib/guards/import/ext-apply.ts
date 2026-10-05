// WP-STAFF-FIELDS 第二階段：新欄寫入（由 apply.ts 嘅 applyPerson 呼叫——同一條已驗收路徑，唔另開）。
// 規則：只寫 confirmed（或人手決定 confirm／replace）；只補空欄；現有值唔同 → conflict（唔覆蓋），除非人手揀 replace
// 而且有權限（覆蓋權檢查喺比較現值之前做，只取決於「現值係咪非空」，避免變成探測現值嘅 oracle）。
import type { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api/errors";
import { fieldValue, type PackagePerson } from "./package";
import { createGuardEmergencyContact, syncLegacyGuardContactColumns } from "@/lib/guards/contacts";
import { canOverrideDerivedSiaPermit, deriveSiaPermitExpiry } from "@/lib/guards/staff-numbers";
import {
  BANK_OVERWRITE_DENIED_MSG,
  EMPTY_BANK,
  PII_OVERWRITE_DENIED_MSG,
  SCALARS,
  bankCompare,
  bankLeaves,
  contactsOf,
  scalarEqual,
  sameContact,
  partialContact,
  staffHiresOf,
  type ExtDecisions,
  type ExtOutcome,
  type GuardExtSnap,
} from "./ext";

type Tx = Prisma.TransactionClient;

export interface ExtCaps {
  /** false＝冇「安員:update」：唔准覆蓋現有牌照／平安咭／QAS／入職日期（undefined 當 true） */
  canEditGuard?: boolean;
  /** false＝冇「安員個人資料:update」：唔准喺已有聯絡人嘅安員加聯絡人 */
  canOverwritePii?: boolean;
  /** true＝冇「安員個人資料:view」：已有聯絡人嘅安員唔自動加（令寫入結果唔反映「估啱聯絡人」） */
  fillOnlyPii?: boolean;
  /** false＝冇「安員銀行資料:update」：銀行欄一律唔寫（outcome not_written）；要覆蓋現有戶口會 403 */
  canEditBank?: boolean;
}
export type AuditFn = (input: { tableName: string; rowId: string; action: "create" | "update"; before?: unknown; after?: unknown }) => Promise<void>;

const isoToDate = (v: string): Date => new Date(`${v}T00:00:00.000Z`);
const deny = (msg: string): never => {
  throw new ApiError(403, "forbidden", msg);
};

const wants = (d: string | undefined, status: string): "skip" | "go" | "not_confirmed" => (d === "skip" ? "skip" : d === "confirm" || d === "replace" || status === "confirmed" ? "go" : "not_confirmed");

export interface ExtColumnPlan {
  data: Prisma.GuardUncheckedUpdateInput;
  outcomes: Record<string, ExtOutcome>;
}

/** 純量欄＋銀行 unit → guards 欄位（無 DB 存取；可能丟 403）。snap=null＝新建（全部係空）。 */
export function planExtColumns(p: PackagePerson, snap: GuardExtSnap | null, dec: ExtDecisions | undefined, caps: ExtCaps): ExtColumnPlan {
  const data: Record<string, unknown> = {};
  const outcomes: Record<string, ExtOutcome> = {};
  for (const s of SCALARS) {
    const leaf = s.get(p);
    const v = leaf ? fieldValue(leaf) : null;
    if (!leaf || !v) continue;
    if (!s.col) {
      outcomes[s.key] = "not_stored";
      continue;
    }
    const d = dec?.[s.key];
    const w = wants(d, leaf.status);
    if (w === "skip") {
      outcomes[s.key] = "skipped";
      continue;
    }
    if (w === "not_confirmed") {
      outcomes[s.key] = "not_confirmed";
      continue;
    }
    const cur = snap ? s.cur(snap) : null;
    if (d === "replace" && cur && caps.canEditGuard === false) deny(PII_OVERWRITE_DENIED_MSG);
    if (!cur) {
      data[s.col] = s.kind === "date" ? isoToDate(v) : v;
      outcomes[s.key] = "written";
    } else if (scalarEqual(s.kind, cur, v)) outcomes[s.key] = "same";
    else if (d === "replace") {
      data[s.col] = s.kind === "date" ? isoToDate(v) : v;
      outcomes[s.key] = "written";
    } else outcomes[s.key] = "conflict";
  }

  const bank = bankLeaves(p);
  if (bank) {
    const d = dec?.bank;
    const w = wants(d, bank.status);
    const cur = snap?.bank ?? EMPTY_BANK;
    const cmp = bankCompare(bank, cur);
    if (w === "skip") outcomes.bank = "skipped";
    else if (w === "not_confirmed") outcomes.bank = "not_confirmed";
    else if (caps.canEditBank === false) {
      if (d === "replace" && cmp.anyCurrent) deny(BANK_OVERWRITE_DENIED_MSG);
      outcomes.bank = "not_written";
    } else {
      // 全有或全無：現有四欄全空先補空；現有有任何資料 → same／conflict（replace 先覆蓋，要銀行資料 update 權——上面已檢查）
      const overwrite = d === "replace";
      if (cmp.state === "fill" || overwrite) {
        const put = (col: "bankCode" | "bankName" | "bankAccountNo" | "bankPayeeName", v: string | null, curV: string | null) => {
          if (v && (!curV || overwrite)) data[col] = v;
        };
        put("bankCode", bank.code, cur.code);
        put("bankName", bank.name, cur.name);
        put("bankAccountNo", bank.accountNo, cur.accountNo);
        put("bankPayeeName", bank.payee, cur.payee);
        outcomes.bank = "bankCode" in data || "bankName" in data || "bankAccountNo" in data || "bankPayeeName" in data ? (cmp.state === "same" ? "same" : "written") : "same";
      } else outcomes.bank = cmp.state === "same" ? "same" : "conflict";
    }
  }
  return { data: data as Prisma.GuardUncheckedUpdateInput, outcomes };
}

/**
 * 同 PATCH /api/guards/:id 一致：甲／乙到期日或出生日期有變，就重算 sia_permit_expiry／sia_permit_type
 * （用 merged 值；兩個到期日都空而之前亦空 → 唔寫，保留現有衍生值）。before=null＝新建。
 */
export function applyDerivedPermit(data: Prisma.GuardUncheckedUpdateInput, before: { a: Date | null; b: Date | null; dob: Date | null } | null): void {
  const d = data as Record<string, unknown>;
  if (!["siaPermitAExpiry", "siaPermitBExpiry", "dateOfBirth"].some((k) => k in d)) return;
  const merged = {
    siaPermitAExpiry: "siaPermitAExpiry" in d ? (d.siaPermitAExpiry as Date | null) : before?.a ?? null,
    siaPermitBExpiry: "siaPermitBExpiry" in d ? (d.siaPermitBExpiry as Date | null) : before?.b ?? null,
    dateOfBirth: "dateOfBirth" in d ? (d.dateOfBirth as Date | null) : before?.dob ?? null,
  };
  const hadValueBefore = before != null && (before.a != null || before.b != null);
  if (canOverrideDerivedSiaPermit({ siaPermitAExpiry: merged.siaPermitAExpiry, siaPermitBExpiry: merged.siaPermitBExpiry, hadValueBefore })) {
    const derived = deriveSiaPermitExpiry(merged);
    d.siaPermitExpiry = derived.siaPermitExpiry;
    d.siaPermitType = derived.siaPermitType;
  }
}

export interface ExtRelationResult {
  outcomes: Record<string, ExtOutcome>;
  contactsAdded: number;
  hiresWritten: number;
}

/** 緊急聯絡人（guard_emergency_contacts）＋逐工號入職日期（guard_staff_numbers.valid_from）。 */
export async function applyExtRelations(
  tx: Tx,
  args: { guardId: string; p: PackagePerson; snap: GuardExtSnap | null; dec: ExtDecisions | undefined; caps: ExtCaps; actorUserId: string; audit: AuditFn },
): Promise<ExtRelationResult> {
  const { guardId, p, snap, dec, caps, actorUserId, audit } = args;
  const outcomes: Record<string, ExtOutcome> = {};
  let contactsAdded = 0;
  let hiresWritten = 0;

  // --- 緊急聯絡人 ---
  const existing = snap?.contacts ?? [];
  const added: { name: string | null; tel: string | null }[] = [];
  for (const c of contactsOf(p)) {
    const key = `emergency.${c.slot}`;
    const d = dec?.[key];
    const w = wants(d, c.status);
    if (w === "skip") {
      outcomes[key] = "skipped";
      continue;
    }
    if (w === "not_confirmed") {
      outcomes[key] = "not_confirmed";
      continue;
    }
    const row = { name: c.name, tel: c.tel };
    // 同一個聯絡人欄位值衝突（同電話唔同名／同名唔同電話）：人手揀 confirm／replace＝加為另一位（要個人資料 update 權；先查權限，唔理新值同現值）
    const partial = existing.some((x) => partialContact(x, row));
    if ((d === "confirm" || d === "replace") && partial && caps.canOverwritePii === false) deny(PII_OVERWRITE_DENIED_MSG);
    if (existing.some((x) => sameContact(x, row)) || added.some((x) => sameContact(x, row))) {
      outcomes[key] = "same";
      continue;
    }
    if (partial && d !== "confirm" && d !== "replace") {
      outcomes[key] = "conflict";
      continue;
    }
    if (caps.fillOnlyPii && existing.length > 0) {
      outcomes[key] = "conflict"; // 冇 PII view：已有聯絡人就唔加（projection 之後同 same 睇落一樣）
      continue;
    }
    const created = await createGuardEmergencyContact(tx, { guardId, name: c.name, tel: c.tel, relationship: c.relationship, source: "staff_fields_import", createdBy: actorUserId });
    await audit({ tableName: "guard_emergency_contacts", rowId: created.id, action: "create", after: created });
    added.push(row);
    contactsAdded += 1;
    outcomes[key] = "written";
  }
  if (contactsAdded > 0) await syncLegacyGuardContactColumns(tx, guardId, ["emergency"]);

  // --- 逐工號入職日期：只補 valid_from 空嘅行 ---
  for (const h of staffHiresOf(p)) {
    const key = `staffHire.${h.number}`;
    const d = dec?.[key];
    const w = wants(d, h.status);
    if (w === "skip") {
      outcomes[key] = "skipped";
      continue;
    }
    if (w === "not_confirmed") {
      outcomes[key] = "not_confirmed";
      continue;
    }
    const row = await tx.guardStaffNumber.findUnique({ where: { number: h.number } });
    if (!row || row.guardId !== guardId) {
      outcomes[key] = "not_written"; // 工號冇加到（屬另一人／格式唔合法）→ 入職日期唔寫
      continue;
    }
    const cur = row.validFrom ? row.validFrom.toISOString().slice(0, 10) : null;
    if (d === "replace" && cur && caps.canEditGuard === false) deny(PII_OVERWRITE_DENIED_MSG);
    if (cur === h.value) outcomes[key] = "same";
    else if (!cur || d === "replace") {
      const after = await tx.guardStaffNumber.update({ where: { id: row.id }, data: { validFrom: isoToDate(h.value) } });
      await audit({ tableName: "guard_staff_numbers", rowId: row.id, action: "update", before: row, after });
      hiresWritten += 1;
      outcomes[key] = "written";
    } else outcomes[key] = "conflict";
  }
  return { outcomes, contactsAdded, hiresWritten };
}
