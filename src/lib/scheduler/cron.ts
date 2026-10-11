// P7.1：5 欄 cron（分 時 日 月 星期）解析＋下次執行時間，全部按香港時間。
// 支援：`*`、`n`、`a-b`、`a,b,c`、`*/n`、`a-b/n`。星期 0 或 7＝星期日。
// 日同星期兩欄都有限制時按標準 cron 語意（任一個符合即可）。
import { HK_OFFSET_MS, hkParts } from "@/lib/dates";

interface Field {
  any: boolean;
  set: Set<number>;
}
export interface CronSpec {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

function parseField(src: string, min: number, max: number, name: string): Field {
  if (src === "*") return { any: true, set: new Set() };
  const set = new Set<number>();
  for (const part of src.split(",")) {
    const m = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`cron「${name}」欄唔啱：${part}`);
    const step = m[4] ? Number(m[4]) : 1;
    if (step < 1) throw new Error(`cron「${name}」欄 step 要 ≥ 1`);
    let lo: number;
    let hi: number;
    if (m[1]) {
      lo = min;
      hi = max;
    } else {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron「${name}」欄超出範圍 ${min}–${max}：${part}`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return { any: false, set };
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron 要 5 欄（分 時 日 月 星期）");
  const dow = parseField(parts[4]!, 0, 7, "星期");
  if (dow.set.has(7)) {
    dow.set.delete(7);
    dow.set.add(0);
  }
  return {
    minute: parseField(parts[0]!, 0, 59, "分"),
    hour: parseField(parts[1]!, 0, 23, "時"),
    dom: parseField(parts[2]!, 1, 31, "日"),
    month: parseField(parts[3]!, 1, 12, "月"),
    dow,
  };
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

const has = (f: Field, v: number) => f.any || f.set.has(v);

function dayMatches(spec: CronSpec, month: number, day: number, dow: number): boolean {
  if (!has(spec.month, month)) return false;
  const domOk = has(spec.dom, day);
  const dowOk = has(spec.dow, dow);
  if (!spec.dom.any && !spec.dow.any) return domOk || dowOk;
  return domOk && dowOk;
}

/** 嚴格晚過 `after` 嘅下一個符合時間（分鐘精度；搵唔到＝null，例如 2 月 31 號）。 */
export function nextRun(expr: string, after: Date): Date | null {
  const spec = parseCron(expr);
  // 以「香港牆鐘」做 UTC 欄位運算：wall = real + 8h
  const startWall = Math.floor((after.getTime() + HK_OFFSET_MS) / 60000) * 60000 + 60000;
  const startDay = Math.floor(startWall / 86400000) * 86400000;
  for (let i = 0; i < 366 * 5; i++) {
    const dayWall = startDay + i * 86400000;
    const d = new Date(dayWall);
    if (!dayMatches(spec, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay())) continue;
    for (let h = 0; h < 24; h++) {
      if (!has(spec.hour, h)) continue;
      for (let m = 0; m < 60; m++) {
        if (!has(spec.minute, m)) continue;
        const wall = dayWall + h * 3600000 + m * 60000;
        if (wall >= startWall) return new Date(wall - HK_OFFSET_MS);
      }
    }
  }
  return null;
}

export function describeHk(date: Date): string {
  const p = hkParts(date);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
