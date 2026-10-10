// P3-5.3：對數（reconcile）類 route 共用前置檢查——上載必須存在（404），已作廢（WP-UPLOAD-VOID）
// 一律 409。`applyReconcileDecisions()` 內部嘅狀態檢查用 400，呢度做返任務書明文要求嘅 409，
// 喺入去 service 層之前擋。
import { prisma } from "@/lib/db";
import { Conflict, NotFound } from "@/lib/api/errors";

export async function assertUploadReconcilable(uploadId: string): Promise<{ id: string; status: string }> {
  const exists = await prisma.rosterUpload.findUnique({ where: { id: uploadId }, select: { id: true, status: true } });
  if (!exists) throw NotFound();
  if (exists.status === "voided") throw Conflict("呢個上載已經作廢，唔可以對數");
  return exists;
}
