// 頁面分類＋欄位抽取（純函數，輸入 OCR 行，無 IO）。
import { canonicalHkid, findHkidCandidates, hkidCheckDigitValid, repairHkid, repairHkidLeadingLetter } from './hkid';
import { cy, norm, readingOrder, toRows, type OcrLine, type OcrPage } from './ocr';

export type PageKind = 'id_card' | 'address_proof' | 'address_declaration' | 'application_form' | 'sia_permit' | 'bank' | 'other' | 'blank';
export type Level = 'high' | 'medium' | 'low';

export interface Field<T = string> {
  value: T;
  level: Level;
  conf: number; // 用到嗰幾行 OCR 信心嘅最小值
  page: number;
  evidence: string; // 原文行（只留 data/，唔入 git）
  note?: string;
}

// ---------------------------------------------------------------- 分類
const RE_ID_ANCHOR = /永久性?居民身份證|PERMANENT\s*IDENTITY|HONG\s*KONG\s*IDENTITY\s*CARD|香港身份證(?!號)|香港身分證(?!號)/i;
const RE_FORM = /職位申請表|EMPLOYMENT\s*APPLICATION/i;
const RE_PERMIT = /保安人員許可證|SECURITY\s*PERSONNEL\s*PERMIT/i;
const RE_BILL =
  /水務署|付款通知書|Water\s*Supplies|CLP|中電|Towngas|煤氣|電費|水費|電話費|賬單|帳單|月結單|結單|STATEMENT|PCCW|HKT|電訊|租約|租賃|TENANCY|住址證明|地址證明|PROOF\s*OF\s*ADDRESS|綜合戶口|信用卡|CREDIT\s*CARD|Account\s*Number|客戶編號|用戶編號|客戶號碼/i;
const RE_NOT_PROOF = /警務處|POLICE|SECURITY\s*AND\s*GUARDING|保安及護衛|港鐵|入境事務|IMMIGRATION|LICENSING/i;
const RE_BANK = /銀行|BANK|匯豐|HSBC|恒生|HANG\s*SENG|中銀|BOC|渣打|STANDARD\s*CHARTERED/i;

const ADDR_EN =
  /\b(FLAT|FLT|FT|ROOM|RM|UNIT|BLK|BLOCK|HOUSE|HSE|ESTATE|EST|STREET|ST|ROAD|RD|AVENUE|AVE|COURT|GARDEN|GARDENS|GDN|MANSION|MANSIONS|BUILDING|BLDG|TOWER|TWR|PHASE|KOWLOON|KLN|NEW\s*TERRITORIES|N\.?T\.?|HONG\s*KONG|TUEN\s*MUN|SHATIN|SHA\s*TIN|SHAM\s*SHUI\s*PO|TSUEN\s*WAN|KWAI\s*CHUNG|YUEN\s*LONG|TAI\s*PO|SHEUNG\s*SHUI|FANLING|TSEUNG\s*KWAN\s*O|TKO|TIN\s*SHUI\s*WAI|LANTAU|VILLAGE|VILLA|CENTRE|CENTER|PLAZA|TERRACE|LANE|PATH|DRIVE|CLOSE)\b/i;
// 中文：要有「數字＋號／室／樓／座」或邨／苑／村／屋邨／大廈／花園，或者係地區頭（香港／九龍／新界／離島）
const ADDR_ZH = /\d\s*[號室樓座舖]|[A-Za-z0-9]\s*[室座]|[邨苑村]|大廈|花園|廣場|^(香港|九龍|新界|離島)|[樓閣軒閣]$/;

export function isAddrish(t: string): boolean {
  const s = norm(t);
  if (/\$|HK\$|\d+\.\d{2}\b|[:：]\s*\S{6,}/.test(s) || s.length > 70) return false;
  return ADDR_EN.test(s) || ADDR_ZH.test(s) || /\d+\s*\/\s*F/i.test(s);
}

function pageText(lines: OcrLine[]): string {
  return lines.map((l) => norm(l.t)).join('\n');
}

export interface AddressBlock {
  lines: OcrLine[];
  name: OcrLine | null;
  score: number;
}

