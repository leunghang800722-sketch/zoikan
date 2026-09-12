// Opus 對抗式驗收第三輪 B2（必修）gate：新月份（未 seed 過原檔字面）
// 匯出唔可以再係零安員行。
//
// 做法（跟 coordinator 個裁定逐步）：
//   1. `npm run db:reset`（停→刪→起→migrate→seed，由零重新種一次真實
//      7 月 seed 數據——除非帶 `--skip-reset`，見底部參數說明）。
//   2. 用「測試主管」（真實 seed 出嚟嘅固定假測試帳號，tel=90000002，
//      同 tests/e2e/db-helpers.ts／scripts/seed/index.ts 用嘅同一個，
//      唔係新 PDPO 暴露）嘅 session，直接 call route handler（唔經
//      HTTP，同 tests/*.test.ts 嘅手法一致）開 2026-08（複製上月
//      quotas／daily_requirements／broker_site_assignments 結構，但
//      **唔複製 shift_records**——呢個先係 B2 個 bug 場景嘅成因：8 月
//      一開始梗係零 shift_records）。
//   3. 用同一個主管 session，call `/api/shift-records/batch` 真實批量
//      填 N 格（每格一個唔同嘅「7 月做過呢個盤」嘅安員×更別組合，落
//      喺 8 月一個未填過嘅日子）。
//   4. 匯出 2026-08 xlsx（`buildRosterWorkbookForSite`，唔經 HTTP，
//      同 gate 腳本 roster-export-diff.ts 一致做法）。
//   5. 斷言：(a) N 格入面每一格填落嘅代號都喺 xlsx 正確位置印到；
//      (b) 8 月匯出嘅骨架（banner/header/guard_rows/total_group 呢類
//          section 逐行 render 出嚟嘅總行數）同 7 月一致——`roster_
//          layout` 本身掛喺 site（唔跟月份），理論上兩個月應該一模
//          一樣，呢度用真實兩次 render 實測驗證（唔係紙上談兵）。
//
// 輸出真實 exit code：全部斷言過先 exit 0，任何一項失敗即刻列印原因
// 並 exit 1（唔會吞聲跑埋晒先話畀你知）。
//
// PDPO：呢個腳本淨係印統計數字／boolean／真假結果，唔會印任何真實
// 安員/雞頭姓名、工號、電話（逐格比對用嘅係 in-memory 字串比較，唔會
// console.log 出嚟）。
import { execSync } from "node:child_process";
import { prisma } from "../seed/lib/db";
import { sealSession, type SessionData } from "../../src/lib/auth/session";
import { POST as openMonth } from "../../src/app/api/months/[month]/open/route";
import { POST as batchShiftRecords } from "../../src/app/api/shift-records/batch/route";
import { buildRosterWorkbookForSite } from "../../src/lib/roster-export";

const SITE_NAME_CONTAINS = "啟航1331"; // 同 tests/e2e/wp3.spec.ts 用緊嘅同一個盤，已知有 roster_layout 模板
const AUG = new Date(Date.UTC(2026, 7, 1));
const JUL = new Date(Date.UTC(2026, 6, 1));
const FILL_DAY = 20; // 8 月一個july provenance 冧唔到嘅日子，任揀——只要8月未填過
const N_CELLS = 5;

// 同 src/lib/roster-export.ts 入面私有嘅 displayShiftCode() 一致邏輯
// （見嗰個檔案：seed 撞 key 加嘅 `-2`／`-3` 尾綴唔會印落逐日格）。
function displayShiftCode(code: string): string {
  return code.replace(/-\d+$/, "");
}

function req(url: string, cookie: string, method: string, body?: unknown) {
  return new Request(url, { method, headers: { "content-type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
}

async function supervisorCookie(): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { tel: "90000002" }, include: { role: true } });
  const data: SessionData = {
    userId: user.id,
    tel: user.tel,
    name: user.name,
    roleId: user.roleId,
    roleName: user.role.name,
    baseRole: user.role.baseRole,
    brokerId: user.brokerId,
    guardId: user.guardId,
    payoutApprovalLimit: user.payoutApprovalLimit ? user.payoutApprovalLimit.toString() : null,
    tokenVersion: user.tokenVersion,
    loggedInAt: new Date().toISOString(),
  };
  return `zoikan_session=${encodeURIComponent(await sealSession(data))}`;
}

