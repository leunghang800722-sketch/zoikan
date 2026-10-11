// P7.1：建立通知（同一 dedupe_key 只會出一條）＋按收件人設定寄 email。
// body／title 只准有盤名／數字／id／月份——`assertNoPii` 係最後防線（HKID／電郵／8 位電話型字串一律拒絕）。
import { prisma } from "@/lib/db";
import type { AppNotification } from "@prisma/client";
import { appBaseUrl, isEmailEnabled, sendMail } from "./mailer";

export interface CreateNotificationInput {
  kind: string;
  title: string;
  body: string;
  /** 站內路徑（以 / 開頭）。 */
  href?: string | null;
  /** base_role 名（老闆／主管／會計／雞頭／安員）或 user id。 */
  audience: string[];
  dedupeKey: string;
}

const PII_PATTERNS: RegExp[] = [/[A-Z]{1,2}\d{6}\(?[0-9A]\)?/, /[^\s@]+@[^\s@]+\.[^\s@]+/, /(?<!\d)\d{8}(?!\d)/];

export function assertNoPii(...texts: string[]): void {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  for (const raw of texts) {
    const t = raw.replace(UUID, "<id>");
    for (const re of PII_PATTERNS) {
      if (re.test(t)) throw new Error("通知內容疑似含個人資料（身份證／電郵／電話），拒絕建立");
    }
  }
}

export interface CreateNotificationResult {
  created: boolean;
  id: string | null;
  emailed: number;
}

export async function createNotification(input: CreateNotificationInput): Promise<CreateNotificationResult> {
  assertNoPii(input.title, input.body);
  if (input.href && !input.href.startsWith("/")) throw new Error("通知 href 要係站內路徑");
  const rows = await prisma.appNotification.createManyAndReturn({
    data: [{ kind: input.kind, title: input.title, body: input.body, href: input.href ?? null, audience: input.audience, dedupeKey: input.dedupeKey }],
    skipDuplicates: true,
  });
  const row = rows[0];
  if (!row) return { created: false, id: null, emailed: 0 };
  const emailed = await emailNotification(row);
  return { created: true, id: row.id, emailed };
}

/** 揾收件人（audience 內啟用中、有 notify_email、冇關呢類）並逐個寄。永不拋錯。 */
export async function emailNotification(n: AppNotification): Promise<number> {
  try {
    if (!isEmailEnabled()) {
      console.log("[notify] email disabled");
      return 0;
    }
    const audience = (Array.isArray(n.audience) ? n.audience : []).filter((x): x is string => typeof x === "string");
    if (audience.length === 0) return 0;
    const users = await prisma.user.findMany({
      where: { status: "active", notifyEmail: { not: null }, OR: [{ id: { in: audience } }, { role: { baseRole: { in: audience } } }] },
      select: { notifyEmail: true, notifyPrefs: true },
    });
    const link = n.href ? `\n\n${appBaseUrl()}${n.href}` : "";
    let sent = 0;
    for (const u of users) {
      const prefs = (u.notifyPrefs ?? {}) as Record<string, unknown>;
      if (prefs[n.kind] === false) continue;
      if (!u.notifyEmail) continue;
      const r = await sendMail({ to: u.notifyEmail, subject: `[在勤] ${n.title}`, text: `${n.body}${link}` });
      if (r === "sent") sent++;
    }
    if (sent > 0) await prisma.appNotification.update({ where: { id: n.id }, data: { emailSentAt: new Date() } });
    return sent;
  } catch (e) {
    console.error("[notify] email dispatch failed:", e instanceof Error ? e.name : "error");
    return 0;
  }
}
