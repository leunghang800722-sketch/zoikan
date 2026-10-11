"use client";
// P7.1：全部通知（本人 audience）。通知內容只有盤名／數字／id／月份。
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/DataTable";
import { apiGet, apiPost } from "@/lib/ui/api-client";
import { kickerFor } from "@/lib/nav/schema";
import { formatHkTime, type NotificationItem } from "@/components/home/HomeNotifications";
import { kindLabel } from "@/lib/notify/kinds";

const PAGE = 30;

export default function NotificationsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<NotificationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [unread, setUnread] = useState(0);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (skip: number, append: boolean) => {
      const res = await apiGet<{ rows: NotificationItem[]; total: number; unread: number }>(`/api/notifications?take=${PAGE}&skip=${skip}${onlyUnread ? "&unread=1" : ""}`);
      setLoading(false);
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setError(null);
      setRows((prev) => (append ? [...prev, ...res.data.rows] : res.data.rows));
      setTotal(res.data.total);
      setUnread(res.data.unread);
    },
    [onlyUnread],
  );
  useEffect(() => {
    void load(0, false);
  }, [load]);

  async function open(n: NotificationItem) {
    if (!n.read) await apiPost(`/api/notifications/${n.id}/read`, {});
    if (n.href) router.push(n.href);
    else await load(0, false);
  }
  async function readAll() {
    await apiPost("/api/notifications/read-all", {});
    await load(0, false);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4" data-testid="notifications-page">
      <PageHeader
        kicker={kickerFor("/notifications")}
        title="通知"
        subtitle={`未讀 ${unread} 條，共 ${total} 條。通知由系統排程自動產生，內容只有盤名、數字同月份。`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setOnlyUnread((v) => !v)} data-testid="notifications-toggle-unread">
              {onlyUnread ? "顯示全部" : "只睇未讀"}
            </Button>
            <Button variant="secondary" onClick={readAll} disabled={unread === 0} data-testid="notifications-read-all">
              全部標為已讀
            </Button>
          </>
        }
      />
      <Banner kind="error" message={error} />
      {!loading && rows.length === 0 ? (
        <EmptyState title={onlyUnread ? "冇未讀通知" : "暫時冇通知"} />
      ) : (
        <ul className="flex flex-col divide-y divide-zk-border overflow-hidden rounded-[10px] border border-zk-border bg-white">
          {rows.map((n) => (
            <li key={n.id}>
              <button type="button" data-testid="notification-item" data-read={n.read ? "1" : "0"} onClick={() => open(n)} className="flex w-full flex-col gap-0.5 px-4 py-2.5 text-left hover:bg-zk-header focus-visible:outline focus-visible:outline-2 focus-visible:outline-zk-primary">
                <span className="flex items-baseline gap-2">
                  {!n.read && <span aria-label="未讀" className="inline-block size-1.5 shrink-0 rounded-full bg-zk-danger" />}
                  <span className={`text-zk-md ${n.read ? "text-zk-text-secondary" : "font-semibold text-zk-text"}`}>{n.title}</span>
                  <span className="rounded bg-zk-header px-1.5 text-zk-2xs text-zk-muted">{kindLabel(n.kind)}</span>
                  <span className="ml-auto shrink-0 text-zk-xs text-zk-muted">{formatHkTime(n.created_at)}</span>
                </span>
                <span className="text-zk-sm text-zk-muted">{n.body}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {rows.length < total && (
        <div>
          <Button variant="secondary" onClick={() => load(rows.length, true)}>
            載入更多
          </Button>
        </div>
      )}
    </div>
  );
}
