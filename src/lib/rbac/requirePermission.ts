// requirePermission(req, module, action)：全部 API route／server action
// 一律經呢個 helper。拒絕（冇 session／冇 permission／硬性 deny）一律
// 回 403（未登入 401）並寫 audit_log（action=permission_denied），符合
// P1計劃§4 WP2 準則「拒絕回 403 並寫 audit」。
import type { SessionData } from "../auth/session";
import { getSessionFromRequest } from "../auth/session";
import { prisma } from "../db";
import { writeAudit } from "../audit";
import { Forbidden, Unauthorized } from "../api/errors";
import { getClientIp } from "../api/http";
import { moduleLabel, roleDisplay } from "./labels";
import { isHardDenied, type Action, type Module, type RoleName, ROLE_NAMES } from "./matrix";

export interface AuthedSession extends SessionData {
  baseRole: RoleName; // requireSession() 已經驗證過，呢度收窄返 TS type
}

/** module 可以係固定值，或者根據已驗證嘅 session 動態決定（例如「保安員」
 * module 雞頭/內部角色要用唔同 module——見 src/app/api/guards/route.ts）。 */
export type ModuleSelector = Module | ((session: AuthedSession) => Module);

function isKnownRole(name: string): name is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(name);
}

/**
 * 未登入／session 已過期／被 bump 咗 token_version（Opus 驗收殘留1：
 * logout／改密碼／改角色／改broker／void user 都會 bump）一律當未登入
 * （401）。呢度加咗一次 DB 查詢核對 token_version + 用戶現時狀態——
 * 「每請求核 version」嘅實現位置。
 */
export async function requireSession(req: Request): Promise<AuthedSession> {
  const session = await getSessionFromRequest(req);
  if (!session) throw Unauthorized();
  if (!isKnownRole(session.baseRole)) throw Forbidden("未知角色（base_role 唔喺五個出廠角色之內）——當最嚴處理");

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { tokenVersion: true, status: true },
  });
  if (!user || user.status !== "active" || user.tokenVersion !== session.tokenVersion) {
    throw Unauthorized(); // session 已被作廢（logout/改密碼/改角色/改broker/void）或用戶已停用
  }

  return session as AuthedSession;
}

/**
 * module/action 逐格檢查：
 *  1. 硬性 DENY 矩陣（matrix.ts）——「✗」，用 session.baseRole（唔係
 *     roleName，自訂角色改名逃唔過，見 Opus 驗收殘留2）查，即使
 *     role_permissions 有 granted=true 嘅行都照拒。
 *  2. role_permissions 表入面呢個角色（session.roleId，可以係自訂角色）
 *     嘅呢個 permission 係咪 granted=true——呢個先係「出廠✓ vs 出廠○但
 *     可開」實際生效嘅地方。
 */
export async function requirePermission(req: Request, moduleSelector: ModuleSelector, action: Action): Promise<AuthedSession> {
  const session = await requireSession(req);
  const mod = typeof moduleSelector === "function" ? moduleSelector(session) : moduleSelector;
  const ip = getClientIp(req);

  if (isHardDenied(session.baseRole, mod, action)) {
    await denyAndAudit(session, mod, action, ip, "hard_deny");
    throw Forbidden(`角色「${roleDisplay(session.roleName)}」（base_role=${roleDisplay(session.baseRole)}）硬性禁止 ${moduleLabel(mod)}:${action}`);
  }

  const granted = (await loadPermissionSet(session)).has(permissionKey(mod, action));

  if (!granted) {
    await denyAndAudit(session, mod, action, ip, "not_granted");
    throw Forbidden(`角色「${roleDisplay(session.roleName)}」未獲授權 ${moduleLabel(mod)}:${action}`);
  }

  return session;
}

async function denyAndAudit(session: AuthedSession, mod: Module, action: Action, ip: string | null, reason: string) {
  await writeAudit({
    actorUserId: session.userId,
    tableName: "permissions",
    rowId: `${mod}:${action}`,
    action: "permission_denied",
    after: { module: mod, action, role: session.roleName, baseRole: session.baseRole, reason },
    ip,
  });
}

/** P3-1.1：`Set` 入面嘅 key 格式 `module:action`。 */
export function permissionKey(mod: Module, action: Action): string {
  return `${mod}:${action}`;
}

// P3-1.1（附錄 b A-1）：per-request 權限 Set。`requireSession()` 每個 request
// 都會 unseal 出一個新嘅 session 物件，所以用 `WeakMap<session, Promise<Set>>`
// 記憶就等於「同一 request 內只查一次」；request 完結 session 物件被 GC，
// cache 跟住消失，唔會跨 request 留住舊權限（改角色權限即時生效）。
const permissionSetCache = new WeakMap<AuthedSession, Promise<ReadonlySet<string>>>();

/**
 * 一條 `role_permissions JOIN permissions` 查詢砌出該角色全部 granted=true 嘅
 * `module:action`。硬性 deny 唔喺 Set 入面處理（`hasPermission()` 另外用
 * `isHardDenied` 疊加），Set 淨係反映 role_permissions 表。
 */
export function loadPermissionSet(session: AuthedSession): Promise<ReadonlySet<string>> {
  let p = permissionSetCache.get(session);
  if (!p) {
    // 由 permissions 表出發 + `rolePermissions: { some }` 過濾＝單一 SQL（用 role_permissions 做 relation select
    // Prisma 會拆成 2 條查詢）。
    p = prisma.permission
      .findMany({
        where: { rolePermissions: { some: { roleId: session.roleId, granted: true } } },
        select: { module: true, action: true },
      })
      .then((rows) => new Set(rows.map((r) => permissionKey(r.module as Module, r.action as Action))));
    // 查詢失敗唔好永久記住 rejected promise
    p.catch(() => permissionSetCache.delete(session));
    permissionSetCache.set(session, p);
  }
  return p;
}

/** 同步版：已經攞到 Set 之後逐項判斷（硬性 deny 疊加）。 */
export function permissionSetHas(session: AuthedSession, set: ReadonlySet<string>, mod: Module, action: Action): boolean {
  if (isHardDenied(session.baseRole, mod, action)) return false;
  return set.has(permissionKey(mod, action));
}

/** 唔拋錯嘅版本——route 想「先查有冇權限先決定 scrub 定唔 scrub」用呢個。 */
export async function hasPermission(session: AuthedSession, mod: Module, action: Action): Promise<boolean> {
  if (isHardDenied(session.baseRole, mod, action)) return false;
  return (await loadPermissionSet(session)).has(permissionKey(mod, action));
}
