"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, type ApiListResult } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { btnPrimary, inputCls, selectCls } from "@/components/ui/Field";

interface SiteRow {
  id: string;
  canonical_name: string;
  client_name?: string;
  status: string;
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function RosterEntryPage() {
  const router = useRouter();
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [siteId, setSiteId] = useState("");
  const [month, setMonth] = useState(currentMonth());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await apiGet<ApiListResult<SiteRow>>("/api/sites?take=500");
      if (!res.ok) {
        setError(res.message);
      } else {
        setSites(res.data.rows);
        if (res.data.rows.length > 0) setSiteId(res.data.rows[0].id);
      }
      setLoading(false);
    })();
  }, []);

  function onOpen(e: React.FormEvent) {
    e.preventDefault();
    if (!siteId || !month) return;
    router.push(`/roster/${siteId}/${month}`);
  }

  return (
    <div className="max-w-lg space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">更表</h1>
        <p className="text-sm text-gray-500">揀盤揀月，開啟嗰個月嘅更表編輯器。</p>
      </div>
      <Banner kind="error" message={error} />
      <form onSubmit={onOpen} className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
        <label className="block space-y-1">
          <span className="block text-sm text-gray-700">盤</span>
          <select className={selectCls} value={siteId} onChange={(e) => setSiteId(e.target.value)} disabled={loading} required>
            {sites.length === 0 && <option value="">（冇盤）</option>}
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.canonical_name}
                {s.client_name ? `（${s.client_name}）` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="block text-sm text-gray-700">月份</span>
          <input type="month" className={inputCls} value={month} onChange={(e) => setMonth(e.target.value)} required />
        </label>
        <button type="submit" disabled={loading || !siteId} className={btnPrimary}>
          開啟
        </button>
      </form>
    </div>
  );
}
