// P7.1：email 寄件。`SMTP_URL`（smtps://user:pass@host:465）冇設＝email 關閉，只寫 app_notifications。
// 寄件內容同通知 body 一樣：唔含 PII（盤名／數字／id／月份）；連結指向 APP_BASE_URL。
// 絕不 log SMTP_URL／收件人地址。
import nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}
export interface MailTransport {
  sendMail(msg: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

const DEFAULT_APP_BASE_URL = "https://zoikan.zeabur.app";
const DEFAULT_FROM = "在勤 <no-reply@zoikan.local>";

let override: MailTransport | null = null;
let cached: { url: string; transport: MailTransport } | null = null;

/** 測試用：注入假 transport（傳 null 還原）。 */
export function setMailTransportForTests(t: MailTransport | null): void {
  override = t;
}

export function isEmailEnabled(): boolean {
  return !!override || !!process.env.SMTP_URL?.trim();
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL?.trim() || DEFAULT_APP_BASE_URL).replace(/\/+$/, "");
}

function notifyFrom(): string {
  return process.env.NOTIFY_FROM?.trim() || DEFAULT_FROM;
}

function getTransport(): MailTransport | null {
  if (override) return override;
  const url = process.env.SMTP_URL?.trim();
  if (!url) return null;
  if (!cached || cached.url !== url) cached = { url, transport: nodemailer.createTransport(url) as unknown as MailTransport };
  return cached.transport;
}

/** 寄一封。冇設 SMTP_URL 回 "disabled"（唔拋錯）；寄失敗回 "failed"（只 log 錯誤類別，唔 log 地址）。 */
export async function sendMail(msg: MailMessage): Promise<"sent" | "disabled" | "failed"> {
  const transport = getTransport();
  if (!transport) {
    console.log("[notify] email disabled");
    return "disabled";
  }
  try {
    await transport.sendMail({ from: notifyFrom(), to: msg.to, subject: msg.subject, text: msg.text });
    return "sent";
  } catch (e) {
    console.error("[notify] email send failed:", e instanceof Error ? e.name : "error");
    return "failed";
  }
}