const NAME_EN_LINE = /^(?:(?:MR|MS|MRS|MISS|DR)\.?\s+)?[A-Z][A-Z .,'-]{3,40}$/;

function looksLikeName(t: string): boolean {
  const s = norm(t);
  if (/\d/.test(s) || isAddrish(s)) return false;
  if (/^[一-鿿]{2,5}(先生|小姐|女士)?$/.test(s)) return true;
  return NAME_EN_LINE.test(s.toUpperCase());
}

/** 搵頁面入面最似收件人地址嘅 block（可能有兩份：收件人同用水樓宇，取左邊／有名嗰份）。 */
export function findAddressBlock(lines: OcrLine[]): AddressBlock | null {
  const ordered = readingOrder(lines.filter((l) => l.t.trim().length > 0));
  const addr = ordered.filter((l) => isAddrish(l.t) && !/^\s*\$/.test(l.t));
  const used = new Set<OcrLine>();
  const chains: AddressBlock[] = [];
  for (const start of addr) {
    if (used.has(start)) continue;
    const chain = [start];
    used.add(start);
    let last = start;
    for (;;) {
      const next = ordered.find(
        (l) =>
          !used.has(l) &&
          cy(l) < cy(last) - 0.001 &&
          cy(last) - cy(l) < 0.03 &&
          Math.abs(l.x - last.x) < 0.05 &&
          isAddrish(l.t),
      );
      if (!next) break;
      chain.push(next);
      used.add(next);
      last = next;
    }
    // 鏈尾可跟最多 2 行普通文字（例：屋苑名／地區行）
    for (let k = 0; k < 2; k++) {
      const tail = ordered.find(
        (l) =>
          !used.has(l) &&
          cy(l) < cy(last) - 0.001 &&
          cy(last) - cy(l) < 0.03 &&
          Math.abs(l.x - last.x) < 0.05 &&
          /^[A-Za-z\u4e00-\u9fff0-9 .,'，\-()（）]{3,40}$/.test(l.t.trim()) &&
          !/\$|[:：]/.test(l.t),
      );
      if (!tail) break;
      chain.push(tail);
      used.add(tail);
      last = tail;
    }
    const strongZh = chain.length === 1 && ADDR_ZH.test(norm(start.t)) && /[邨苑樓]/.test(start.t) && /[室座號]/.test(start.t);
    if (chain.length < 2 && !strongZh) continue;
    // 前面一行似人名就當收件人
    const prev = ordered
      .filter((l) => cy(l) > cy(start) + 0.001 && cy(l) - cy(start) < 0.03 && Math.abs(l.x - start.x) < 0.05)
      .sort((a, b) => cy(a) - cy(b))[0];
    const name = prev && looksLikeName(prev.t) ? prev : null;
    if ((prev && RE_ORG.test(prev.t)) || RE_ORG.test(start.t)) continue; // 寄件機構地址
    chains.push({ lines: chain, name, score: chain.filter((l) => isAddrish(l.t)).length + (name ? 1.5 : 0) });
  }
  if (!chains.length) return null;
  chains.sort((a, b) => b.score - a.score || a.lines[0].x - b.lines[0].x || cy(b.lines[0]) - cy(a.lines[0]));
  return chains[0];
}

export interface Classified {
  page: number;
  kinds: PageKind[]; // 可多標籤（拼貼頁）
  primary: PageKind;
}

export function classifyPage(p: OcrPage): Classified {
  const lines = p.lines.filter((l) => l.t.trim());
  if (lines.length < 3) return { page: p.page, kinds: ['blank'], primary: 'blank' };
  const text = pageText(lines);
  const kinds: PageKind[] = [];
  const isForm = RE_FORM.test(text);
  const isPermit = RE_PERMIT.test(text);
  let isId = RE_ID_ANCHOR.test(text);
  if (!isId && !isForm && !isPermit) {
    // 冇 anchor：單獨一行身份證號＋出生日期標籤
    const hasDobLabel = /出生日期|DATE\s*OF\s*BIRTH|DATEOFBIRTH/i.test(text);
    const standalone = lines.some((l) => /^[A-Z]{1,2}\s?\d{6}\s*\(?[0-9A]?\)?\s*$/i.test(norm(l.t)) && findHkidCandidates(l.t).length > 0);
    isId = hasDobLabel && standalone;
  }
  if (isId) kinds.push('id_card');
  const block = isForm || RE_NOT_PROOF.test(text) ? null : findAddressBlock(lines);
  const bill = RE_BILL.test(text);
  const labeled = !isForm && !isId && !isPermit && !RE_NOT_PROOF.test(text) && !/個人資料（私隱）|486|聲明/.test(text) && /ADDRESS\s*(?:[（(]地址[）)]\s*[:：]|地址\s*[:：]?)\s*\S/i.test(text);
  if (!isForm && block && (bill || block.score >= 3 || block.name)) kinds.push('address_proof');
  else if (labeled) kinds.push('address_proof');
  else if (!isForm && bill && !isId && !isPermit && !RE_NOT_PROOF.test(text) && !(RE_BANK.test(text) && /卡|CARD/i.test(text))) kinds.push('address_proof');
  if (!isForm && /聲明/.test(text) && /現居|居於|鄭重聲明/.test(text) && !/個人資料（私隱）|486/.test(text)) kinds.push('address_declaration');
  if (isForm) kinds.push('application_form');
  if (isPermit) kinds.push('sia_permit');
  if (RE_BANK.test(text) && !kinds.includes('address_proof')) kinds.push('bank');
  if (!kinds.length) kinds.push('other');
  const order: PageKind[] = ['application_form', 'id_card', 'address_proof', 'address_declaration', 'sia_permit', 'bank', 'other'];
  const primary = order.find((k) => kinds.includes(k)) ?? 'other';
  return { page: p.page, kinds, primary };
}

// ---------------------------------------------------------------- 身份證頁
export interface IdCardResult {
  hkid: Field | null;
  hkidValid: boolean;
  nameZh: Field | null;
  nameEn: Field | null;
  dob: Field | null;
  sex: Field | null;
}

function lineConf(ls: OcrLine[]): number {
  return ls.length ? Math.min(...ls.map((l) => l.c)) : 0;
}

export function levelOf(conf: number, validated: boolean): Level {
  if (validated && conf >= 0.5) return 'high';
  if (validated || conf >= 0.5) return 'medium';
  return 'low';
}

const DATE_RE = /(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4})/g;

export function parseDates(text: string): string[] {
  const out: string[] = [];
  const s = norm(text);
  let m: RegExpExecArray | null;
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(s))) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && y >= 1920 && y <= 2012) {
      out.push(`${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }
  return out;
}

const NOT_NAME = /出生|簽發|簽股|日期|身份證|居民|香港|永久|證件|IDENTITY|CARD|BIRTH|ISSUE|HONG|KONG|PERMANENT/i;
const NOT_ZH_NAME = /^(中國|中华|中華|香港|人民共和國|共和國|中國人|男|女|日期|姓名|地址|申請職位|條件|審查|配偶|申請人|簽署|備註|附註|聲明)$/;

/** 身份證所在區域：以 anchor 為中心（卡面版面唔固定，名可以喺標題上面或下面）。 */
export function cardRegion(lines: OcrLine[]): OcrLine[] {
  const anchors = lines.filter((l) => RE_ID_ANCHOR.test(norm(l.t)));
  if (!anchors.length) return lines;
  const ax = Math.min(...anchors.map((l) => l.x));
  const ay = anchors.reduce((s, l) => s + cy(l), 0) / anchors.length;
  return lines.filter((l) => l.x >= ax - 0.3 && l.x <= ax + 0.55 && Math.abs(cy(l) - ay) <= 0.3);
}

function dist(a: OcrLine, b: OcrLine): number {
  return Math.hypot(a.x - b.x, (cy(a) - cy(b)) * 1.2);
}

export function extractIdCard(page: number, all: OcrLine[]): IdCardResult {
  const clean = all.filter((l) => l.t.trim());
  const anchors = clean.filter((l) => RE_ID_ANCHOR.test(norm(l.t)));
  const region = readingOrder(cardRegion(clean));
  const res: IdCardResult = { hkid: null, hkidValid: false, nameZh: null, nameEn: null, dob: null, sex: null };
  const anchor = anchors[0] ?? null;
  const near = (l: OcrLine) => (anchor ? dist(l, anchor) : 0);

  // hkid：優先 check digit 啱，其次離 anchor 近
  const cands: { c: string; line: OcrLine; valid: boolean; repaired: boolean }[] = [];
  for (const l of region) {
    for (const c of findHkidCandidates(l.t)) cands.push({ c, line: l, valid: hkidCheckDigitValid(c), repaired: false });
  }
  cands.sort((a, b) => Number(b.valid) - Number(a.valid) || near(a.line) - near(b.line));
  let pick = cands.find((x) => x.valid);
  if (!pick) {
    for (const l of region) {
      const r = repairHkidLeadingLetter(l.t);
      if (r) {
        pick = { c: r, line: l, valid: true, repaired: true };
        break;
      }
    }
  }
  if (!pick) {
    for (const x of cands) {
      const r = repairHkid(x.c);
      if (r) {
        pick = { c: r, line: x.line, valid: true, repaired: true };
        break;
      }
    }
  }
  if (!pick && cands[0]) pick = cands[0];
  if (pick) {
    res.hkidValid = pick.valid;
    res.hkid = {
      value: pick.c,
      level: pick.repaired ? 'low' : levelOf(pick.line.c, pick.valid),
      conf: pick.line.c,
      page,
      evidence: pick.line.t,
      note: pick.repaired ? 'repaired' : pick.valid ? undefined : 'check_digit_fail',
    };
  }

  // 英文名 "SURNAME, Given"＋續行（卡面名會斷行／斷 OCR 行）
  const surLine = region
    .filter((l) => /^[A-Z][A-Za-z'-]+(?:\s[A-Za-z'-]+)?\s*[,，]\s*[A-Za-z]?[A-Za-z' -]*$/.test(norm(l.t)) && !NOT_NAME.test(l.t))
    .sort((a, b) => near(a) - near(b))[0];
  if (surLine) {
    const parts = [norm(surLine.t)];
    const used = [surLine];
    const extra = region
      .filter(
        (l) =>
          l !== surLine &&
          /^[A-Za-z][A-Za-z' -]{1,30}$/.test(norm(l.t)) &&
          !NOT_NAME.test(l.t) &&
          ((Math.abs(cy(l) - cy(surLine)) < 0.012 && l.x > surLine.x) ||
            (cy(l) < cy(surLine) && cy(surLine) - cy(l) < 0.05 && Math.abs(l.x - surLine.x) < 0.06)),
      )
      .sort((a, b) => cy(b) - cy(a) || a.x - b.x)
      .slice(0, 2);
    for (const e of extra) {
      parts.push(norm(e.t));
      used.push(e);
    }
    const joined = parts.join(' ').replace(/\s*[,，]\s*/, ', ').replace(/\s+/g, ' ');
    const m = /^(.+?),\s*(.*)$/.exec(joined);
    if (m) {
      res.nameEn = {
        value: `${m[1].toUpperCase()} ${m[2]}`.trim(),
        level: levelOf(Math.min(...used.map((u) => u.c)), false),
        conf: Math.min(...used.map((u) => u.c)),
        page,
        evidence: used.map((u) => u.t).join(' | '),
      };
    }
  }

  // 中文名：純 CJK 2–5 字，離英文名行（或 anchor）最近
  const zhLines = region.filter((l) => {
    const s = norm(l.t).replace(/[()（）\s]/g, '');
    return /^[\u4e00-\u9fff]{2,5}$/.test(s) && !NOT_NAME.test(s) && !NOT_ZH_NAME.test(s);
  });
  const hkidLine = pick?.line ?? null;
  const ref = surLine ?? anchor ?? hkidLine;
  // 冇 anchor 嗰陣成頁都係 region，只接受貼近英文名／hkid 嘅行，避免攞到頁面上其他中文詞
  const zhPool = anchor ? zhLines : zhLines.filter((l) => !!ref && dist(l, ref) < 0.2);
  const zh = ref ? [...zhPool].sort((a, b) => dist(a, ref) - dist(b, ref))[0] : undefined;
  if (zh) {
    res.nameZh = { value: norm(zh.t).replace(/[()（）\s]/g, ''), level: levelOf(zh.c, false), conf: zh.c, page, evidence: zh.t };
  }

  // 出生日期：標籤附近最近嘅 4 位年日期；否則區內唯一 4 位年日期
  const label = region.find((l) => /出生日期|DATE\s*OF\s*BIRTH|DATEOF|BIRTH/i.test(norm(l.t)));
  let dobLine: OcrLine | undefined;
  let dobVal: string | undefined;
  if (label) {
    const nearL = region
      .filter((l) => !/簽發|ISSUE|SSUE|DALE\s*OF/i.test(l.t) && Math.abs(cy(l) - cy(label)) < 0.06)
      .sort((a, b) => dist(a, label) - dist(b, label));
    for (const l of nearL) {
      const d = parseDates(l.t);
      if (d.length) {
        dobLine = l;
        dobVal = d[0];
        break;
      }
    }
  }
  if (!dobVal) {
    const all4 = region.flatMap((l) => parseDates(l.t).map((d) => ({ d, l })));
    if (all4.length === 1) {
      dobLine = all4[0].l;
      dobVal = all4[0].d;
    }
  }
  if (dobVal && dobLine) {
    res.dob = { value: dobVal, level: levelOf(dobLine.c, false), conf: dobLine.c, page, evidence: dobLine.t };
  }
  // 性別：「男M／女F」，同日期同行或獨立一行
  const sexLine = region
    .filter((l) => /(^|\s|\d)(男|女)\s*[MF]?\s*$/.test(norm(l.t)) || /^\s*[MF]\s*$/.test(norm(l.t)))
    .sort((a, b) => (dobLine ? dist(a, dobLine) - dist(b, dobLine) : near(a) - near(b)))[0];
  if (sexLine) {
    const t = norm(sexLine.t);
    const v = /男/.test(t) ? 'M' : /女/.test(t) ? 'F' : /M\s*$/.test(t) ? 'M' : 'F';
    res.sex = { value: v, level: levelOf(sexLine.c, false), conf: sexLine.c, page, evidence: sexLine.t };
  }
  return res;
}

// ---------------------------------------------------------------- 住址證明
export interface AddressResult {
  address: Field | null;
  recipient: string | null;
}

const RE_LABELED_ADDR = /ADDRESS\s*(?:[（(]地址[）)]\s*[:：]|地址\s*[:：]?)\s*(.+)$/i;
const RE_ORG = /LIMITED|LTD|DEPARTMENT|REVENUE|局|公司|MOBILE|BANK|銀行|COMPANY|HOLDINGS/i;

export function extractAddress(page: number, lines: OcrLine[]): AddressResult {
  const block = findAddressBlock(lines);
  if (!block) {
    // 有「Address（地址）：」標籤嘅信件
    const ordered = readingOrder(lines.filter((l) => l.t.trim()));
    const i = ordered.findIndex((l) => RE_LABELED_ADDR.test(norm(l.t)));
    if (i >= 0) {
      const first = ordered[i];
      const rest = RE_LABELED_ADDR.exec(norm(first.t))![1];
      const parts = [rest];
      const used = [first];
      for (const l of ordered.slice(i + 1, i + 4)) {
        if (cy(first) - cy(l) < 0.06 && Math.abs(l.x - first.x) < 0.3 && isAddrish(l.t)) {
          parts.push(norm(l.t));
          used.push(l);
        }
      }
      const to = ordered.find((l, j) => j < i && /^(To|致)/i.test(norm(l.t)) && cy(l) - cy(first) < 0.05);
      const rec = to ? norm(to.t).replace(/^(To|致)\s*[（(]?致?[）)]?\s*[:：]?\s*/i, '') : null;
      const conf = lineConf(used);
      return {
        address: { value: parts.join(', '), level: 'low', conf, page, evidence: used.map((u) => u.t).join(' | '), note: 'labeled' },
        recipient: rec || null,
      };
    }
    return { address: null, recipient: null };
  }
  const conf = lineConf(block.lines);
  const value = block.lines.map((l) => norm(l.t).replace(/\s+([,，])/g, '$1')).join(', ');
  return {
    address: {
      value,
      level: block.lines.length >= 3 ? levelOf(conf, false) : 'low',
      conf,
      page,
      evidence: block.lines.map((l) => l.t).join(' | '),
    },
    recipient: block.name ? norm(block.name.t) : null,
  };
}

// ---------------------------------------------------------------- 申請表
export interface FormResult {
  phone: Field | null;
  hkid: Field | null;
  address: Field | null;
  nameZh: Field | null;
  nameEn: Field | null;
}

/** 8 位香港電話（容許空格／連字號）。 */
export function findHkPhone(s: string): string | null {
  const t = norm(s);
  const m = /(?<!\d)([2-9]\d{3})[\s-]?(\d{4})(?!\d)/.exec(t);
  return m ? `${m[1]}${m[2]}` : null;
}

/** 手寫電話 OCR 常見字母混淆 → 數字。 */
export function unConfuse(s: string): string {
  return s.replace(/[Oo]/g, '0').replace(/[Il|/]/g, '1').replace(/[gq]/g, '9').replace(/[Ss]/g, '5').replace(/[B&]/g, '8').replace(/Z/g, '2');
}

/** 容錯版：手寫電話段落（可含 | / g 等混淆字元）→ 8 位號碼，唔得就 null。 */
export function findPhoneFuzzy(seg: string): string | null {
  const strict = findHkPhone(seg);
  if (strict) return strict;
  const m = /[0-9OoIl|/gqSsB&Z\s-]{7,16}/.exec(norm(seg).replace(/^[:：\s]+/, ''));
  if (!m) return null;
  const digits = unConfuse(m[0]).replace(/[\s-]/g, '');
  return /^[2-9]\d{7}$/.test(digits) ? digits : null;
}

export function extractForm(page: number, lines: OcrLine[]): FormResult {
  const rows = toRows(lines.filter((l) => l.t.trim()));
  const out: FormResult = { phone: null, hkid: null, address: null, nameZh: null, nameEn: null };
  if (!/手提電話|提電話/.test(lines.map((l) => l.t).join(' '))) {
    // 另一款範本：「聯絡電話 Phone No.」下一行填
    const lab = lines.find((l) => /聯絡電話|Phone\s*No/i.test(l.t));
    if (lab) {
      const cand = lines
        .filter((l) => l !== lab && cy(l) < cy(lab) + 0.005 && cy(l) > cy(lab) - 0.05 && l.x >= lab.x - 0.02 && l.x < lab.x + 0.3)
        .map((l) => ({ l, ph: findHkPhone(unConfuse(l.t)) }))
        .find((x) => x.ph);
      if (cand?.ph) out.phone = { value: cand.ph, level: 'low', conf: cand.l.c, page, evidence: cand.l.t, note: 'template_b' };
    }
  }
  for (const r of rows) {
    const text = norm(r.text);
    const conf = lineConf(r.lines);
    if (!out.phone) {
      const mi = /(?:手|车|半)?提電話|MOBILE/i.exec(text);
      if (mi) {
        const after = text.slice(mi.index + mi[0].length);
        const stop = after.search(/緊急|聯絡|住宅/);
        const seg = stop >= 0 ? after.slice(0, stop) : after;
        const ph = findPhoneFuzzy(seg);
        if (ph) out.phone = { value: ph, level: findHkPhone(seg) ? levelOf(conf, false) : 'low', conf, page, evidence: r.text, note: findHkPhone(seg) ? undefined : 'fuzzy' };
      }
    }
    if (!out.hkid && /身份證號碼|身分證號碼|HKID/i.test(text)) {
      const cs = findHkidCandidates(text);
      const c = cs.find(hkidCheckDigitValid) ?? cs[0];
      if (c) out.hkid = { value: c, level: levelOf(conf, hkidCheckDigitValid(c)), conf, page, evidence: r.text };
    }
    if (!out.address && /^住址[:：]?/.test(text.replace(/^[^住]*(?=住址)/, ''))) {
      const v = text.replace(/^.*?住址[:：]?/, '').trim();
      if (v.length >= 4) out.address = { value: v, level: 'low', conf, page, evidence: r.text };
    }
    if (!out.nameZh) {
      const m = /中文姓名[:：]\s*([一-鿿]{2,5})/.exec(text);
      if (m) out.nameZh = { value: m[1], level: levelOf(conf, false), conf, page, evidence: r.text };
    }
    if (!out.nameEn) {
      const m = /English\s*Name\s*[:：]?\s*([A-Za-z][A-Za-z ,'-]{2,40})/i.exec(text);
      if (m) out.nameEn = { value: m[1].trim().toUpperCase(), level: levelOf(conf, false), conf, page, evidence: r.text };
    }
  }
  if (!out.phone) {
    for (const r of rows) {
      const text = norm(r.text);
      const mi = /住宅電話/.exec(text);
      if (!mi) continue;
      const seg = text.slice(mi.index + mi[0].length).split(/手|提電話|MOBILE/i)[0];
      const ph = findPhoneFuzzy(seg);
      if (ph) {
        out.phone = { value: ph, level: 'low', conf: lineConf(r.lines), page, evidence: r.text, note: 'home_field' };
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 許可證（互證）
export function extractPermit(page: number, lines: OcrLine[]): { hkid: Field | null } {
  const rows = readingOrder(lines);
  for (const l of rows) {
    const cs = findHkidCandidates(l.t).filter(hkidCheckDigitValid);
    if (cs.length && !/PERMIT\s*NO|許可證編號/i.test(l.t)) {
      return { hkid: { value: cs[0], level: 'medium', conf: l.c, page, evidence: l.t } };
    }
  }
  return { hkid: null };
}

export { canonicalHkid };
