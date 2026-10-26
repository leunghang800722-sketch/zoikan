import { PrismaClient } from "@prisma/client";
import { seedRolePermissions } from "../../src/lib/rbac/seed";
import { ROLE_NAMES, MODULES, ACTIONS, type RoleName } from "../../src/lib/rbac/matrix";

// 每個 test file 用返同一個 client（vitest fileParallelism:false，
// 全部 test file 共用 tests/global-setup.ts 起嗰個臨時 postgres）
export const prisma = new PrismaClient();

export async function clearAll() {
  // 注意：audit_log 冇喺度清——佢係 append-only（DB trigger 拒絕
  // UPDATE/DELETE，呢個先係設計本意，見 schema-constraints.test.ts）。
  //
  // P1-WP2 加咗呢個 note：正正因為 audit_log 真係 append-only，`users`
  // 一旦寫過一條 audit_log（例如登入、任何 API 寫入），`audit_log.
  // actor_user_id` 嗰個 FK 就會令 `DELETE FROM users` 觸發一個 `ON DELETE
  // SET NULL`——即係想 UPDATE audit_log，而呢個 UPDATE 會即刻俾 append-only
  // trigger 拒絕（呢個係啱嘅：一個有審計歷史嘅用戶本來就唔應該可以刪）。
  // 所以呢個共用 clearAll() 唔再刪 users/roles/permissions——呢幾樣嘢
  // 淨係喺 tests/global-setup.ts 種一次，成個 test run 共用、唔會變（見
  // seedRolesPermissionsMatrix()）。
  //
  // role_permissions 就唔同：冇任何嘢喺 audit_log 攞佢做 FK，但佢嘅
  // granted 值會俾測試改（例如 tests/wp2-roles-permissions-endpoint.
  // test.ts 開一格 off→on）——所以呢度每次都刪晒再照出廠矩陣重種一次，
  // 保證每個 test 開始都係出廠設定，唔會俾第啲 test file 嘅改動漏過嚟。
  await prisma.triageEvidenceImage.deleteMany({}); // TE-1：覆核證據裁圖（FK 落 triage_sessions，cascade；呢度顯式清）
  await prisma.appNotification.deleteMany({}); // P7.1：通知（無 FK）
  await prisma.jobRun.deleteMany({}); // P7.1：排程紀錄（無 FK）
  await prisma.aiDailyUsage.deleteMany({}); // P9.2：AI 每日額度計數（無 FK）
  await prisma.generatedFile.deleteMany({}); // P8.3：鎖月後生成嘅檔（無 FK）
  await prisma.scheduledJob.deleteMany({});
  await prisma.whatsappIntent.deleteMany({}); // W0：WhatsApp 三表（intent 先於 message；groups 對 site／broker／guard 係 SET NULL，但仍然每個 test 清走）
  await prisma.whatsappMessage.deleteMany({});
  await prisma.whatsappMediaEvidence.deleteMany({}); // WA-8
  await prisma.whatsappGroup.deleteMany({});
  await prisma.appErrorLog.deleteMany({}); // WP-AI-DIAG：應用層錯誤日誌（無 FK）
  await prisma.monthCloseAutoChange.deleteMany({}); // WP-ONE-CLICK-AUTO：自動改動流水帳（FK 落 month_close_runs）
  await prisma.reconcileAllRun.deleteMany({}); // 唔好令前一個 test 檔留低嘅 running 對數 run 擋住下一個
  await prisma.monthCloseRun.deleteMany({});
  await prisma.triageQuestion.deleteMany({ where: { session: { sourceType: { in: ["month_close", "whatsapp"] } } } }); // WP-ONE-CLICK-AUTO／W2 WhatsApp 分診題（唔跨檔累積）
  await prisma.triageSession.deleteMany({ where: { sourceType: { in: ["month_close", "whatsapp"] } } });
  await prisma.triagePersonApply.deleteMany({}); // 分診「最近一次包含呢個人」記錄（append 式）：每個 test 清走，唔好跨檔累積
  await prisma.rolePermission.deleteMany({});
  const roles = await prisma.role.findMany();
  const permissions = await prisma.permission.findMany();
  if (roles.length && permissions.length) {
    const roleIds = Object.fromEntries(roles.map((r) => [r.name, r.id])) as Record<RoleName, string>;
    const permissionIds = Object.fromEntries(permissions.map((p) => [`${p.module}:${p.action}`, p.id]));
    // 防禦：萬一 global-setup 種漏咗某個角色/permission（唔應該發生，但
    // 出咗事寧願 loud fail 都唔想靜靜哋種一半）。
    for (const name of ROLE_NAMES) {
      if (!roleIds[name]) throw new Error(`clearAll(): 全局 role「${name}」唔存在，tests/global-setup.ts 冇種好`);
    }
    for (const m of MODULES) {
      for (const a of ACTIONS) {
        if (!permissionIds[`${m}:${a}`]) throw new Error(`clearAll(): 全局 permission「${m}:${a}」唔存在，tests/global-setup.ts 冇種好`);
      }
    }
    await seedRolePermissions(prisma, roleIds, permissionIds, "test:clearAll-reset-to-default-matrix");
  }

  // P2.5：feedback_reports FK RESTRICT 落 feedback_sessions，要喺嗰張表
  // 之前刪。兩張表都冇任何其他表 FK 落嚟，擺喺呢度（其他表之前）純粹
  // 令呢個函數讀落去有個固定順序，唔影響下面其他刪除。
  await prisma.feedbackReport.deleteMany({});
  await prisma.feedbackSession.deleteMany({});

  // WP-ROSTER-UPLOAD（Opus 驗收 2026-09-23）：roster_uploads 對 site/guard/
  // shift_type/broker 全部係 ON DELETE SET NULL——唔清嘅話，下面刪晒主表之後
  // 舊上載會變成 site_id=null 嘅孤兒「未配對盤」殘留落嚟（rows 跟 CASCADE）。
  await prisma.rosterUpload.deleteMany({});
  // 驗收（Opus 5.5）：Postorder 上載／guard-fix run 會影響「本月 Postorder
  // 係咪生效」同介紹費費率同步——測試之間要清，唔好互相污染。
  await prisma.guardFixRun.deleteMany({});
  await prisma.staffListUpload.deleteMany({}); // 名單上載（FK 落 users；guard_fix_runs 先刪），唔跨檔累積
  await prisma.postorderUpload.deleteMany({});
  await prisma.shiftRecordStaffAttribution.deleteMany({}); // EMP-P1：已鎖月更次工號歸屬側表（FK Restrict 落 shift_records／guard_staff_numbers）
  await prisma.shiftRecord.updateMany({ data: { parentShiftId: null } });
  await prisma.shiftRecord.deleteMany({});
  await prisma.brokerSiteAssignment.deleteMany({}); // C1：清埋先可以安全刪 site/broker
  await prisma.quota.deleteMany({}); // P1-WP3：quotas FK RESTRICT 落 site/shift_type/broker，要喺呢啲表刪之前先清
  await prisma.dailyRequirement.deleteMany({});
  await prisma.rateCard.deleteMany({});
  await prisma.referralFeeRate.deleteMany({});
  await prisma.specialItem.deleteMany({});
  await prisma.monthClose.deleteMany({});
  // 雞頭測試用戶嘅 broker_id 跟住 broker 一齊生生滅滅（見
  // tests/fixtures/wp2-fixture.ts），呢度清埋先可以安全刪 broker。
  await prisma.user.updateMany({ data: { brokerId: null } });
  // WP-STAFFNO：`guard_staff_numbers.guard_id` 係 FK RESTRICT，刪 guard
  // 之前要先清（同 scripts/seed/index.ts clearAll() 一致做法）。
  await prisma.guardStaffNumber.deleteMany({});
  // WP-MULTI：電話／緊急聯絡人／地址三張新表一樣 FK RESTRICT，同上一致
  // 理由。
  await prisma.guardPhone.deleteMany({});
  await prisma.guardEmergencyContact.deleteMany({});
  await prisma.guardAddress.deleteMany({});
  // WP-LTSHIFT：guard_longterm_posts 對 guard／site 都係 FK RESTRICT，
  // 要喺兩張表刪之前先清（同 guard_staff_numbers／GuardPhone 一致做法）。
  await prisma.guardLongtermPost.deleteMany({});
  await prisma.guardMatchOverride.deleteMany({});
  await prisma.guardIdentityConflict.deleteMany({}); // WP-STAFF-IMPORT B1
  // WP-LTPAY：長工糧新表全部 FK RESTRICT 落 guard，要喺 guard 刪之前先清
  // （lines 先，run 先 lines 因為 lines FK CASCADE 落 run，但保守都係
  // 逐張刪清楚）。
  await prisma.longtermPayrollLine.deleteMany({});
  await prisma.longtermPayrollRun.deleteMany({});
  await prisma.longtermPayrollInput.deleteMany({});
  await prisma.guardLeaveBalanceHistory.deleteMany({}); // P15.1：結餘快照（無 FK）
  await prisma.guardLeaveBalance.deleteMany({});
  await prisma.guardAvgWage.deleteMany({}); // §21 任務 4b(b)：新表，guard_id FK RESTRICT，一樣要喺 guard.deleteMany() 之前清（同上面四張表一致做法）
  await prisma.guardLongtermContract.deleteMany({});
  await prisma.coverShiftRate.deleteMany({}); // P10.1：FK RESTRICT 落 site，要喺 site 刪之前先清
  await prisma.guard.updateMany({ data: { defaultBrokerId: null, referralBrokerId: null, visaSponsoredByBrokerId: null } });
  await prisma.guard.deleteMany({});
  await prisma.shiftType.deleteMany({});
  await prisma.site.updateMany({ data: { parentSiteId: null, activityProxySiteId: null } });
  await prisma.site.deleteMany({});
  await prisma.broker.deleteMany({});
}
