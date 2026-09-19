import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeGuardWhere, scrubForBrokerSession, isBrokerRole, isInternalRole } from "@/lib/broker-isolation";
import { toBrokerGuardDTO, mapListForBroker } from "@/lib/broker-dto";
import { toGuardFullDTO, toGuardListDTO, mapListDTO } from "@/lib/api/dto";
import { applyFieldGroupGate, applyFieldGroupGateToList } from "@/lib/api/field-groups";
import { brandSafeResponse } from "@/lib/api/serialize";
import { ok, getClientIp, withApiError , okGzip } from "@/lib/api/http";
import { paginationParams, readJson } from "@/lib/api/query";
import { parseBody } from "@/lib/api/validate";
import { snakeToCamelShallow } from "@/lib/api/case";
import { GuardCreateSchema } from "@/lib/api/schemas";
import { writeAudit } from "@/lib/audit";
import { BadRequest } from "@/lib/api/errors";
import { maskHkidForList } from "@/lib/api/guard-pii";
import {
  toStaffNumberChips,
  assertNoLegacySiaPermitWrite,
  assertBrokerNoLegacyStaffNoWrite,
  applyLegacyStaffNoPatch,
  writeStaffNumberAudits,
  deriveSiaPermitExpiry,
  canOverrideDerivedSiaPermit,
  isSiaPermitBLapsedByAge,
  type StaffNumberChip,
} from "@/lib/guards/staff-numbers";
import { createGuardPhone, syncLegacyGuardContactColumns, writeLegacyContactAudits } from "@/lib/guards/contacts";
import type { AuthedSession } from "@/lib/rbac/requirePermission";
import type { Module } from "@/lib/rbac/matrix";
import type { Prisma, Guard } from "@prisma/client";

// C3：雞頭睇/管自己安員用「自己安員」module（§6.2「自己安員名冊管理」），
// 內部角色（老闆/主管/會計）睇全公司安員用「安員」module——同一個
// route，依 session 嘅 base_role 動態揀 module（見
// src/lib/rbac/requirePermission.ts 嘅 ModuleSelector）。
function guardModule(session: AuthedSession): Module {
  return isBrokerRole(session) ? "自己安員" : "安員";
}

// P2-A：加「本月更數」欄（README §08）用嘅 additive、唯讀 query
// 參數——`?with_month_shifts=YYYY-MM` 先計，唔傳就同以前一樣乜都唔加。
// 計法：嗰個月 `record_type=shift` 且非 cancelled 嘅 shift_records 逐
// guard 分組計數（同 shift-records route 預設 `status: { not: "cancelled" }`
// 口徑一致）。全部經 `rows`（已經由 `scopeGuardWhere()` 做咗雞頭隔離）
// 揀出嚟嘅 guardId 先計，唔會漏隔離揭露第二個雞頭嘅安員。
//
// M1（Opus 驗收修復）：舊版 regex `^\d{4}-\d{2}$` 會接受「2026-13」
// 「2026-00」呢類結構啱但月份唔存在嘅字串——之後 `new Date("2026-13-01T…")`
// 拎到 Invalid Date，落到 Prisma `groupBy()` 嘅 `workDate` range query
// 就 500。收緊做 `^\d{4}-(0[1-9]|1[0-2])$`（MM 一定要 01-12），並且
// 「傳咗但格式唔啱」同其他 route（referral-fee-rates／quotas／
// broker-site-assignments 嗰堆）一致，一律 400 BadRequest，唔再靜靜哋
// 當冇傳處理。
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// WP-PII：`?expiring_within_days=90`——篩牌照（sia_permit_expiry）或平安卡
// （safety_card_expiry）90 日內（含已過期）到期嘅保安員，俾列表頁「牌照
// 90 日內到期」FilterChip 用。非負整數，格式唔啱一律 400（同上面
// MONTH_RE 一致嘅口徑）。
const NON_NEGATIVE_INT_RE = /^\d+$/;

async function loadMonthShiftCounts(guardIds: string[], month: string): Promise<Record<string, number>> {
  if (guardIds.length === 0) return {};
  const start = new Date(`${month}-01T00:00:00.000Z`);
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  const counts = await prisma.shiftRecord.groupBy({
    by: ["guardId"],
    where: { guardId: { in: guardIds }, recordType: "shift", status: { not: "cancelled" }, workDate: { gte: start, lt: end } },
    _count: { _all: true },
  });
  return Object.fromEntries(counts.map((c) => [c.guardId, c._count._all]));
}

