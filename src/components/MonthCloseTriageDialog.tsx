"use client";
// WP-ONE-CLICK-AUTO §31.3 E：一鍵結算「要你睇」分診 dialog。
// 每條題：一句原因＋預填建議答案 →「一撳確認」（預覽＋確認一氣呵成，server 用 preview_hash 防資料中途變咗）；
// 要揀其他候選／自己輸入價錢／揀結算雞頭／當新盤／我已覆核，都喺同一張卡。冇 PII：盤名、雞頭代號、更種代號、數目。
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { apiGet, apiPost } from "@/lib/ui/api-client";

interface Candidate {
  id: string;
  label: string;
  evidence: string | null;
  values_text: string | null;
}
interface McQuestion {
  id: string;
  kind: string;
  kind_label: string;
  title: string;
  status: string;
  options: Array<{ id: string; label: string; hint?: string }>;
  mc: {
    summary: string;
    suggestion: string | null;
    confidence: "propose" | "unknown";
    action_type: string;
    count: number | null;
    candidates: Candidate[];
    prefill_candidate_id: string | null;
    needs_price_input: boolean;
    needs_broker_pick: boolean;
    broker_options: Array<{ id: string; code: string }>;
    identity_label: string | null;
  };
}
interface SessionRes {
  session: { id: string; status: string; counts: { open: number; answered: number; skipped: number; total: number } };
  questions: McQuestion[];
}
interface Impact {
  can_confirm: boolean;
  summary: string[];
  notes: string[];
}

