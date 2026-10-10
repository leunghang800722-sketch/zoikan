// P3-3.5：「未配對保安員修復」已搬入 `/roster-uploads?tab=fix`。舊路徑保留，一律 redirect（保留合法 ?month=）。
import { redirect } from "next/navigation";
import { isValidMonth } from "@/lib/ui/month-store";

export default async function GuardFixRedirectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const month = typeof sp.month === "string" && isValidMonth(sp.month) ? sp.month : null;
  redirect(`/roster-uploads?tab=fix${month ? `&month=${month}` : ""}`);
}
