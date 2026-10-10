// P3-3.4：報表族（月結總表／毛利／糧明細／長工糧／修正摘要）共用 tab 列。
// 顯示與否按 grants（同導覽一致：`getViewGrants`）；各頁內容、路徑、API 不變。
import { getCurrentSession } from "@/lib/auth/current-session";
import { getViewGrants } from "@/lib/rbac/nav";
import { ReportTabs } from "@/components/reports/ReportTabs";
import { REPORT_TABS } from "@/lib/nav/report-tabs";

export default async function ReportsLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  const grants = session ? await getViewGrants(session) : null;
  const visible = grants ? REPORT_TABS.filter((t) => grants[t.module]).map((t) => t.href as string) : [];
  return (
    <div className="flex flex-col gap-4">
      <ReportTabs visible={visible} />
      {children}
    </div>
  );
}