async function main() {
  const skipReset = process.argv.includes("--skip-reset");
  const failures: string[] = [];

  if (skipReset) {
    console.log("[roster-export-newmonth-gate] --skip-reset：跳過 db:reset（假設呼叫者已經跑過一次乾淨嘅 db:reset && db:seed）");
  } else {
    console.log("[roster-export-newmonth-gate] $ npm run --silent db:reset（由零重新種 7 月真實 seed 數據，可能要幾分鐘）");
    execSync("npm run --silent db:reset", { stdio: "inherit" });
  }

  const site = await prisma.site.findFirstOrThrow({ where: { canonicalName: { contains: SITE_NAME_CONTAINS } } });
  if (!site.rosterLayout) {
    console.error(`[roster-export-newmonth-gate] ${SITE_NAME_CONTAINS} 冇 roster_layout 模板——呢個 gate 假設嘅前提（有模板嘅 site）唔成立，exit 1`);
    process.exitCode = 1;
    return;
  }

  const cookie = await supervisorCookie();

  // ---- 步驟 1：開 2026-08（複製上月結構，唔複製 shift_records） ----
  const openRes = await openMonth(req("http://test.local/api/months/2026-08/open", cookie, "POST", {}), { params: Promise.resolve({ month: "2026-08" }) });
  const openBody = await openRes.json();
  if (openRes.status !== 200 && openRes.status !== 201) {
    failures.push(`months/2026-08/open 應該 200/201，實際 ${openRes.status}：${JSON.stringify(openBody)}`);
  }
  console.log(`[roster-export-newmonth-gate] months/open 2026-08 -> status=${openRes.status} already_open=${openBody.already_open} assignments_created=${openBody.broker_site_assignments_created} quotas_created=${openBody.quotas_created} dr_created=${openBody.daily_requirements_created}`);

  const beforeFillCount = await prisma.shiftRecord.count({ where: { siteId: site.id, workDate: { gte: AUG, lte: new Date(Date.UTC(2026, 7, 31)) } } });
  console.log(`[roster-export-newmonth-gate] 8 月開咗之後、批量填格之前，${SITE_NAME_CONTAINS} shift_records 數量=${beforeFillCount}（B2 bug 場景嘅前提：呢度應該係 0，months/open 唔複製 shift_records）`);

  // ---- 步驟 2：揀 N 個「7 月做過呢個盤」嘅 (guard, shift_type) 組合，
  // 批量填落 8 月 FILL_DAY（真實 API，主管 session）。----
  const julyRecords = await prisma.shiftRecord.findMany({
    where: { siteId: site.id, workDate: { gte: JUL, lte: new Date(Date.UTC(2026, 6, 31)) }, recordType: "shift", status: { not: "cancelled" } },
    include: { shiftType: true, guard: true },
    distinct: ["guardId", "shiftTypeId"],
    take: N_CELLS,
    orderBy: [{ workDate: "asc" }],
  });
  if (julyRecords.length < N_CELLS) {
    failures.push(`7 月搵唔到 ${N_CELLS} 個唔同 (guard,shift_type) 組合可以攞嚟填 8 月（實際搵到 ${julyRecords.length} 個）`);
  }

  type FillTarget = { guardId: string; shiftTypeId: string; code: string; displayCode: string; staffNo: string | null; nameZh: string };
  const targets: FillTarget[] = julyRecords.map((r) => ({
    guardId: r.guardId,
    shiftTypeId: r.shiftTypeId,
    code: r.shiftType.code,
    displayCode: displayShiftCode(r.shiftType.code),
    staffNo: r.guard.staffNo,
    nameZh: r.guard.nameZh,
  }));

  const cells = targets.map((t) => ({
    guard_id: t.guardId,
    shift_type_id: t.shiftTypeId,
    work_date: `2026-08-${String(FILL_DAY).padStart(2, "0")}`,
    code: t.code,
  }));
  const batchRes = await batchShiftRecords(req("http://test.local/api/shift-records/batch", cookie, "POST", { site_id: site.id, month: "2026-08", cells }));
  const batchBody = await batchRes.json();
  if (batchRes.status !== 200) {
    failures.push(`shift-records/batch 應該 200，實際 ${batchRes.status}：${JSON.stringify(batchBody)}`);
  }
  console.log(`[roster-export-newmonth-gate] batch 填咗 ${targets.length} 格落 2026-08-${FILL_DAY} -> status=${batchRes.status}`);

  // ---- 步驟 3：匯出 2026-08 同 2026-07，逐格 in-memory 比對（唔 print 內容）----
  const augResult = await buildRosterWorkbookForSite(site.id, AUG);
  const julResult = await buildRosterWorkbookForSite(site.id, JUL);
  const augWs = augResult.workbook.getWorksheet("2026")!;
  const julWs = julResult.workbook.getWorksheet("2026")!;

  // (a) 逐格斷言：每個 target 嘅 guard，喺 8 月 xlsx 應該可以搵到一行
  //     佢自己（用 staffNo 做行識別——唔靠估行號，直接掃描比對），而
  //     且 FILL_DAY 嗰個 day column 嘅值要係 displayCode。
  const labelCol = 6; // detectLayout(啟航1331) === "standard"（唔含「數碼港」/「城巴」）
  let matchedTargets = 0;
  for (const t of targets) {
    if (!t.staffNo) {
      failures.push(`target guard 冇 staff_no，冇辦法用嚟喺 xlsx 搵返自己一行（PDPO：呢度唔印真名）`);
      continue;
    }
    let foundRow: number | null = null;
    augWs.eachRow((row, rowNumber) => {
      if (foundRow !== null) return;
      const v = row.getCell(4).value; // col4 = Staff No.（standard layout）
      if (typeof v === "string" && v === t.staffNo) foundRow = rowNumber;
    });
    if (foundRow === null) {
      failures.push(`8 月匯出搵唔到 target guard 嗰一行（用 staff_no 比對，唔印真名）`);
      continue;
    }
    const dayCol = labelCol + 1 + (FILL_DAY - 1);
    const cellValue = augWs.getCell(foundRow, dayCol).value;
    if (cellValue !== t.displayCode) {
      failures.push(`8 月匯出 row=${foundRow} day=${FILL_DAY} 應該係 displayCode，實際值型別=${typeof cellValue}（唔係預期代號——唔印實際字面，PDPO/避免誤植真代號落 log）`);
      continue;
    }
    matchedTargets++;
  }
  console.log(`[roster-export-newmonth-gate] N=${targets.length} 格入面，喺 8 月匯出搵到＋位置啱嘅=${matchedTargets}`);
  if (matchedTargets !== targets.length) {
    failures.push(`matchedTargets(${matchedTargets}) !== targets.length(${targets.length})——B2 冇完全修好`);
  }

  // (b) 骨架斷言：8 月同 7 月嘅 render 總行數要一致（roster_layout 掛喺
  //     site 本身，唔跟月份，兩個月理論上應該一樣——呢度用真實兩次
  //     render 實測驗證，唔淨係睇 template JSON）。呢個唔係「8 月冇
  //     resolved 出嚟嘅 guard 位」呢種內容差異（e.g. 冇填嘅安員行點計
  //     都可能唔同），淨係比較*結構性* section 數——banner/header/
  //     total_group/blank 呢類「唔跟實際填幾多格變」嘅行數固定唔變，
  //     所以兩個月嘅 `rowCount` 應該完全相等（guard_rows 嘅 rowFrom~
  //     rowTo 範圍係模板固定嘅，唔會因為8月冧咗啲行）。
  console.log(`[roster-export-newmonth-gate] 骨架比對：7 月 rowCount=${julWs.rowCount}，8 月 rowCount=${augWs.rowCount}`);
  if (julWs.rowCount !== augWs.rowCount) {
    failures.push(`骨架唔一致：7 月 rowCount=${julWs.rowCount} != 8 月 rowCount=${augWs.rowCount}（roster_layout 掛喺 site，理論上唔跟月份變）`);
  }

  // ---- 收尾：真實 exit code ----
  if (failures.length > 0) {
    console.error(`[roster-export-newmonth-gate] FAIL（${failures.length} 項）：`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("[roster-export-newmonth-gate] PASS：8 月新月份匯出唔再係零安員行，N 格全部位置啱，骨架同 7 月一致。exit 0");
}

main()
  .catch((err) => {
    console.error("[roster-export-newmonth-gate] 未捕捉例外：", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
