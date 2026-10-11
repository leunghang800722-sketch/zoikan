// P10.1：頂位津貼價目表頁（老闆＋會計 view；老闆 edit）。價目表只影響「頂位草稿」金額，草稿未確認唔計糧。
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentSession } from "@/lib/auth/current-session";
import { hasPermission } from "@/lib/rbac/requirePermission";
import { PageHeader } from "@/components/ui/PageHeader";
import { kickerFor } from "@/lib/nav/schema";
import { CoverRatesClient } from "./CoverRatesClient";

export default async function CoverRatesPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (!(await hasPermission(session, "長工糧", "view"))) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader kicker={kickerFor("/settings/cover-rates")} title="頂位價目表" />
        <div className="rounded-lg border border-zk-border bg-white px-6 py-16 text-center text-zk-sm text-zk-muted" data-testid="cover-rates-forbidden">
          你冇權睇呢一頁
        </div>
      </div>
    );
  }
  const isBoss = session.baseRole === "老闆";
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker={kickerFor("/settings/cover-rates")}
        title="頂位價目表"
        subtitle="逐盤逐職級嘅頂位每更津貼。只用嚟計「頂位草稿」金額，草稿會計確認先計糧。"
        actions={isBoss ? <Link href="/settings/cover-rates/infer" className="text-zk-sm text-zk-primary underline" data-testid="cover-rates-to-infer">由歷史反推 ›</Link> : undefined}
      />
      <CoverRatesClient isBoss={isBoss} />
    </div>
  );
}
