// P3-3.3：尚欠總覽已併入首頁（今日尚欠表＋待辦收件箱）。舊路徑保留，一律 redirect `/`
// （保留 ?date= 等 query，等舊書籤／連結睇返同一日）。
import { redirect } from "next/navigation";

export default async function ShortfallRedirectPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const date = typeof sp.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : null;
  redirect(date ? `/?date=${date}` : "/");
}
