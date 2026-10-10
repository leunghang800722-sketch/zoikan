// WP-GUARD-OCR §29：「用證件新增」——單人新增保安員，上載證件由 Claude＋DeepSeek 雙讀辨識自動填表。
// 冇 CLAUDE_API_KEY 同 DEEPSEEK_API_KEY → 404（入口亦隱藏）；權限同「安員批量導入」。
import { notFound, redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/current-session";
import { hasPermission } from "@/lib/rbac/requirePermission";
import { isGuardOcrConfigured } from "@/lib/guards/ocr/config";
import { NewFromDocsClient } from "./NewFromDocsClient";

export default async function NewFromDocsPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  const [create, update, view] = await Promise.all([
    hasPermission(session, "安員批量導入", "create"),
    hasPermission(session, "安員批量導入", "update"),
    hasPermission(session, "安員批量導入", "view"),
  ]);
  if (!isGuardOcrConfigured() || !create || !update || !view) notFound();
  return <NewFromDocsClient />;
}
