// WP-ROSTER-UPLOAD Phase B-1（B1-3）：對數頁——薄 wrapper，主要邏輯喺
// client component `ReconcileClient`（同 roster/[site]/[month]/page.tsx
// 一樣嘅寫法：page.tsx 唔使 "use client"，登入殼由 (app)/layout.tsx 負
// 責）。「更表上載」module 硬性 deny 雞頭／保安員（見 matrix.ts），呢頁
// 冇額外隔離邏輯——API 一律 403 就夠。
import ReconcileClient from "./ReconcileClient";

export default async function RosterUploadReconcilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReconcileClient uploadId={id} />;
}
