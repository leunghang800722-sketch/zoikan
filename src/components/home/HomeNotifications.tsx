"use client";
// P7.1：首頁「通知」區——未讀數、最新 5 條、全部頁 /notifications。
// 通知內容由排程 job 產生（只有盤名／數字／id／月份，無 PII）。撳一條＝標記已讀並去該頁。
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiGet, apiPost } from "@/lib/ui/api-client";

export interface NotificationItem {
  id: string;
  created_at: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  read: boolean;
}
interface ListResponse {
  rows: NotificationItem[];
  total: number;
  unread: number;
}

export function formatHkTime(iso: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Hong_Kong", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function HomeNotifications() {
  const router = useRouter();
  const [data, setData] = useState<ListResponse | null>(null);

  const load = useCallback(async () => {
    const res = await apiGet<ListResponse>("/api/notifications?take=5");
    if (res.ok) setData(res.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!data || data.total === 0) return null;

  async function open(n: NotificationItem) {
    if (!n.read) await apiPost(`/api/notifications/${n.id}/read`, {});
    if (n.href) router.push(n.href);
    else await load();
  }
  async function readAll() {
    await apiPost("/api/notifications/read-all", {});
    await load();
    router.refresh();
  }

  return (
    <section aria-label="通知" data-testid="home-notifications" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-zk-text">
          通知
          {data.unread > 0 && (
            <span data-testid="home-notifications-unread" className="ml-1.5 rounded-[9px] bg-zk-danger-tint px-1.5 py-px text-zk-2xs font-semibold text-zk-danger-dark">
              未讀 {data.unread}
            </span>
          )}
        </h2>
        {data.unread > 0 && (
          <button type="button" onClick={readAll} className="text-zk-xs text-zk-muted underline underline-offset-2 hover:text-zk-text">
            全部標為已讀
          </button>
        )}
        <Link href="/notifications" className="ml-auto text-zk-xs font-semibold text-zk-primary underline-offset-2 hover:underline">
          全部通知 ›
        </Link>
      </div>
      <ul className="flex flex-col divide-y divide-zk-border overflow-hidden rounded-[10px] border border-zk-border bg-white">
        {data.rows.map((n) => (
          <li key={n.id}>
            <button type="button" data-testid="home-notification-item" data-read={n.read ? "1" : "0"} onClick={() => open(n)} className="flex w-full flex-col gap-0.5 px-3.5 py-2 text-left hover:bg-zk-header focus-visible:outline focus-visible:outline-2 focus-visible:outline-zk-primary">
              <span className="flex items-baseline gap-2">
                {!n.read && <span aria-label="未讀" className="inline-block size-1.5 shrink-0 rounded-full bg-zk-danger" />}
                <span className={`text-zk-base ${n.read ? "text-zk-text-secondary" : "font-semibold text-zk-text"}`}>{n.title}</span>
                <span className="ml-auto shrink-0 text-zk-2xs text-zk-muted">{formatHkTime(n.created_at)}</span>
              </span>
              <span className="truncate text-zk-xs text-zk-muted">{n.body}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
