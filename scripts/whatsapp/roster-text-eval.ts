// WA-9 (7)：文字名單／caption／plan 分類評估（離線、純函數、唔連 DB、唔 call API）。
//   npx tsx scripts/whatsapp/roster-text-eval.ts --dir <wa-export 目錄>
// 讀 `texts.json`（lists／texts／labels）同 `rows-meta.psv`，對每條去重文字跑 detectRosterList／detectRosterPlan／classifyText／scoreMessage，
// 同 labels 比較。**只印計數**——冇姓名、冇工號、冇任何原文片段。目錄永遠唔入 git。
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { detectRosterList, detectRosterPlan } from '@/lib/whatsapp/roster-list';
import { classifyText, TIME_RANGE_RE } from '@/lib/whatsapp/report-kinds';
import { scoreMessage } from '@/lib/whatsapp/filter';
import { normNameVariant } from '@/lib/names/variants';

type Entry = { group: string; first_ts: string; n?: number; text?: string; lines?: string[]; lines_same_as?: string; tail?: string[] };
interface Texts { labels: Record<string, number[] | string>; superseded: Record<string, number>; texts: Record<string, Entry>; lists: Record<string, Entry> }

const nums = (xs: string[]): number => xs.length;

async function main(): Promise<void> {
  const i = process.argv.indexOf('--dir');
  if (i < 0 || !process.argv[i + 1]) throw new Error('用法：--dir <wa-export 目錄>');
  const dir = process.argv[i + 1]!;
  const d = JSON.parse(await readFile(path.join(dir, 'texts.json'), 'utf8')) as Texts;
  const entry = (k: number): Entry | undefined => d.texts[String(k)] ?? d.lists[String(k)];
  // 部分名單以「前 1–K 日同某條一樣＋tail」壓縮儲存 → 還原
  const linesOf = (e: Entry): string[] => {
    if (e.lines) return e.lines;
    if (!e.lines_same_as) return (e.text ?? '').split('\n');
    const m = /^(\d+)\s+前\s*1[–-](\d+)\s*日/.exec(e.lines_same_as);
    const ref = m ? d.lists[m[1]!] : undefined;
    if (!m || !ref) return e.tail ?? [];
    const base = linesOf(ref);
    const nextDay = Number(m[2]) + 1;
    const cut = base.findIndex((l) => new RegExp(`^\\*?\\s*0?${nextDay}\\s*[/／]\\s*[\\dOo]{1,2}`).test(l.trim()));
    return [...(cut < 0 ? base : base.slice(0, cut)), ...(e.tail ?? [])];
  };
  const textOf = (e: Entry): string => linesOf(e).join('\n');
  const TS = (e: Entry): Date => new Date(e.first_ts);
  const out: string[] = [];
  // 判頭群 = 群代號唔以 CP 開頭（可用 --broker-groups A,B 覆寫）；盤別名由 `<dir>/aliases.json`（字串陣列，唔入 git）讀，冇檔＝唔登記別名（最壞情況）
  const bi = process.argv.indexOf('--broker-groups');
  const brokerSet = bi >= 0 ? new Set((process.argv[bi + 1] ?? '').split(',')) : null;
  const isBroker = (g: string): boolean => (brokerSet ? brokerSet.has(g) : !g.startsWith('CP') && g !== 'NONE');
  // 判頭群報工 label＝以 `_report_checkin` 結尾、又唔係 name_／unumber_ 開頭嗰個
  const brokerLabel = Object.keys(d.labels).find((k) => k.endsWith('_report_checkin') && !k.startsWith('name_') && !k.startsWith('unumber_')) ?? '';
  const aliases: string[] = await readFile(path.join(dir, 'aliases.json'), 'utf8').then((t) => JSON.parse(t) as string[]).catch(() => []);

  // 1. 名單
  const lists = Object.entries(d.lists);
  let hit = 0;
  let daysTotal = 0;
  let dateLines = 0;
  let glued = 0;
  let single = 0;
  let namesTotal = 0;
  let mismatchDays = 0;
  for (const [, e] of lists) {
    const txt = textOf(e);
    const known = new Set<string>(); // 以名單內所有 2–4 字 token 做「已知名集」（模擬 resolve 階段嘅 GuardMatchIndex 名集）
    for (const t of txt.normalize('NFKC').split(/[\s*]+/)) if (/^[一-鿿]{2,4}$/.test(t)) known.add(normNameVariant(t));
    const r = detectRosterList(txt, TS(e), { knownNames: known });
    if (!r) continue;
    hit += 1;
    daysTotal += r.days.length;
    dateLines += (txt.match(/^\s*\*?\d{1,2}\s*\/\s*\d{1,2}/gm) ?? []).length;
    for (const day of r.days) {
      namesTotal += day.names.length;
      glued += day.names.filter((n) => n.raw.length >= 5).length;
      single += day.names.filter((n) => n.raw.length === 1).length;
    }
    if (r.days.length !== (txt.match(/^\s*(?:\[[^\]]*\][^:]*:\s*)?\*?\s*[\dOo]{1,2}\s*[/／]\s*[\dOo]{1,2}/gm) ?? []).length) mismatchDays += 1;
  }
  const supers = Object.keys(d.superseded).length;
  out.push(`名單（保留 ${lists.length} 條；另 ${supers} 條被覆蓋＝子集）：偵測命中 ${hit}/${lists.length}；共 ${daysTotal} 日（日期行 ${dateLines}）；名 ${namesTotal}；剩餘 ≥5 字黏名 token ${glued}；1 字 token ${single}；日數同日期行數唔同嘅名單 ${mismatchDays}`);
  out.push(`  → 100 條名單（${lists.length}+${supers}）命中估算：${hit === lists.length ? supers + hit : hit}/${lists.length + supers}`);

  // 2. 其他 label
  const detect = (e: Entry, label: string): boolean => {
    const t = textOf(e);
    switch (label) {
      case 'roster_plan_dayprefix': return detectRosterPlan(t, TS(e)) !== null;
      case 'name_report_checkin_caption': { const k = classifyText(t); return k?.kind === 'name_caption' && k.action === 'checkin'; }
      case 'name_report_checkout_caption': { const k = classifyText(t); return k?.kind === 'name_caption' && k.action === 'checkout'; }
      case 'substitution_notice': return classifyText(t)?.kind === 'substitution';
      case 'leave_notice': return classifyText(t)?.kind === 'leave_notice';
      case 'attendance_summary_monthly': return classifyText(t)?.kind === 'attendance_summary';
      case 'question': return classifyText(t)?.kind === 'plain_question';
      case 'unumber_report_checkin':
      case brokerLabel: {
        const r = scoreMessage({ text: t, groupKind: isBroker(e.group) ? 'broker' : 'site', groupActive: true, ts: TS(e), siteAliases: aliases });
        return r.decision === 'candidate';
      }
      default: return false;
    }
  };
  for (const [label, keys] of Object.entries(d.labels)) {
    if (!Array.isArray(keys) || label.startsWith('roster_list')) continue;
    const es = keys.map(entry).filter((e): e is Entry => !!e);
    const ok = es.filter((e) => detect(e, label)).length;
    const note = ['site_only_caption', 'date_only_caption', 'bare_name', 'chatter'].includes(label) ? '（預期唔處理）' : '';
    out.push(`${label === brokerLabel ? 'broker_report_checkin' : label}：${ok}/${es.length}${note}`);
  }
  const brokerKeys = (d.labels[brokerLabel] as number[]) ?? [];
  // 判頭群報工：唔登記任何盤別名時（最壞情況）有幾多條仍然 candidate
  const noAlias = brokerKeys.map(entry).filter((e): e is Entry => !!e && scoreMessage({ text: textOf(e), groupKind: 'broker', groupActive: true, ts: TS(e) }).decision === 'candidate').length;
  out.push(`判頭群報工（唔登記盤別名、冇姓名名集）仍 candidate：${noAlias}/${brokerKeys.length}`);
  const timeRange = brokerKeys.map(entry).filter((e): e is Entry => !!e && TIME_RANGE_RE.test(textOf(e).normalize('NFKC'))).length;
  out.push(`判頭群報工含時間範圍：${timeRange}/${nums(brokerKeys.map(String))}`);
  console.log(out.join('\n'));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : 'error'); process.exit(1); });
