// `npm run gate:ltpay-aug`——WP-LTPAY §21 任務 4c（老闆 2026-09-26 指令）：
// 8 月長工月薪糧 aggregate 層對 8 月試算 oracle 嘅驗收 gate。
//
// 同舊 `gate:ltpay-july`（`longterm-payroll-july.ts`，2026-09-28 已刪）唔同：7 月 gate 淨係
// 對住一個已經跑過一鍵結算嘅靜態 dev DB 讀，8 月 fixture 冇呢種現成
// 快照，要自己由 `db:reset && db:seed` 開始，行一次「開月→36 檔上
// 載→（guard-fix，冇 U Team 名單就淨係用 Postorder 組合）→長工結算單
// 位重算→全月對數套用」先至有真實 `shift_records`／leave 記錄可以俾
// aggregate.ts 讀（同 `scripts/gate/aug-e2e-check.ts` 檔頭註解講嘅
// pre-steps 1-5 一致流程，呢個 script 自己做晒，唔使人手）。
//
// **更新（Opus 5.5 驗收 WP-PHASE4，2026-09-27）**：本機有 U Team 名單
// （`U_TEAM_XLSX_PATH`）就改行一鍵結算嘅 `stepGuardFix()`（同正式站撳
// 一鍵完全同一條路，會寫 `guard_fix_runs` 令 Postorder 生效做權威），
// 冇先 fallback 落下面舊做法。以下係舊註解（冇 U Team 名單嘅情況）：
//
// **老實講低**：呢個 dev 環境冇 U Team 名單 xlsx（`安員配對修復`模組
// 用嚟 link/create 未配對安員嗰個檔案），所以 guard-fix 嘅
// link／create／createMinimal／needsBoss 呢幾類 action 呢度做唔到（冇
// 檔案，唔可以自己作一份假嘅 U Team 名單），改用 `buildGuardFixPlan({
// uTeamRows: [] })`——`set_longterm_post`（長工自己崗位盤，WP-LTSHIFT
// §19 嘅核心，靠 Postorder `longterm-pairs.csv`／`PostOrder.csv`，同
// U Team 名單完全獨立）同 `set_referral`／`set_referral_inferred`
// 照計唔受影響；受影響嘅淨係「將更表入面完全未配對嘅姓名連/建做安員」
// 呢批（§20.6 dev 全流程實測見過 440 格），對長工糧嚟講唔核心——長工
// 本身喺 seed 已經有 Guard 記錄（`guards.csv`／Maxwell 匯入），更表姓名
// 同已有 Guard.nameZh 直接文字對到就得，唔靠 U Team。呢個限制嘅實際
// 影響喺跑完之後嘅差異表／原因分析入面老實列出。
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient, Prisma } from "@prisma/client";
import { processRosterUpload } from "@/lib/roster-upload/service";
import { buildGuardFixPlan } from "@/lib/guard-fix/plan";
import { applyGuardFixPlan, reparseAllActiveUploads } from "@/lib/guard-fix/apply";
import { parsePostorderFromPairsCsv } from "@/lib/guard-fix/postorder";
import { runOneClickMonthClose, stepGuardFix, stepLongtermSettlement, stepReconcileApply } from "@/lib/month-close/one-click";
import { U_TEAM_XLSX_PATH, parseUTeamWorkbookBuffer } from "@/lib/guard-fix/sources";
import { recomputeLongtermPayroll } from "@/lib/longterm-payroll/aggregate";
import { round2 } from "@/lib/reports/money";
import type { LtpayAugFixtureRow } from "./build-ltpay-aug-fixture";

const REPO_ROOT = path.resolve(__dirname, "../..");
const ROSTER_DIR = path.resolve(REPO_ROOT, "data/2026-09/aug-rosters");
const FIXTURE_PATH = path.resolve(REPO_ROOT, "data/2026-09/ltpay-aug-fixture.json");
const PAIRS_CSV_PATH = path.resolve(REPO_ROOT, "data/2026-09/postorder-csv/longterm-pairs.csv");
const POSTORDER_CSV_PATH = path.resolve(REPO_ROOT, "data/2026-09/postorder-csv/PostOrder.csv");
const GATE_TAG = "gate:ltpay-aug";
const AUG_MONTH = new Date(Date.UTC(2026, 7, 1));
const GUARD_FIX_MAX_ROUNDS = 5;

