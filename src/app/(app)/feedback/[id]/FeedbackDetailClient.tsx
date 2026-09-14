"use client";
// P2.5「現場反映」開會模式——意見詳情（老闆）：完整摘要（markdown）、
// 原對話節錄摺埋、狀態掣（已睇／已轉交／唔做）＋備註、「複製摘要」。
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPatch } from "@/lib/ui/api-client";
import { PageHeader } from "@/components/ui/PageHeader";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { GuardedLink } from "@/components/ui/GuardedLink";
import { SimpleMarkdown } from "@/components/ai/SimpleMarkdown";
import { fmtDateTime } from "@/lib/ui/format";

type FeedbackStatus = "new" | "read" | "forwarded" | "declined";

interface FeedbackReportDetail {
  id: string;
  title: string;
  role_name: string;
  status: FeedbackStatus;
  summary_md: string;
  review_note: string | null;
  transcript_excerpt: { role: "user" | "assistant"; content: string; created_at?: string }[];
  created_at: string;
}

function statusPill(status: FeedbackStatus) {
  if (status === "new") return <Pill variant="warning">新</Pill>;
  if (status === "forwarded") return <Pill variant="success">已轉交</Pill>;
  if (status === "declined") return <Pill variant="neutral">唔做</Pill>;
  return <Pill variant="neutral">已睇</Pill>;
}

export function FeedbackDetailClient({ id }: { id: string }) {
  const [report, setReport] = useState<FeedbackReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState<FeedbackStatus | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiGet<FeedbackReportDetail>(`/api/feedback/reports/${id}`);
    if (res.ok) {
      setReport(res.data);
      setNote(res.data.review_note ?? "");
    } else {
      setError(res.message);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateStatus = useCallback(
    async (status: FeedbackStatus) => {
      setSaving(status);
      const res = await apiPatch(`/api/feedback/reports/${id}`, { status, review_note: note });
      setSaving(null);
      if (res.ok) await load();
      else setError(res.message);
    },
    [id, note, load],
  );

  const handleCopy = useCallback(async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.summary_md);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("複製失敗，請手動選取文字複製");
    }
  }, [report]);

  if (loading) return <div className="text-sm text-zk-muted">載入緊…</div>;
  if (error && !report) return <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>;
  if (!report) return null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        kicker="系統"
        title={report.title}
        subtitle={`${report.role_name} · ${fmtDateTime(report.created_at)}`}
        actions={
          <>
            <span data-testid="feedback-status-pill">{statusPill(report.status)}</span>
            <Button data-testid="feedback-copy-summary" onClick={handleCopy}>
              {copied ? "已複製" : "複製摘要"}
            </Button>
            <GuardedLink href="/feedback" className="text-[13px] text-zk-primary">
              ‹ 返回列表
            </GuardedLink>
          </>
        }
      />

      {error && <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

      <div className="rounded-lg border border-zk-border bg-white px-5 py-4" data-testid="feedback-summary">
        <SimpleMarkdown text={report.summary_md} />
      </div>

      <details className="rounded-lg border border-zk-border bg-white px-5 py-3" data-testid="feedback-transcript">
        <summary className="cursor-pointer text-[13px] font-semibold text-zk-text-secondary">原對話節錄（展開）</summary>
        <div className="mt-3 space-y-2">
          {report.transcript_excerpt.map((m, i) => (
            <div key={i} className="text-[12.5px]">
              <span className="font-semibold text-zk-muted">{m.role === "user" ? "用戶" : "訪談員"}：</span>
              <span className="whitespace-pre-wrap text-zk-text-secondary">{m.content}</span>
            </div>
          ))}
        </div>
      </details>

      <div className="flex flex-col gap-2 rounded-lg border border-zk-border bg-white px-5 py-4">
        <div className="text-[12.5px] font-semibold text-zk-text-secondary">處理備註（俾老闆自己記低跟進情況）</div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="w-full resize-none rounded-md border border-zk-input-border px-2.5 py-2 text-[13px] focus:border-zk-primary focus:outline-none"
        />
        <div className="flex flex-wrap gap-2 pt-1">
          <Button data-testid="feedback-status-read" disabled={saving !== null} onClick={() => updateStatus("read")}>
            {saving === "read" ? "更新緊…" : "已睇"}
          </Button>
          <Button data-testid="feedback-status-forwarded" variant="primary" disabled={saving !== null} onClick={() => updateStatus("forwarded")}>
            {saving === "forwarded" ? "更新緊…" : "已轉交"}
          </Button>
          <Button data-testid="feedback-status-declined" variant="danger" disabled={saving !== null} onClick={() => updateStatus("declined")}>
            {saving === "declined" ? "更新緊…" : "唔做"}
          </Button>
        </div>
      </div>
    </div>
  );
}
