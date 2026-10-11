// P10.2：由 7／8／9 月歷史反推頂位價目表＋回測。**純唯讀、老闆專用**；只有「採用」先寫價目表。
import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentSession } from "@/lib/auth/current-session";
import { PageHeader } from "@/components/ui/PageHeader";
import { kickerFor } from "@/lib/nav/schema";
import { InferClient } from "./InferClient";

export default async function CoverRatesInferPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  if (session.baseRole !== "老闆") {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader kicker={kickerFor("/settings/cover-rates/infer")} title="頂位價：由歷史反推" />
        <div className="rounded-lg border border-zk-border bg-white px-6 py-16 text-center text-zk-sm text-zk-muted" data-testid="cover-infer-forbidden">
          呢一頁淨係老闆先用得到
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker={kickerFor("/settings/cover-rates/infer")}
        title="頂位價：由歷史反推"
        subtitle="用過往月份嘅頂位更同會計人手輸入嘅頂位津貼反推每更價，再回測。推斷唔寫任何嘢，揀「採用」先會寫價目表。"
        actions={<Link href="/settings/cover-rates" className="text-zk-sm text-zk-primary underline">‹ 價目表</Link>}
      />
      <InferClient />
    </div>
  );
}