function sh(cmd: string) {
  console.log(`[${GATE_TAG}] $ ${cmd}`);
  execSync(cmd, { cwd: REPO_ROOT, stdio: "inherit" });
}

async function main() {
  if (!fs.existsSync(ROSTER_DIR)) {
    console.log(`[${GATE_TAG}] SKIP —— 揾唔到 ${path.relative(REPO_ROOT, ROSTER_DIR)}，本機冇 8 月更表原始檔，跳過`);
    return;
  }
  if (!fs.existsSync(FIXTURE_PATH)) {
    console.error(`[${GATE_TAG}] FAIL —— 揾唔到 fixture ${path.relative(REPO_ROOT, FIXTURE_PATH)}，先跑 npm run gate:ltpay-aug-fixture`);
    process.exitCode = 1;
    return;
  }
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as LtpayAugFixtureRow[];

  // --------------------------------------------------------------- 1-2. 開 dev DB、開月
  console.log(`[${GATE_TAG}] === 1. db:reset && db:seed ===`);
  sh("npm run db:reset");
  sh("npm run db:seed");

  console.log(`[${GATE_TAG}] === 2. 開 8 月盤（build-aug-plan → apply-aug-plan --apply）===`);
  sh("npx tsx scripts/opening/build-aug-plan.ts");
  sh("npx tsx scripts/opening/apply-aug-plan.ts --apply");

  const prisma = new PrismaClient();
  try {
    const actor = await prisma.user.findFirst({ where: { role: { name: "老闆" } }, select: { id: true } });
    if (!actor) throw new Error("dev DB 揾唔到「老闆」角色用戶——db:seed 冇跑好");
    const actorUserId = actor.id;

    // ------------------------------------------------------------- 2b. 8 月介紹費費率種子
    // 老闆 2026-09-28 效能優化指令（自動化）：migration
    // `20260926200000_wp_postorder_csv_aug_referral_rates` 嘅 DML 用
    // brokers.code／sites.canonical_name 查 id 先 INSERT——`db:reset` 喺空 DB
    // 跑 migrate 嗰陣 brokers／sites 仲未 seed，一行都插唔到（正式站有資料
    // 所以冇呢個問題）。之前要人手補跑一次先至 gate:postorder-export-aug
    // 介紹費對到 60,520；而家 gate 自己 seed 完重放一次同一份 SQL（WHERE
    // NOT EXISTS，冪等，正式站已有費率唔會被覆蓋）。
    console.log(`[${GATE_TAG}] === 2b. 重放 8 月介紹費費率 migration DML（seed 之後先對得到 brokers／sites）===`);
    const referralRateSql = fs.readFileSync(path.resolve(REPO_ROOT, "prisma/migrations/20260926200000_wp_postorder_csv_aug_referral_rates/migration.sql"), "utf8");
    const referralRateRows = await prisma.$executeRawUnsafe(referralRateSql);
    console.log(`[${GATE_TAG}] 介紹費費率補插 ${referralRateRows} 行（已有嘅唔覆蓋）`);

    // ------------------------------------------------------------- 3. 36 檔上載
    console.log(`[${GATE_TAG}] === 3. 真實上載 36 個 8 月更表 xlsx ===`);
    const files = fs.readdirSync(ROSTER_DIR).filter((f) => f.endsWith(".xlsx"));
    let uploadOk = 0;
    let uploadFail = 0;
    for (const f of files) {
      try {
        const buf = fs.readFileSync(path.join(ROSTER_DIR, f));
        await processRosterUpload({ fileBuffer: buf, fileName: f, month: AUG_MONTH, uploaderUserId: actorUserId });
        uploadOk += 1;
      } catch (e) {
        uploadFail += 1;
        console.error(`[${GATE_TAG}]   上載失敗「${f}」：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.log(`[${GATE_TAG}] 上載：${uploadOk}/${files.length} 成功（${uploadFail} 失敗）`);

    // ------------------------------------------------------------- 4. guard-fix（冇 U Team 名單，淨係 Postorder 組合）
    console.log(`[${GATE_TAG}] === 4. guard-fix（有 U Team 名單行一鍵 stepGuardFix；冇就淨係 Postorder 組合，見檔頭）===`);
    let postorderInput: Parameters<typeof buildGuardFixPlan>[0]["postorder"] | undefined;
    if (fs.existsSync(PAIRS_CSV_PATH)) {
      const pairsCsv = fs.readFileSync(PAIRS_CSV_PATH, "utf-8");
      const postorderCsv = fs.existsSync(POSTORDER_CSV_PATH) ? fs.readFileSync(POSTORDER_CSV_PATH, "utf-8") : null;
      const parsed = parsePostorderFromPairsCsv({ longtermPairsCsv: pairsCsv, postorderCsv });
      const combined = postorderCsv ? Buffer.concat([Buffer.from(pairsCsv), Buffer.from(postorderCsv)]) : Buffer.from(pairsCsv);
      const upload = await prisma.postorderUpload.create({
        data: {
          month: AUG_MONTH,
          uploaderId: actorUserId,
          fileName: `${GATE_TAG}：longterm-pairs.csv${postorderCsv ? " + PostOrder.csv" : ""}`,
          fileSha256: "gate-script-no-hash",
          fileBytes: combined,
          fileSize: combined.length,
          rowCount: parsed.longtermPosts.length + parsed.referralRows.length,
          status: "parsed",
          parseSummary: { source: GATE_TAG },
          longtermPairsCsvBytes: Buffer.from(pairsCsv),
          postorderCsvBytes: postorderCsv ? Buffer.from(postorderCsv) : null,
        },
      });
      postorderInput = { uploadId: upload.id, fileName: upload.fileName, longtermPosts: parsed.longtermPosts, referralRows: parsed.referralRows, visa: parsed.visa };
      console.log(`[${GATE_TAG}] Postorder 組合：${parsed.longtermPosts.length} 組崗位、${parsed.referralRows.length} 條介紹費行`);
    } else {
      console.log(`[${GATE_TAG}] 揾唔到 ${path.relative(REPO_ROOT, PAIRS_CSV_PATH)}——冇 Postorder 組合，set_longterm_post 呢類 action 0 項`);
    }

    // Opus 5.5 驗收（WP-PHASE4，2026-09-27）：本機有 U Team 名單就行返
    // 一鍵結算真正嗰條 `stepGuardFix()`（建 `staff_list_uploads`＋
    // `guard_fix_runs(status=applied, postorder_upload_id=…)`）。之前淨係
    // 直接叫 `applyGuardFixPlan()`，冇 guard_fix_runs 記錄 →
    // `hasParsedPostorderForMonth()` 恆 false → Postorder 唔當權威 →
    // 長工 ≥50% 推算崗位照用：實測一位長工 13 格啟航1331 散更錯歸 B07、
    // K 少 11,440（13×880），同 §20.7 一鍵報告 K 1,023,730 對唔上。
    const uTeamAbs = path.resolve(REPO_ROOT, U_TEAM_XLSX_PATH);
    let usedOneClickGuardFix = false;
    if (fs.existsSync(uTeamAbs)) {
      const buf = fs.readFileSync(uTeamAbs);
      const rows = await parseUTeamWorkbookBuffer(buf);
      await prisma.staffListUpload.create({
        data: { uploaderId: actorUserId, fileName: `${GATE_TAG}：u-team.xlsx`, fileSha256: "gate-script-no-hash", fileBytes: buf, fileSize: buf.length, rowCount: rows.length, status: "parsed", parseSummary: { source: GATE_TAG, rowCount: rows.length } },
      });
      const gf = await stepGuardFix(AUG_MONTH, actorUserId);
      console.log(`[${GATE_TAG}] guard-fix（一鍵結算 stepGuardFix，有 U Team 名單）：${JSON.stringify(gf.numbers)}`);
      for (const w of gf.warnings) console.log(`[${GATE_TAG}]   warning：${w}`);
      usedOneClickGuardFix = true;
    }

    let round = 0;
    for (round = 1; !usedOneClickGuardFix && round <= GUARD_FIX_MAX_ROUNDS; round++) {
      const plan = await buildGuardFixPlan({ prisma: prisma as never, month: AUG_MONTH, uTeamRows: [], postorder: postorderInput });
      const actionable = plan.actions.link.length + plan.actions.create.length + plan.actions.createMinimal.length + plan.actions.setLongterm.length + plan.actions.setLongtermPost.length + plan.actions.setReferral.length + plan.actions.setReferralInferred.length + plan.actions.setVisa.length;
      console.log(
        `[${GATE_TAG}] guard-fix 第 ${round} 輪：link=${plan.actions.link.length} create=${plan.actions.create.length} createMinimal=${plan.actions.createMinimal.length} setLongterm=${plan.actions.setLongterm.length} setLongtermPost=${plan.actions.setLongtermPost.length} setReferral=${plan.actions.setReferral.length} setReferralInferred=${plan.actions.setReferralInferred.length} setVisa=${plan.actions.setVisa.length} needsBoss=${plan.actions.needsBoss.length}`,
      );
      if (actionable === 0) break;
      await applyGuardFixPlan({ prisma: prisma as never, plan, planOnly: false, txTimeoutMs: 20 * 60 * 1000, month: AUG_MONTH });
      await reparseAllActiveUploads(prisma as never, AUG_MONTH, { txTimeoutMs: 10 * 60 * 1000 });
    }
    if (!usedOneClickGuardFix) console.log(`[${GATE_TAG}] guard-fix 收斂於第 ${round} 輪`);

    // ------------------------------------------------------------- 4b. 簽證形式長工標記（要喺結算單位重算之前）
    // §14 規則 12：佢喺雞頭盤嘅更由雞頭結算（`resolveLongtermSettlement()`
    // visa_sponsor 分支），所以標記要喺 step 5 之前落，否則佢啲更會被當
    // 長工自己崗位（B07）計返工日（Opus 5.5 驗收加）。
    for (const row of fixture.filter((r) => r.visaBrokerCode)) {
      const g = await prisma.guard.findFirst({ where: { OR: [{ staffNoMw: row.staffNo }, { staffNo: row.staffNo }] } });
      const vb = await prisma.broker.findUnique({ where: { code: row.visaBrokerCode! } });
      if (g && vb) await prisma.guard.update({ where: { id: g.id }, data: { visaSponsoredByBrokerId: vb.id } });
      console.log(`[${GATE_TAG}] 簽證形式長工標記：${g && vb ? "已設" : "⚠ 揾唔到安員或雞頭"}`);
    }

    // ------------------------------------------------------------- 5. 長工結算單位重算 + 全月對數套用
    console.log(`[${GATE_TAG}] === 5. 長工結算單位重算（settlementBrokerId=B07）===`);
    const ltResult = await stepLongtermSettlement(AUG_MONTH, actorUserId);
    console.log(`[${GATE_TAG}] ${JSON.stringify(ltResult.numbers)}`);

    console.log(`[${GATE_TAG}] === 6. 全月對數套用（runReconcileAllForMonth）===`);
    const reconcileResult = await stepReconcileApply(AUG_MONTH, actorUserId, null);
    console.log(`[${GATE_TAG}] ${JSON.stringify(reconcileResult.numbers)}`);

    // ------------------------------------------------------------- 7. 導入 8 月合約＋fixture 人手輸入項
    console.log(`[${GATE_TAG}] === 7. 導入 8 月合約＋fixture 人手輸入項（${fixture.length} 人）===`);
    let matched = 0;
    let createdCount = 0;
    let nameMatchedCount = 0;
    for (const row of fixture) {
      let guard = await prisma.guard.findFirst({ where: { OR: [{ staffNoMw: row.staffNo }, { staffNo: row.staffNo }] } });
      if (!guard) {
        // 8 月新入職長工（唔喺 7 月 seed CSV 範圍內，dev DB 冇對應
        // Guard）——更表上載／guard-fix `createMinimal` 好可能已經按
        // 更表姓名建咗一個獨立安員（`employmentType=cash_casual`，冇
        // `staffNoMw`），試下用 `nameZh` 撈返嗰個，等佢個 shift_records
        // 唔會走失；揾唔到先真係建新（dev-only，兩種情況都要補
        // `staffNoMw`／`employmentType` 先至配對得到）。
        guard = await prisma.guard.findFirst({ where: { nameZh: row.name } });
        if (guard) {
          nameMatchedCount += 1;
          await prisma.guard.update({ where: { id: guard.id }, data: { staffNoMw: row.staffNo, employmentType: "longterm_autopay" } });
        } else {
          guard = await prisma.guard.create({ data: { nameZh: row.name, staffNoMw: row.staffNo, employmentType: "longterm_autopay", createdBy: GATE_TAG } });
          createdCount += 1;
        }
      }
      matched += 1;

      // guard 層面——dev-only 覆蓋（fixture 嚟自 Maxwell/oracle，權威過
      // 其他 seed 嚟源，同 July gate「淨係喺未設先補」唔同，呢度直接
      // 覆蓋，先至可以準確驗 AL 試用期／entitlement／MPF 年齡）。
      const guardUpdate: Prisma.GuardUpdateInput = {
        hireDate: row.guard.hireDate ? new Date(row.guard.hireDate) : undefined,
        leaveDate: row.guard.leaveDate ? new Date(row.guard.leaveDate) : null,
        dateOfBirth: row.guard.dob ? new Date(row.guard.dob) : undefined,
        probationMonths: row.contract.probationMonths,
      };
      if (row.visaBrokerCode) {
        const vb = await prisma.broker.findUnique({ where: { code: row.visaBrokerCode } });
        if (vb) guardUpdate.visaSponsoredByBroker = { connect: { id: vb.id } };
        else console.log(`[${GATE_TAG}]   ⚠ 揾唔到簽證形式長工贊助雞頭代號 ${row.visaBrokerCode}`);
      }
      await prisma.guard.update({ where: { id: guard.id }, data: guardUpdate });

      // 合約——void 呢個 gate 之前建嘅版本，重新建。
      await prisma.guardLongtermContract.updateMany({ where: { guardId: guard.id, voidedAt: null }, data: { voidedAt: new Date(), voidedBy: actorUserId } });
      if (row.contract.midMonthChange) {
        const eff = new Date(row.contract.midMonthChange.newBasicEff);
        const dayBefore = new Date(eff.getTime() - 86400000);
        await prisma.guardLongtermContract.create({
          data: {
            guardId: guard.id,
            monthlySalary: row.contract.midMonthChange.oldMonthly,
            effectiveFrom: new Date(row.contract.effectiveFrom),
            effectiveTo: dayBefore,
            payBasis: "monthly",
            shiftHours: row.contract.workingHour ?? undefined,
            probationMonths: row.contract.probationMonths,
            annualLeaveDays: row.contract.annualLeaveDays,
            statutoryHolidayPaidFrom: row.contract.statutoryHolidayPaidFrom,
            mpfExemptReason: "auto",
            source: "manual",
            note: `${GATE_TAG}：8 月轉約前舊合約`,
            createdBy: actorUserId,
          },
        });
        await prisma.guardLongtermContract.create({
          data: {
            guardId: guard.id,
            monthlySalary: row.contract.midMonthChange.newBasic,
            effectiveFrom: eff,
            effectiveTo: null,
            payBasis: "monthly",
            shiftHours: row.contract.workingHour ?? undefined,
            probationMonths: row.contract.probationMonths,
            annualLeaveDays: row.contract.annualLeaveDays,
            statutoryHolidayPaidFrom: row.contract.statutoryHolidayPaidFrom,
            mpfExemptReason: "auto",
            source: "manual",
            note: `${GATE_TAG}：8 月轉約後新合約`,
            createdBy: actorUserId,
          },
        });
      } else {
        await prisma.guardLongtermContract.create({
          data: {
            guardId: guard.id,
            monthlySalary: row.contract.monthlySalary,
            effectiveFrom: new Date(row.contract.effectiveFrom),
            effectiveTo: null,
            payBasis: row.contract.payBasis,
            dailyRate: row.contract.dailyRate ?? undefined,
            shiftHours: row.contract.workingHour ?? undefined,
            probationMonths: row.contract.probationMonths,
            annualLeaveDays: row.contract.annualLeaveDays,
            statutoryHolidayPaidFrom: row.contract.statutoryHolidayPaidFrom,
            mpfExemptReason: "auto",
            source: "manual",
            note: `${GATE_TAG}：由 8 月試算 oracle 建`,
            createdBy: actorUserId,
          },
        });
      }

      // 人手輸入項
      await prisma.longtermPayrollInput.updateMany({ where: { month: AUG_MONTH, guardId: guard.id, note: { contains: GATE_TAG } }, data: { voidedAt: new Date(), voidedBy: actorUserId } });
      if (row.inputs.specialAllowance) {
        await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "special_allowance", amount: row.inputs.specialAllowance, note: `${GATE_TAG}：勤工獎`, createdBy: actorUserId } });
      }
      if (row.inputs.otherAllowanceCombined) {
        await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "other_allowance", amount: row.inputs.otherAllowanceCombined, note: `${GATE_TAG}：以薪代假(賣假)＋頂位津貼合計`, createdBy: actorUserId } });
      }
      for (const seg of row.inputs.slSegments) {
        await prisma.longtermPayrollInput.create({ data: { month: AUG_MONTH, guardId: guard.id, kind: "leave", dateFrom: seg.dateFrom, dateTo: seg.dateTo, doctorNoteVerified: seg.doctorNoteVerified, note: `${GATE_TAG}：病假段（oracle 假設有醫生紙）`, createdBy: actorUserId } });
      }
      if (row.inputs.leaverSettlement) {
        // amount=null＝唔 override，由引擎按比例自動計（Opus 5.5 驗收：唔再餵 oracle 輸出）。
        await prisma.longtermPayrollInput.create({
          data: { month: AUG_MONTH, guardId: guard.id, kind: "leaver_settlement", amount: row.inputs.leaverSettlement.amount, dateFrom: row.inputs.leaverSettlement.dateFrom, note: `${GATE_TAG}：離職日（年假補水由引擎計）`, createdBy: actorUserId },
        });
      }

      // 平均工資
      if (row.avgWage) {
        await prisma.guardAvgWage.upsert({
          where: { guardId_month: { guardId: guard.id, month: AUG_MONTH } },
          create: { guardId: guard.id, month: AUG_MONTH, avgDailyWage: row.avgWage.value, source: `${GATE_TAG}：${row.avgWage.source}`, createdBy: actorUserId },
          update: { avgDailyWage: row.avgWage.value, source: `${GATE_TAG}：${row.avgWage.source}` },
        });
      }

      // 病假／年假結餘開波（7 月或之前已經攞咗嘅有薪病假日數、已放年假）
      if (row.priorSlPaidDays || row.priorAlTakenDays) {
        await prisma.guardLeaveBalance.upsert({
          where: { guardId_year: { guardId: guard.id, year: 2026 } },
          create: { guardId: guard.id, year: 2026, slTaken: row.priorSlPaidDays, alTaken: row.priorAlTakenDays, asOfMonth: new Date(Date.UTC(2026, 6, 1)) },
          update: { slTaken: row.priorSlPaidDays, alTaken: row.priorAlTakenDays, asOfMonth: new Date(Date.UTC(2026, 6, 1)) },
        });
      }
    }
    console.log(`[${GATE_TAG}] 配對：${matched}/${fixture.length}（其中 ${nameMatchedCount} 人靠 nameZh 撈返 guard-fix createMinimal 建嘅獨立安員、${createdCount} 人 dev DB 完全冇記錄先新建）`);

    // ------------------------------------------------------------- 8. 重算
    console.log(`[${GATE_TAG}] === 8. recomputeLongtermPayroll(2026-08) ===`);
    const result = await recomputeLongtermPayroll(AUG_MONTH, actorUserId, null);
    console.log(`[${GATE_TAG}] → ${result.totals.guardCount} 人，Gross ${result.totals.grossTotal}／Autopay ${result.totals.autopayTotal}／MPF EE ${result.totals.mpfEeTotal}／ER ${result.totals.mpfErTotal}`);
    if (result.warnings.length) {
      console.log(`[${GATE_TAG}] warnings（${result.warnings.length}）：`);
      for (const w of result.warnings.slice(0, 20)) console.log(`  ${w}`);
    }

    // ------------------------------------------------------------- 9. 逐人比對
    const lines = await prisma.longtermPayrollLine.findMany({ where: { runId: result.runId }, include: { guard: { select: { staffNoMw: true, staffNo: true } } } });
    const lineByStaffNo = new Map(lines.map((l) => [l.guard.staffNoMw ?? l.guard.staffNo ?? "", l]));

    const TOL = 0.05;
    type DiffRow = { staffNo: string; field: string; oracle: number; system: number; diff: number };
    const diffs: DiffRow[] = [];
    let compared = 0;
    for (const row of fixture) {
      const line = lineByStaffNo.get(row.staffNo);
      if (!line) continue;
      compared += 1;
      const checks: Array<[string, number, number]> = [
        ["netBasic", row.oracle.netBasic, Number(line.netBasic)],
        ["gross", row.oracle.gross, Number(line.gross)],
        ["mpfEe", row.oracle.mpfEe, Number(line.mpfEe)],
        ["mpfEr", row.oracle.mpfEr, Number(line.mpfEr)],
        ["autopay", row.oracle.autopay, Number(line.autopay)],
        ["workDays", row.oracle.workDays, Number(line.workDays)],
      ];
      for (const [field, oracle, system] of checks) {
        const diff = round2(system - oracle);
        if (Math.abs(diff) > TOL) diffs.push({ staffNo: row.staffNo, field, oracle, system, diff });
      }
    }

    console.log(`\n[${GATE_TAG}] 逐人比對：${compared}/${fixture.length} 人有對到 line；${diffs.length} 個欄位差異（容差 ${TOL}）`);
    // 總額對 8 月定稿（oracle 全部人，含簽證形式長工）——Opus 5.5 驗收加。
    const sum = (f: (r: LtpayAugFixtureRow) => number) => round2(fixture.reduce((a, r) => a + f(r), 0));
    const oracleTotals = { gross: sum((r) => r.oracle.gross), autopay: sum((r) => r.oracle.autopay), mpfEe: sum((r) => r.oracle.mpfEe), mpfEr: sum((r) => r.oracle.mpfEr) };
    console.log(
      `[${GATE_TAG}] 總額（系統 vs oracle 定稿）：Gross ${result.totals.grossTotal} vs ${oracleTotals.gross}（${round2(result.totals.grossTotal - oracleTotals.gross)}）／Autopay ${result.totals.autopayTotal} vs ${oracleTotals.autopay}（${round2(result.totals.autopayTotal - oracleTotals.autopay)}）／MPF EE ${result.totals.mpfEeTotal} vs ${oracleTotals.mpfEe}（${round2(result.totals.mpfEeTotal - oracleTotals.mpfEe)}）／MPF ER ${result.totals.mpfErTotal} vs ${oracleTotals.mpfEr}（${round2(result.totals.mpfErTotal - oracleTotals.mpfEr)}）；簽證形式 ${result.totals.visaPassthrough.guardCount} 人 Autopay ${result.totals.visaPassthrough.autopayTotal}`,
    );
    // Opus 5.5 驗收：金額欄（netBasic／gross／MPF／autopay）要字面 0 差異先
    // PASS；workDays 唔係出糧金額（賣假係人手輸入），差異淨係 INFO 列出——
    // 8 月已知 1 人 +2（醫院道8號 8/19–20 更表寫返工、老闆確認病假，病假段
    // 輸入已經扣咗錢，更表要喺源頭改）。
    const moneyDiffs = diffs.filter((d) => d.field !== "workDays");
    const infoDiffs = diffs.filter((d) => d.field === "workDays");
    if (infoDiffs.length) {
      console.log(`[${GATE_TAG}] INFO workDays 差異（唔影響金額）：`);
      for (const d of infoDiffs) console.log(`  ${d.staffNo}\t${d.field}\t${d.oracle}\t${d.system}\t${d.diff >= 0 ? "+" : ""}${d.diff}`);
    }
    if (!moneyDiffs.length && compared === fixture.length) {
      console.log(`[${GATE_TAG}] PASS —— ${compared}/${fixture.length} 人金額欄 0 差異${infoDiffs.length ? `（workDays INFO ${infoDiffs.length} 項）` : ""}`);
    } else if (diffs.length) {
      console.log(`[${GATE_TAG}] 差異表（代號・欄・oracle・system・差額）：`);
      for (const d of diffs) console.log(`  ${d.staffNo}\t${d.field}\t${d.oracle}\t${d.system}\t${d.diff >= 0 ? "+" : ""}${d.diff}`);
      const byField = new Map<string, number>();
      for (const d of diffs) byField.set(d.field, (byField.get(d.field) ?? 0) + 1);
      console.log(`[${GATE_TAG}] 逐欄差異數：${[...byField.entries()].map(([f, c]) => `${f}=${c}`).join("、")}`);
      console.log(`[${GATE_TAG}] FAIL（未達 0 差異——呢個 gate 現階段係 harness／diagnostic，同已刪嘅 gate:ltpay-july 一致級別，唔係扮 0 差異）`);
      process.exitCode = 1;
    } else {
      console.log(`[${GATE_TAG}] FAIL —— 淨係對到 ${compared}/${fixture.length} 人`);
      process.exitCode = 1;
    }

    // ------------------------------------------------------------- 9. 一鍵結算
    // 老闆 2026-09-28 效能優化指令（自動化）：跑埋一次一鍵結算（同正式站撳
    // 掣同一條 `runOneClickMonthClose()`，全部 step 冪等），令
    // `gate:postorder-export-aug` 有本月 report_json 可以對 Summary 總收入／
    // 成本／毛利，唔使人手先去頁面撳一次。放喺上面長工糧比對之後，唔影響
    // 已經印出嘅 PASS／FAIL 判斷（一鍵結算內部重算長工糧係同一輸入、同一
    // 結果）。
    console.log(`[${GATE_TAG}] === 9. 一鍵結算 runOneClickMonthClose(2026-08)（俾 gate:postorder-export-aug 對報告）===`);
    const oneClickRun = await prisma.monthCloseRun.create({ data: { month: AUG_MONTH, status: "running", startedById: actorUserId, applyStartedAt: new Date() }, select: { id: true } });
    try {
      await runOneClickMonthClose(oneClickRun.id, AUG_MONTH, actorUserId, null);
    } catch (e) {
      // Opus 5.5 驗收建議：直接 throw 嘅話 run 會一直停喺 running，標返 failed 先再拋。
      await prisma.monthCloseRun.updateMany({ where: { id: oneClickRun.id, status: "running" }, data: { status: "failed", finishedAt: new Date(), errorMessage: e instanceof Error ? e.message.slice(0, 500) : String(e) } });
      throw e;
    }
    const oneClickFinal = await prisma.monthCloseRun.findUniqueOrThrow({ where: { id: oneClickRun.id }, select: { status: true, errorMessage: true } });
    console.log(`[${GATE_TAG}] 一鍵結算 ${oneClickFinal.status}${oneClickFinal.errorMessage ? `：${oneClickFinal.errorMessage}` : ""}`);
    if (oneClickFinal.status !== "done") process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(`[${"gate:ltpay-aug"}] 執行失敗`, err);
  process.exitCode = 1;
});
