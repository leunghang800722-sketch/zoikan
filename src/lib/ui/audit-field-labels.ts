// P3-4.3（H16）：操作紀錄 before/after 欄名 key → 中文欄名，同「只顯示有改嘅欄」嘅 diff。
// 冇對照嘅 key 照原樣顯示；原始 JSON 仍然可以展開睇（審計需要）。純顯示，唔改 API。
const LABELS: Record<string, string> = {
  id: "編號", status: "狀態", month: "月份", note: "備註", kind: "類別", name: "名稱", code: "代號", label: "標籤", tel: "電話",
  guardId: "保安員", siteId: "盤", brokerId: "雞頭", shiftTypeId: "更別", userId: "用戶", roleId: "角色", workDate: "日期",
  recordType: "記錄類別", leaveCode: "請假代號", rawCode: "原始代號", source: "來源", sourceRef: "來源參考",
  clientRate: "收客價", guardWage: "保安員工資", brokerFee: "雞頭費", clientRateSnapshot: "收客價（定價時）", guardWageSnapshot: "出街價（定價時）",
  brokerFeeSnapshot: "雞頭費（定價時）", referralFeeSnapshot: "介紹費（定價時）", settlementBrokerId: "結算單位", operationalBrokerId: "營運雞頭",
  effectiveFrom: "生效日", effectiveTo: "失效日", validFrom: "生效日", validTo: "失效日",
  voidedAt: "作廢時間", voidedBy: "作廢人", voidReason: "作廢原因", reason: "原因", createdAt: "建立時間", updatedAt: "更新時間", createdBy: "建立人",
  lockedAt: "鎖定時間", lockedBy: "鎖定人", rosterVersionNote: "更表版本備註", targetShifts: "目標更數",
  canonicalName: "盤名", clientName: "客戶", clientGroup: "客戶組", billingModel: "結算模式", monthlyFee: "月費", monthlyPosts: "月費崗位數",
  prorataBasis: "按比例基準", inScope: "納入範圍", outsideMonthlyClose: "月結以外", guardsPaidByClient: "客戶直接出糧", aliases: "別名",
  rosterFileKeys: "更表檔名關鍵字", defaultSettlementBrokerId: "盤預設雞頭",
  settlementType: "結算類型", requiresApproval: "需要審批", bankInfo: "銀行資料", bankName: "銀行", bankAccountNo: "戶口號碼",
  nameZh: "中文姓名", nameEn: "英文姓名", staffNo: "員工編號", hkid: "身份證", dateOfBirth: "出生日期", hireDate: "入職日期", employmentType: "僱用類別",
  siaPermitNo: "保安許可證號碼", siaPermitExpiry: "保安許可證到期日", safetyCardNo: "平安卡號碼", safetyCardExpiry: "平安卡到期日",
  qasIssueDate: "QAS 簽發日", qasExpiryDate: "QAS 到期日", payoutApprovalLimit: "出街價審批上限", allowedIp: "限制 IP",
  mustChangePwd: "須改密碼", otpEnabled: "雙重驗證", baseRole: "基本角色", isCustom: "自訂角色", module: "模組", action: "動作", granted: "授權",
  startTime: "開始時間", endTime: "結束時間", shiftHours: "更時數", hours: "時數", otHours: "OT 時數", amount: "金額", revenue: "營業額", cost: "成本",
  fileName: "檔名", fileSize: "檔案大小", version: "版本", parseError: "解析錯誤", layoutKey: "更表格式", siteNameRaw: "原始盤名", resolvedSiteId: "對應盤",
  title: "標題", description: "說明", sortOrder: "排序", isPrimary: "主要", address: "地址", relationship: "關係", number: "編號", category: "類別",
  headcountRequired: "需要人手", dailyRequirements: "每日人手要求", feePerShift: "每更費用", payoutRate: "出街價", dailyRate: "日薪", monthlySalary: "月薪",
};

function toCamel(k: string): string {
  return k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function auditFieldLabel(key: string): string {
  return LABELS[key] ?? LABELS[toCamel(key)] ?? key;
}

export interface AuditDiffRow {
  key: string;
  label: string;
  before: string;
  after: string;
}

function show(v: unknown): string {
  if (v === undefined) return "（冇）";
  if (v === null) return "—";
  if (typeof v === "string") return v === "" ? "（空）" : v;
  if (typeof v === "boolean") return v ? "是" : "否";
  if (typeof v === "number") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** 兩個物件逐欄比，淨係回傳有改（或新增／刪除）嘅欄；非物件（例如 null）當空物件。 */
export function diffAuditFields(before: unknown, after: unknown): AuditDiffRow[] {
  const b = before && typeof before === "object" && !Array.isArray(before) ? (before as Record<string, unknown>) : {};
  const a = after && typeof after === "object" && !Array.isArray(after) ? (after as Record<string, unknown>) : {};
  const keys = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]));
  const out: AuditDiffRow[] = [];
  for (const key of keys) {
    if (same(b[key], a[key])) continue;
    out.push({ key, label: auditFieldLabel(key), before: key in b ? show(b[key]) : "（冇）", after: key in a ? show(a[key]) : "（冇）" });
  }
  return out;
}
