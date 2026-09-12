// 更表編輯器頁面（P1-WP3）——薄 wrapper，主要邏輯喺 client component
// `RosterEditor`（呢個 page.tsx 本身唔使 "use client"，登入殼／導航由
// `(app)/layout.tsx` 負責，呢度淨係拆返 URL 參數轉交落去）。
import RosterEditor from "./RosterEditor";

export default async function RosterPage({
  params,
}: {
  params: Promise<{ site: string; month: string }>;
}) {
  const { site, month } = await params;
  return <RosterEditor siteId={site} month={month} />;
}
