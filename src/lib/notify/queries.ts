// P7.1：通知讀取／已讀（本人 audience：base_role 名或 user id）。
import { cache } from "react";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export interface NotificationRow {
  id: string;
  created_at: Date;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  read: boolean;
}

function audienceSql(userId: string, baseRole: string): Prisma.Sql {
  return Prisma.sql`(audience @> jsonb_build_array(${userId}::text) OR audience @> jsonb_build_array(${baseRole}::text))`;
}
function readSql(userId: string): Prisma.Sql {
  return Prisma.sql`(read_by @> jsonb_build_array(${userId}::text))`;
}

export async function listNotificationsFor(userId: string, baseRole: string, opts: { unreadOnly?: boolean; take?: number; skip?: number } = {}): Promise<{ rows: NotificationRow[]; total: number; unread: number }> {
  const take = Math.min(Math.max(opts.take ?? 20, 1), 100);
  const skip = Math.max(opts.skip ?? 0, 0);
  const aud = audienceSql(userId, baseRole);
  const read = readSql(userId);
  const filter = opts.unreadOnly ? Prisma.sql`${aud} AND NOT ${read}` : aud;
  const [rows, counts] = await Promise.all([
    prisma.$queryRaw<NotificationRow[]>(Prisma.sql`SELECT id, created_at, kind, title, body, href, ${read} AS read FROM app_notifications WHERE ${filter} ORDER BY created_at DESC, id ASC LIMIT ${take} OFFSET ${skip}`),
    prisma.$queryRaw<Array<{ total: number; unread: number }>>(Prisma.sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT ${read})::int AS unread FROM app_notifications WHERE ${aud}`),
  ]);
  const total = opts.unreadOnly ? (counts[0]?.unread ?? 0) : (counts[0]?.total ?? 0);
  return { rows, total, unread: counts[0]?.unread ?? 0 };
}

/** 未讀數（側欄「首頁」badge；同一 render 內 cache）。 */
export const countUnreadNotifications = cache(async function countUnreadNotifications(userId: string, baseRole: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`SELECT count(*)::int AS n FROM app_notifications WHERE ${audienceSql(userId, baseRole)} AND NOT ${readSql(userId)}`);
  return rows[0]?.n ?? 0;
});

/** 標記已讀（只限本人 audience 內嗰條）。"notfound"＝唔存在或唔喺 audience（唔洩露存在與否）。 */
export async function markNotificationRead(id: string, userId: string, baseRole: string): Promise<"ok" | "already" | "notfound"> {
  const n = await prisma.$executeRaw(
    Prisma.sql`UPDATE app_notifications SET read_by = read_by || jsonb_build_array(${userId}::text) WHERE id = ${id} AND ${audienceSql(userId, baseRole)} AND NOT ${readSql(userId)}`,
  );
  if (n > 0) return "ok";
  const exists = await prisma.$queryRaw<Array<{ c: number }>>(Prisma.sql`SELECT count(*)::int AS c FROM app_notifications WHERE id = ${id} AND ${audienceSql(userId, baseRole)}`);
  return (exists[0]?.c ?? 0) > 0 ? "already" : "notfound";
}

export async function markAllNotificationsRead(userId: string, baseRole: string): Promise<number> {
  return prisma.$executeRaw(Prisma.sql`UPDATE app_notifications SET read_by = read_by || jsonb_build_array(${userId}::text) WHERE ${audienceSql(userId, baseRole)} AND NOT ${readSql(userId)}`);
}