export function MonthCloseTriageDialog({ sessionId, onClose, onChanged }: { sessionId: string; onClose: () => void; onChanged?: () => void }) {
  const [qs, setQs] = useState<McQuestion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[]>([]);
  const [candidate, setCandidate] = useState<string>("");
  const [broker, setBroker] = useState<string>("");
  const [price, setPrice] = useState<{ client: string; wage: string; fee: string }>({ client: "", wage: "", fee: "" });
  const [mode, setMode] = useState<"accept" | "pick" | "price" | "other">("accept");

  const load = useCallback(async () => {
    const res = await apiGet<SessionRes>(`/api/triage/sessions/${sessionId}`);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setQs(res.data.questions.filter((q) => q.status === "open"));
  }, [sessionId]);
  useEffect(() => {
    void load();
  }, [load]);

  const q = qs?.[0] ?? null;
  useEffect(() => {
    setCandidate("");
    setBroker("");
    setPrice({ client: "", wage: "", fee: "" });
    setMode(q?.mc.prefill_candidate_id ? "accept" : q?.mc.needs_price_input ? "price" : "pick");
  }, [q?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(answer: Record<string, unknown>, doneLabel: string) {
    if (!q) return;
    setBusy(true);
    setError(null);
    const pv = await apiPost<{ preview_hash: string; writes: boolean; impact: Impact }>(`/api/triage/questions/${q.id}/preview`, { answer });
    if (!pv.ok) {
      setBusy(false);
      setError(pv.message);
      return;
    }
    const res = await apiPost<{ status: string; impact: Impact | null }>(`/api/triage/questions/${q.id}/answer`, { answer, preview_hash: pv.data.preview_hash });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setDone((d) => [...d, `${doneLabel}：${pv.data.impact.summary.join("；")}`]);
    onChanged?.();
    await load();
  }

  async function skip() {
    if (!q) return;
    setBusy(true);
    const res = await apiPost(`/api/triage/questions/${q.id}/answer`, { answer: { option: "skip" } });
    setBusy(false);
    if (!res.ok) setError(res.message);
    else await load();
  }

  const has = (id: string) => q?.options.some((o) => o.id === id) ?? false;
  const priceBody = () => ({
    option: "mc_price",
    price: {
      ...(price.client ? { client_rate: Number(price.client) } : {}),
      ...(price.wage ? { guard_wage: Number(price.wage) } : {}),
      ...(price.fee ? { broker_fee: Number(price.fee) } : {}),
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" data-testid="mc-triage-dialog">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-xl bg-white shadow-xl sm:max-w-xl sm:rounded-xl">
        <div className="flex items-center justify-between gap-2 border-b border-zk-border px-4 py-3">
          <div>
            <div className="text-[15px] font-semibold">一鍵結算——要你睇</div>
            {q && qs && <div className="text-[12px] text-zk-muted">仲有 {qs.length} 題（每題一句原因，預填建議答案，一撳確認）</div>}
          </div>
          <button type="button" onClick={onClose} className="rounded px-2 py-1 text-[13px] text-zk-muted hover:bg-zk-header" data-testid="mc-later">
            遲啲先答
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto px-4 py-3">
          {error && <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-700">{error}</div>}
          {done.length > 0 && (
            <ul className="list-disc space-y-0.5 rounded border border-green-300 bg-green-50 px-5 py-2 text-[12px] text-green-800" data-testid="mc-done">
              {done.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
          {qs === null && <div className="text-[13px] text-zk-muted">載入緊…</div>}
          {qs !== null && !q && (
            <div className="space-y-2 py-6 text-center">
              <div className="text-[15px] font-semibold">全部處理完</div>
              <Button variant="primary" onClick={onClose}>
                完成
              </Button>
            </div>
          )}
          {q && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Pill variant="neutral">{q.kind_label}</Pill>
                <Pill variant={q.mc.confidence === "propose" ? "warning" : "danger"}>{q.mc.confidence === "propose" ? "有建議" : "冇依據"}</Pill>
              </div>
              <div className="text-[14px] font-medium">{q.title}</div>
              <div className="text-[12.5px] text-zk-muted" data-testid="mc-summary">
                {q.mc.summary}
              </div>
              {q.mc.identity_label && <div className="text-[12px] text-zk-faint">更表身份：{q.mc.identity_label}</div>}

              {q.mc.candidates.length > 0 && (
                <fieldset className="space-y-1.5" disabled={busy}>
                  <legend className="text-[12.5px] font-semibold">候選</legend>
                  {q.mc.candidates.map((c) => (
                    <label key={c.id} className="flex cursor-pointer items-start gap-2 rounded-md border border-zk-border p-2 text-[13px] has-[:checked]:border-zk-primary has-[:checked]:bg-blue-50">
                      <input
                        type="radio"
                        name="mc-candidate"
                        className="mt-0.5"
                        checked={(candidate || q.mc.prefill_candidate_id || "") === c.id}
                        onChange={() => {
                          setCandidate(c.id);
                          setMode(c.id === q.mc.prefill_candidate_id ? "accept" : "pick");
                        }}
                      />
                      <span className="flex-1">
                        {c.label}
                        {c.values_text ? <b className="ml-1">{c.values_text}</b> : null}
                        {c.evidence ? <span className="block text-[11.5px] text-zk-faint">{c.evidence}</span> : null}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}

              {q.mc.needs_broker_pick && has("mc_pick") && (
                <label className="block text-[12.5px]">
                  <span className="mb-1 block text-zk-muted">或者揀其他結算雞頭</span>
                  <select className="w-full rounded-[5px] border border-zk-border px-2 py-1.5" aria-label="結算雞頭" value={broker} onChange={(e) => { setBroker(e.target.value); setMode("pick"); }}>
                    <option value="">揀雞頭…</option>
                    {q.mc.broker_options.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.code}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {q.mc.needs_price_input && has("mc_price") && (
                <fieldset className="space-y-1.5 rounded border border-zk-border p-2" disabled={busy}>
                  <legend className="px-1 text-[12.5px] font-semibold">自己輸入價錢（元／更）</legend>
                  <div className="grid grid-cols-3 gap-2">
                    {([["client", "客價"], ["wage", "工資"], ["fee", "雞頭費"]] as const).map(([k, label]) => (
                      <label key={k} className="block text-[12px]">
                        <span className="text-zk-muted">{label}</span>
                        <input
                          inputMode="decimal"
                          className="mt-0.5 w-full rounded-[5px] border border-zk-border px-2 py-1.5"
                          aria-label={label}
                          value={price[k]}
                          onChange={(e) => {
                            setPrice((p) => ({ ...p, [k]: e.target.value.replace(/[^0-9.]/g, "") }));
                            setMode("price");
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </>
          )}
        </div>
        {q && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zk-border px-4 py-3">
            <Button disabled={busy} onClick={skip} data-testid="mc-skip">
              跳過，留返人手
            </Button>
            <div className="flex flex-wrap items-center gap-2">
              {has("mc_new") && (
                <Button disabled={busy} onClick={() => submit({ option: "mc_new" }, "當新盤")} data-testid="mc-new">
                  唔係，當新盤
                </Button>
              )}
              {has("mc_ack") && (
                <Button variant="primary" disabled={busy} onClick={() => submit({ option: "mc_ack" }, "已覆核")} data-testid="mc-ack">
                  我已覆核，冇問題
                </Button>
              )}
              {q.mc.needs_price_input && has("mc_price") && (
                <Button disabled={busy || (!price.client && !price.wage && !price.fee)} onClick={() => submit(priceBody(), "輸入價錢")} data-testid="mc-price">
                  用我輸入嘅價錢
                </Button>
              )}
              {q.mc.needs_broker_pick && broker && (
                <Button disabled={busy} onClick={() => submit({ option: "mc_pick", value: broker }, "揀結算雞頭")} data-testid="mc-pick-broker">
                  歸所揀雞頭
                </Button>
              )}
              {!q.mc.needs_broker_pick && has("mc_pick") && (candidate || q.mc.prefill_candidate_id) && candidate !== q.mc.prefill_candidate_id && mode === "pick" && (
                <Button disabled={busy} onClick={() => submit({ option: "mc_pick", candidate_id: candidate }, "揀候選")} data-testid="mc-pick">
                  用所揀候選
                </Button>
              )}
              {has("mc_accept") && q.mc.prefill_candidate_id && (
                <Button variant="primary" disabled={busy} onClick={() => submit({ option: "mc_accept" }, "一撳確認")} data-testid="mc-accept">
                  {busy ? "處理緊…" : "一撳確認"}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
