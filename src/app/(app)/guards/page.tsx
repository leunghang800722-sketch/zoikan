// A3（Opus 整合驗收）：server component 攞 session 決定 `isBroker`，
// 交俾 `GuardsClient` 決定頁首 kicker（雞頭「我的」／內部角色「主檔」，
// 跟 `src/lib/rbac/nav.ts` 導航分組）——同 `src/app/(app)/my-receivable/
// page.tsx` 同一個 pattern。
//
// WP-PII（Opus 驗收必修 2）：加埋「出街價/保安員個人資料/保安員銀行資料」
// 三個 field-group 嘅 update 權限（`canUpdateSettlement`/`canUpdatePii`/
// `canUpdateBank`）——同 `rate-cards/page.tsx` 嘅 `canReprice` 一致
// pattern。GuardsClient 用呢三個（唔係 view-based 嘅 hasXField）決定
// PATCH body 入唔入嗰組欄位，避免「有 view 冇 update」嘅角色（例如主管
// 見到牌照分區但冇「出街價:update」）連冇改嘅欄都送落 body 觸發 403
// （見 src/lib/api/field-groups.ts dropUnchangedFieldGroupValues()）。
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { hasPermission } from "@/lib/rbac/requirePermission";
import { isGuardOcrConfigured } from "@/lib/guards/ocr/config";
import { GuardsClient } from "./GuardsClient";

export default async function GuardsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const [canUpdateSettlement, canUpdatePii, canUpdateBank, ocrCreate, ocrApply] = await Promise.all([
    hasPermission(session, "出街價", "update"),
    hasPermission(session, "安員個人資料", "update"),
    hasPermission(session, "安員銀行資料", "update"),
    hasPermission(session, "安員批量導入", "create"),
    hasPermission(session, "安員批量導入", "update"),
  ]);
  const canOcr = isGuardOcrConfigured() && ocrCreate && ocrApply;
  return (
    <GuardsClient
      isBroker={session.baseRole === "雞頭"}
      canUpdateSettlement={canUpdateSettlement}
      canUpdatePii={canUpdatePii}
      canUpdateBank={canUpdateBank}
      canOcr={canOcr}
    />
  );
}
