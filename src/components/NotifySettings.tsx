"use client";
// P7.1：通知電郵＋每類通知 email 開關。本人改自己（改密碼頁）；老闆改所有人（用戶頁）。
// 電郵屬聯絡資料：只經 /api/users/:id/notify 讀寫，audit 只記「已改」。
import { useEffect, useState } from "react";
import { apiGet, apiPatch } from "@/lib/ui/api-client";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Field, inputCls } from "@/components/ui/Field";
import { NOTIFY_KINDS } from "@/lib/notify/kinds";

interface Settings {
  notify_email: string | null;
  notify_prefs: Record<string, boolean>;
}

export function NotifySettings({ userId, onSaved }: { userId: string; onSaved?: () => void }) {
  const [email, setEmail] = useState("");
  const [prefs, setPrefs] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    (async () => {
      const res = await apiGet<Settings>(`/api/users/${userId}/notify`);
      if (cancelled) return;
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setEmail(res.data.notify_email ?? "");
      setPrefs(res.data.notify_prefs ?? {});
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const res = await apiPatch<Settings>(`/api/users/${userId}/notify`, { notify_email: email.trim() === "" ? null : email.trim(), notify_prefs: prefs });
    setSaving(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setEmail(res.data.notify_email ?? "");
    setNotice("已儲存");
    onSaved?.();
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3" data-testid="notify-settings">
      <Banner kind="error" message={error} />
      <Banner kind="success" message={notice} />
      <Field label="通知電郵" hint="系統排程通知（新月已開好、價卡待確認、體檢紅項等）會寄去呢個電郵；留空＝只喺系統內通知。電郵只用嚟收通知。">
        <input type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} disabled={!loaded} autoComplete="email" data-testid="notify-email-input" />
      </Field>
      <fieldset className="flex flex-col gap-1.5" disabled={!loaded}>
        <legend className="mb-1 text-zk-sm text-zk-text-secondary">寄電郵嘅通知類別（站內通知照常有）</legend>
        {NOTIFY_KINDS.map((k) => (
          <label key={k.kind} className="flex items-center gap-2 text-zk-base text-zk-text">
            <input type="checkbox" checked={prefs[k.kind] !== false} onChange={(e) => setPrefs((p) => ({ ...p, [k.kind]: e.target.checked }))} data-testid={`notify-pref-${k.kind}`} />
            {k.label}
          </label>
        ))}
      </fieldset>
      <div>
        <Button type="submit" variant="primary" disabled={saving || !loaded} data-testid="notify-save">
          {saving ? "儲存中…" : "儲存通知設定"}
        </Button>
      </div>
    </form>
  );
}