// WP-STAFFNO（老闆 2026-09-19 拍板）：additive `staff_numbers` 欄——淨係
// current（chips 用），冇 query 參數開關（同 `with_month_shifts` 唔同，
// 呢個一律計，因為列表「工號」欄改晒做 chips，前端一定要呢批資料先畫
// 得出嚟）。內部角色／雞頭白名單都加咗（`GUARD_FIELDS`／
// `GUARD_BROKER_FIELDS`，見 src/lib/api/dto/index.ts、
// src/lib/broker-dto.ts）——「工號本身雞頭一直見到」。
async function loadCurrentStaffNumbers(guardIds: string[]): Promise<Record<string, StaffNumberChip[]>> {
  if (guardIds.length === 0) return {};
  const rows = await prisma.guardStaffNumber.findMany({ where: { guardId: { in: guardIds }, status: "current" } });
  const byGuard: Record<string, typeof rows> = {};
  for (const r of rows) (byGuard[r.guardId] ??= []).push(r);
  return Object.fromEntries(Object.entries(byGuard).map(([guardId, rs]) => [guardId, toStaffNumberChips(rs)]));
}

// S7（Opus 驗收）：`?q=`——姓名／英文名／電話／任何工號（**current 同
// former 都搵**，唔淨係現用）。舊寫法（`matchesSearch()`，前端純本地
// filter）搵唔到 former 號，因為列表 additive `staff_numbers` 淨係得
// current；而家改喺 server 用 `guard_staff_numbers`（唔限 status）搵，
// 揾到嘅 guardId 一齊 OR 落主 query（同雞頭 `scopeGuardWhere()` 隔離冇
// 衝突——喺呢個之後先再過一次 scope）。回傳埋 `formerHitGuardIds`——
// 邊個 guard 係「靠一個 former（已取消）號先搵到」，俾前端標「已取消
// 號命中」。
async function findNumberSearchMatches(q: string): Promise<{ guardIds: string[]; formerHitGuardIds: Set<string> }> {
  const rows = await prisma.guardStaffNumber.findMany({
    where: { number: { contains: q, mode: "insensitive" } },
    select: { guardId: true, status: true },
  });
  return {
    guardIds: [...new Set(rows.map((r) => r.guardId))],
    formerHitGuardIds: new Set(rows.filter((r) => r.status === "former").map((r) => r.guardId)),
  };
}

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "view");
    const url = new URL(req.url);
    const { skip, take } = paginationParams(url);
    const includeInactive = url.searchParams.get("include_inactive") === "1";
    const withMonthShiftsParam = url.searchParams.get("with_month_shifts");
    if (withMonthShiftsParam && !MONTH_RE.test(withMonthShiftsParam)) {
      throw BadRequest("with_month_shifts 格式唔啱（要 YYYY-MM，MM 係 01-12）");
    }
    const expiringWithinDaysParam = url.searchParams.get("expiring_within_days");
    if (expiringWithinDaysParam !== null && !NON_NEGATIVE_INT_RE.test(expiringWithinDaysParam)) {
      throw BadRequest("expiring_within_days 格式唔啱（要非負整數）");
    }
    // S7：`?q=`——姓名／電話／任何 current＋former 工號，見
    // `findNumberSearchMatches()` 頂註解。
    // WP-MULTI：電話而家「有幾多個記幾多個」——`guards.tel` 舊欄淨係
    // primary，`?q=` 要搵到任何一個（唔止主要），所以加埋
    // `guard_phones`（唔限 is_primary）嘅 guardId 一齊 OR 落主 query，
    // 同 `findNumberSearchMatches()` 一致嘅手法。
    const qParam = url.searchParams.get("q")?.trim() || null;
    let where: Prisma.GuardWhereInput = includeInactive ? {} : { status: "active" };
    let formerHitGuardIds = new Set<string>();
    if (qParam) {
      const [numberMatches, phoneMatches] = await Promise.all([
        findNumberSearchMatches(qParam),
        prisma.guardPhone.findMany({ where: { tel: { contains: qParam } }, select: { guardId: true } }),
      ]);
      formerHitGuardIds = numberMatches.formerHitGuardIds;
      const phoneMatchGuardIds = [...new Set(phoneMatches.map((p) => p.guardId))];
      where = {
        ...where,
        OR: [
          { nameZh: { contains: qParam, mode: "insensitive" } },
          { nameEn: { contains: qParam, mode: "insensitive" } },
          { tel: { contains: qParam } },
          ...(numberMatches.guardIds.length > 0 ? [{ id: { in: numberMatches.guardIds } }] : []),
          ...(phoneMatchGuardIds.length > 0 ? [{ id: { in: phoneMatchGuardIds } }] : []),
        ],
      };
    }
    where = scopeGuardWhere(session, where);

    // S5（Opus 驗收修復）：`sia_permit_expiry`／`sia_permit_type` 唔再信
    // DB 欄，讀取時一律用 `deriveSiaPermitExpiry()` 現算（DB 欄寫入時仍
    // 會更新，`ai.guards` view 用緊，但寫入之後「時間流逝」引致嘅陳舊
    // ——例如生日過咗令乙類滿 70 歲失效——冇再寫入就唔會自動反映，要讀
    // 嗰下現算先啱）。`expiring_within_days` 篩選一齊改用現算值——SQL
    // WHERE 表達唔到「乙類滿 70 歲失效」呢類要睇 DOB＋今日先計得到嘅條
    // 件，改做攞返呢個 session 可見嘅全部 row（唔限 skip/take）→ 逐個
    // 現算 → 篩 → 先分頁（`total`／`skip`/`take` 一律用篩選之後嘅陣列，
    // 唔可以用 DB `count()`，嗰個係「篩選前」嘅數）。目前規模（265 行）
    // 呢種「後篩」可接受，見設計文件。
    //
    // 必修 1(b)（Opus 驗收第二輪）：a／b 兩個都 null 嗰陣，`deriveSiaPermit
    // Expiry()` 一定計出 {null,null}——唔可以用嚟覆蓋 DB 原有嘅
    // `sia_permit_expiry`／`sia_permit_type`（migration backfill 唔到、
    // 或者人手都未補嘅舊資料，見 migration.sql「(1)」大註解），一律保留
    // DB 原值；淨係 a／b 其中一個有值先用現算值覆蓋，同
    // `src/app/api/guards/[id]/route.ts withDerivedGuard()` 一致做法
    // （必修 1／4，Opus 驗收第三輪：而家改用共用嘅
    // `canOverrideDerivedSiaPermit()`，並且加埋 `siaPermitBLapsedByAge`
    // 衍生 flag——乙類因為滿 70 歲失效嗰陣，列表唔應該顯示成「未填」，
    // 見 src/lib/guards/staff-numbers.ts 兩個函數頂註解）。
    const withDerived = (row: Guard) => {
      const siaPermitBLapsedByAge = isSiaPermitBLapsedByAge(row);
      if (!canOverrideDerivedSiaPermit({ siaPermitAExpiry: row.siaPermitAExpiry, siaPermitBExpiry: row.siaPermitBExpiry })) {
        return { ...row, siaPermitBLapsedByAge };
      }
      return { ...row, ...deriveSiaPermitExpiry(row), siaPermitBLapsedByAge };
    };
    let rows: Array<ReturnType<typeof withDerived>>;
    let total: number;
    if (expiringWithinDaysParam !== null) {
      const cutoff = new Date(Date.now() + Number(expiringWithinDaysParam) * 86_400_000);
      const all = await prisma.guard.findMany({ where, orderBy: { createdAt: "asc" } });
      const filtered = all.map(withDerived).filter(
        (r) =>
          (r.siaPermitExpiry != null && r.siaPermitExpiry.getTime() <= cutoff.getTime()) ||
          (r.safetyCardExpiry != null && r.safetyCardExpiry.getTime() <= cutoff.getTime()),
      );
      total = filtered.length;
      rows = filtered.slice(skip, skip + take);
    } else {
      const [dbRows, dbTotal] = await Promise.all([
        prisma.guard.findMany({ where, skip, take, orderBy: { createdAt: "asc" } }),
        prisma.guard.count({ where }),
      ]);
      rows = dbRows.map(withDerived);
      total = dbTotal;
    }
    // S4（Opus 驗收修復）：monthShiftCount 而家喺 DTO／field-group gate
    // **之前**就 merge 落 raw `rows`（`GUARD_FIELDS`／`GUARD_BROKER_FIELDS`
    // 白名單已經加咗 `monthShiftCount`，見 src/lib/api/dto/index.ts、
    // src/lib/broker-dto.ts）——行返 `pickWhitelist()` 正常嘅白名單路
    // 徑，唔再靠「喺 gate 之後先手動加返」嗰種繞過白名單機制嘅寫法（嗰
    // 種寫法一旦第二個欄都想咁做，個白名單就形同虛設）。`rows` 冇呢個
    // key 嘅時候（冇傳 `with_month_shifts`）`pickWhitelist()` 嘅
    // `hasOwnProperty` 檢查會自然跳過，同以前「乜都唔加」行為一致。
    const monthShiftCounts = withMonthShiftsParam
      ? await loadMonthShiftCounts(rows.map((r) => r.id), withMonthShiftsParam)
      : null;
    const staffNumbersByGuard = await loadCurrentStaffNumbers(rows.map((r) => r.id));
    const rowsWithCount = rows.map((r) => ({
      ...r,
      ...(monthShiftCounts ? { monthShiftCount: monthShiftCounts[r.id] ?? 0 } : {}),
      staffNumbers: staffNumbersByGuard[r.id] ?? [],
      // S7：淨係有 `q` 先加呢粒 key（冇搜尋就唔需要，同 `monthShiftCount`
      // 一致嘅「唯讀 additive 參數」口徑）。
      ...(qParam ? { formerNumberHit: formerHitGuardIds.has(r.id) } : {}),
    }));
    if (isBrokerRole(session)) {
      const list = scrubForBrokerSession(
        session,
        mapListForBroker({ rows: rowsWithCount, total, skip, take }, toBrokerGuardDTO),
      );
      return okGzip(req, list);
    }
    // WP-PII（應修 4）：列表用窄版 DTO（唔回銀行三欄/地址/出生日期/緊急
    // 聯絡人/Blacklist），field-group gate 一樣照跑（冧走已經冇喺 DTO
    // 出現嘅 key 純粹 no-op，唔會報錯，見 src/lib/api/field-groups.ts
    // omit()）——詳情 GET /api/guards/[id] 先用 toGuardFullDTO() 全欄。
    const dto = mapListDTO({ rows: rowsWithCount, total, skip, take }, toGuardListDTO);
    const gated = await applyFieldGroupGateToList(session, "guards", dto);
    // WP-PII：列表身份證一律遮罩（老闆/會計有「安員個人資料:view」都係
    // 遮）——詳情/編輯（GET /api/guards/[id]、PATCH 之後 response）先畀
    // 睇全號，見 src/app/api/guards/[id]/route.ts。
    const masked = brandSafeResponse({ ...gated, rows: maskHkidForList(gated.rows) });
    return okGzip(req, masked);
  });
}

