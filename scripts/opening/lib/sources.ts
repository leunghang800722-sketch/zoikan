// WP-AUG-OPENING：讀 data/2026-09/aug-payroll-trial 嘅 8 月試算輸出（只讀，
// 唔存呢個 repo）。呢個檔淨係做「解析」，唔碰 DB。
import { readFileSync, existsSync, readdirSync } from "fs";
import path from "path";

const TRIAL_ROOT = path.resolve(process.cwd(), "data/2026-09/aug-payroll-trial");
const ROSTERS_ROOT = path.resolve(process.cwd(), "data/2026-09/aug-rosters");
const FIXTURE_PATH = path.resolve(process.cwd(), "tests/fixtures/roster-parse-aug-2026.json");

function readJson<T>(rel: string): T {
  const p = path.join(TRIAL_ROOT, rel);
  if (!existsSync(p)) throw new Error(`搵唔到試算輸出檔：${p}`);
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

export interface PriceGroupEntry {
  E: Record<string, number>;
  F: Record<string, number>;
  n: number;
}

/** out/price_site_time_broker.json：101 組 `盤碼|時段|結算單位` → E/F/n */
export function loadPriceSiteTimeBroker(): Record<string, PriceGroupEntry> {
  return readJson<Record<string, PriceGroupEntry>>("out/price_site_time_broker.json");
}

export interface RevenueSiteEntry {
  site_id: string;
  site: string;
  shifts: number;
  revenue_per_shift: number;
  revenue_monthly: number;
  revenue_total: number;
}

/** out/revenue_site.json：盤碼 → 盤名／月費 */
export function loadRevenueSite(): RevenueSiteEntry[] {
  return readJson<RevenueSiteEntry[]>("out/revenue_site.json");
}

export interface PriceOverrides {
  multi_price_groups: string[];
  person: Record<string, { E: number; F: number; n: number; row: number }>;
  zone: Record<string, { E: number; F: number; n: number; row: number }>;
  zone_site_unit: Record<string, { F: number; row: number }>;
  ot: Record<string, { E: number; F: number; n: number; row: number; po_time: string }>;
  conflicts: unknown[];
}

export function loadPriceOverrides(): PriceOverrides {
  return readJson<PriceOverrides>("out/price_overrides.json");
}

export interface RosterRecord {
  file: string;
  site_raw: string;
  sub_site: string | null;
  code_raw: string;
  kind: string;
  time_slot: string | null;
  broker_code: string | null;
  staff_no: string | null;
  name: string | null;
  name_en: string | null;
  tel: string | null;
  rank: string | null;
  work_date: string;
  day: number;
}

/** out-rosters/records.jsonl：逐格記錄（有 PII，只可以喺 runtime 讀，唔准印落任何 log/summary） */
export function loadRosterRecords(): RosterRecord[] {
  const p = path.join(TRIAL_ROOT, "out-rosters/records.jsonl");
  if (!existsSync(p)) throw new Error(`搵唔到 ${p}`);
  const text = readFileSync(p, "utf8");
  const out: RosterRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    out.push(JSON.parse(t) as RosterRecord);
  }
  return out;
}

/** boss_answers.py：唔喺呢度 parse python，逐個用到嘅數字已經由人手核實
 * 抄落 build-aug-plan.ts 嘅常數表（有 file:line 註解指返 boss_answers.py），
 * 呢個函數只負責讀原始檔畀 build-aug-plan.ts 做「仲有冇改過」嘅 sanity check
 * （grep 幾個關鍵字，唔全面 parse）。 */
export function readBossAnswersRaw(): string {
  const p = path.join(TRIAL_ROOT, "scripts/boss_answers.py");
  if (!existsSync(p)) throw new Error(`搵唔到 ${p}`);
  return readFileSync(p, "utf8");
}

export interface FixtureFile {
  siteRaw: string;
  layoutKey: string;
  totalCellCount: number;
  shiftCount: number;
  codeBreakdown: Record<string, number>;
  codeKindBreakdown: Record<string, number>;
  dateRange: { min: string; max: string } | null;
  subSiteNames: string[];
}

export function loadRosterFixture(): { files: Record<string, FixtureFile> } {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { files: Record<string, FixtureFile> };
}

export function rosterFileNames(): string[] {
  if (!existsSync(ROSTERS_ROOT)) return [];
  return readdirSync(ROSTERS_ROOT).filter((f) => f.endsWith(".xlsx"));
}

export const AUG_ROSTERS_DIR = ROSTERS_ROOT;