export async function POST(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, guardModule, "create");
    const body = await readJson(req);
    assertNoLegacySiaPermitWrite(body);
    // M2a（Opus 驗收修復）：雞頭帶 staff_no／staff_no_mw 一律 403（硬性，
    // 唔靠矩陣個 cell），見 assertBrokerNoLegacyStaffNoWrite() 頂註解。
    assertBrokerNoLegacyStaffNoWrite(isBrokerRole(session), body);
    const parsed = parseBody(GuardCreateSchema, body);
    // WP-STAFFNO：`staff_no`／`staff_no_mw` 而家係由 `guard_staff_
    // numbers` 新表 sync 返嚟嘅值——建立嗰陣如果有帶，一樣要行
    // `applyLegacyStaffNoPatch()` 起返對應嘅新表行，唔係就呢個 guard
    // 一開始個 staff_no 就冇對應嘅 current 行，第一次有人幫佢加／改第二
    // 個工號（觸發 sync）就會被靜靜哋抹走（見 src/lib/guards/
    // staff-numbers.ts syncLegacyStaffNoColumns() 大註解）。
    // WP-MULTI（老闆 2026-09-19 拍板）：`tel`（新增保安員嗰陣填嘅初始
    // 電話）而家一樣要行 `createGuardPhone()` 起一行 primary（唔可以再
    // 直接落 `prisma.guard.create({ data: { tel } })`），唔係就呢個
    // guard 一開始嘅電話就冇對應嘅 `guard_phones` 行，第一次有人幫佢加
    // 第二個電話（觸發 sync）就會被靜靜哋抹走（同 staff_no 一致理由）。
    const { staff_no: staffNoLegacy, staff_no_mw: staffNoMwLegacy, tel: telLegacy, ...rest } = parsed as typeof parsed & {
      staff_no?: string;
      staff_no_mw?: string;
      tel?: string;
    };
    const data = snakeToCamelShallow(rest) as Prisma.GuardUncheckedCreateInput;
    // 雞頭建安員：強制掛喺自己個 broker 底下（唔准幫其他雞頭/自己揀第二個 broker）
    if (isBrokerRole(session)) data.defaultBrokerId = session.brokerId;

    // 必修 1（Opus 驗收第三輪，「POST 同理檢查」）：`GuardCreateSchema`
    // 現時未開放 `sia_permit_a_expiry`／`sia_permit_b_expiry`／
    // `date_of_birth`（WP-PII 呢批新欄一律 PATCH-only，見 schemas.ts
    // GuardUpdateSchema 頂註解），所以呢一刻 `data` 實際上唔會帶呢三個
    // key，`DERIVED_INPUT_KEYS.some()` 恆常 false，以下呢段係
    // defense-in-depth（同 PATCH 寫入層共用同一個安全閥函數，日後
    // GuardCreateSchema 一旦開放呢批欄都唔會漏咗呢層）——建立呢一刻冇
    // 「之前」，`hadValueBefore` 一律唔傳（default false，同
    // `canOverrideDerivedSiaPermit()` 嘅「a／b 都 null 就唔覆蓋」一致：
    // 冇嘢好清，都冇嘢好寫）。
    const createDerivedInputKeys = ["siaPermitAExpiry", "siaPermitBExpiry", "dateOfBirth"] as const;
    if (createDerivedInputKeys.some((k) => k in data)) {
      const createDerivedInput = {
        siaPermitAExpiry: ((data as Record<string, unknown>).siaPermitAExpiry as Date | null | undefined) ?? null,
        siaPermitBExpiry: ((data as Record<string, unknown>).siaPermitBExpiry as Date | null | undefined) ?? null,
        dateOfBirth: ((data as Record<string, unknown>).dateOfBirth as Date | null | undefined) ?? null,
      };
      if (canOverrideDerivedSiaPermit({ siaPermitAExpiry: createDerivedInput.siaPermitAExpiry, siaPermitBExpiry: createDerivedInput.siaPermitBExpiry })) {
        const derived = deriveSiaPermitExpiry(createDerivedInput);
        (data as Record<string, unknown>).siaPermitExpiry = derived.siaPermitExpiry;
        (data as Record<string, unknown>).siaPermitType = derived.siaPermitType;
      }
    }

    const { created, legacyChanges, phoneResult } = await prisma.$transaction(async (tx) => {
      const createdGuard = await tx.guard.create({ data: { ...data, createdBy: session.userId } });
      const legacyResult =
        staffNoLegacy || staffNoMwLegacy
          ? await applyLegacyStaffNoPatch(tx, {
              guardId: createdGuard.id,
              staffNo: staffNoLegacy,
              staffNoMw: staffNoMwLegacy,
              createdBy: session.userId,
              revealConflictGuardId: isInternalRole(session),
            })
          : { changes: [] };
      // WP-MULTI：初始 `tel`（非空）起一行 primary 電話。
      const phoneRes = telLegacy && telLegacy.trim() ? await createGuardPhone(tx, { guardId: createdGuard.id, tel: telLegacy, isPrimary: true, source: "manual", createdBy: session.userId }) : null;
      if (phoneRes) await syncLegacyGuardContactColumns(tx, createdGuard.id);
      const finalGuard = legacyResult.changes.length > 0 || phoneRes ? await tx.guard.findUniqueOrThrow({ where: { id: createdGuard.id } }) : createdGuard;
      return { created: finalGuard, legacyChanges: legacyResult.changes, phoneResult: phoneRes };
    });

    await writeAudit({ actorUserId: session.userId, tableName: "guards", rowId: created.id, action: "create", after: created, ip: getClientIp(req) });
    if (legacyChanges.length > 0) {
      await writeStaffNumberAudits(session.userId, legacyChanges, getClientIp(req));
    }
    if (phoneResult) {
      await writeLegacyContactAudits(session.userId, { phone: phoneResult, address: null, contact: null }, getClientIp(req));
    }
    if (isBrokerRole(session)) return ok(scrubForBrokerSession(session, toBrokerGuardDTO(created)), 201);
    return ok(await applyFieldGroupGate(session, "guards", toGuardFullDTO(created)), 201);
  });
}
