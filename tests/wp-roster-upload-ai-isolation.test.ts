// WP-ROSTER-UPLOAD Phase A（§15.3）：AI 隔離——`roster_uploads`／
// `roster_upload_rows`（有 file_bytes／name_raw／tel_raw／staff_no_raw
// 呢類 PII）一定唔可以俾 AI 讀到。做法同 WP-MULTI／WP-STAFFNO 一致：
//   (1) `ai.*` schema 完全冇 `ai.roster_uploads`／`ai.roster_upload_rows`
//       view——結構性連張表都接觸唔到。
//   (2) `ai.audit_log` view WHERE 子句排除呢兩個 table_name（第二層
//       defense-in-depth，見
//       prisma/migrations/20260923000000_wp_roster_upload_a）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "pg";
import ExcelJS from "exceljs";
import { prisma } from "./lib/db";
import { clearAll } from "./lib/db";
import { seedWp2Fixture, sessionCookieForUser, type Wp2Fixture } from "./fixtures/wp2-fixture";
import { POST as createUpload } from "@/app/api/roster-uploads/route";
import { ensureAiRole, AI_RO_ROLE } from "../scripts/db/ensure-ai-role";

const TEST_AI_PASSWORD = "test-ai-ro-password-0123456789";

function aiConnectionString(): string {
  const mainUrl = new URL(process.env.DATABASE_URL!);
  const url = new URL(mainUrl.toString());
  url.username = AI_RO_ROLE;
  url.password = TEST_AI_PASSWORD;
  return url.toString();
}

function reqMultipart(url: string, cookie: string, buffer: Buffer, month: string): Request {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(buffer)], "test-roster.xlsx"));
  form.set("month", month);
  return new Request(url, { method: "POST", headers: { cookie }, body: form });
}

async function auditLogViewDef(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Array<{ viewdef: string }>>(`SELECT pg_get_viewdef('ai.audit_log'::regclass, true) AS viewdef`);
  return rows[0]?.viewdef ?? "";
}

describe("WP-ROSTER-UPLOAD：AI 隔離——結構性測試", () => {
  it("ai schema 完全冇 roster_uploads／roster_upload_rows 呢兩個 view（或者任何表）", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'ai'`,
    );
    const names = new Set(rows.map((r) => r.table_name));
    expect(names.has("roster_uploads")).toBe(false);
    expect(names.has("roster_upload_rows")).toBe(false);
    // Phase B-1（B1-2）：新表 roster_reconcile_decisions（`reason` 自由
    // 文字有 PII 風險）一樣結構性唔入 ai schema。
    expect(names.has("roster_reconcile_decisions")).toBe(false);
  });

  it("ai.audit_log view 定義文字有 WHERE table_name NOT IN 排除呢兩個 table_name＋Phase B-1 新表", async () => {
    const viewdef = await auditLogViewDef();
    expect(viewdef).toMatch(/table_name\s*(<>|!=|NOT IN)/i);
    expect(viewdef).toContain("roster_uploads");
    expect(viewdef).toContain("roster_upload_rows");
    expect(viewdef).toContain("roster_reconcile_decisions");
  });

  it("SELECT ai.roster_reconcile_decisions / public.roster_reconcile_decisions 都撞唔到（唔存在／permission denied）", async () => {
    await expect(prisma.$queryRawUnsafe("SELECT * FROM ai.roster_reconcile_decisions LIMIT 1")).rejects.toThrow(/does not exist/i);
  });

  it("ai.audit_log 仍然保留返 WP-PII/WP-MULTI 嗰 scrub_json blocked_keys／WHERE 排除（呢個 migration 冇手多多改壞）", async () => {
    const viewdef = await auditLogViewDef();
    expect(viewdef).toContain("hkid");
    expect(viewdef).toContain("bank_account_no");
    expect(viewdef).toContain("guard_phones");
    expect(viewdef).toContain("guard_emergency_contacts");
    expect(viewdef).toContain("guard_addresses");
  });
});

describe("WP-ROSTER-UPLOAD：AI 隔離——zoikan_ai_ro 真連線攻擊測試", () => {
  let aiClient: Client;
  let fx: Wp2Fixture;
  let ownerCookie: string;

  beforeAll(async () => {
    await ensureAiRole({ databaseUrl: process.env.DATABASE_URL!, password: TEST_AI_PASSWORD });
    aiClient = new Client({ connectionString: aiConnectionString() });
    await aiClient.connect();
  });

  afterAll(async () => {
    await aiClient.end();
  });

  it("SELECT ai.roster_uploads / ai.roster_upload_rows 全部 relation does not exist", async () => {
    await expect(aiClient.query("SELECT * FROM ai.roster_uploads LIMIT 1")).rejects.toThrow(/does not exist/i);
    await expect(aiClient.query("SELECT * FROM ai.roster_upload_rows LIMIT 1")).rejects.toThrow(/does not exist/i);
  });

  it("SELECT public.roster_uploads（試圖繞過 ai schema 直接 query public）一樣 permission denied", async () => {
    await expect(aiClient.query("SELECT * FROM public.roster_uploads LIMIT 1")).rejects.toThrow(/permission denied/i);
    await expect(aiClient.query("SELECT * FROM public.roster_upload_rows LIMIT 1")).rejects.toThrow(/permission denied/i);
  });

  it("Phase B-1：zoikan_ai_ro 真連線 SELECT ai.roster_reconcile_decisions／public.roster_reconcile_decisions 都攔到", async () => {
    await expect(aiClient.query("SELECT * FROM ai.roster_reconcile_decisions LIMIT 1")).rejects.toThrow(/does not exist/i);
    await expect(aiClient.query("SELECT * FROM public.roster_reconcile_decisions LIMIT 1")).rejects.toThrow(/permission denied/i);
  });

  it("上載一份帶姓名/電話/工號嘅更表之後，ai.audit_log SELECT * 一定睇唔到呢一行（table_name='roster_uploads' 已經俾 WHERE 排除）", async () => {
    await clearAll();
    fx = await seedWp2Fixture();
    ownerCookie = await sessionCookieForUser(fx.userIds["老闆"]);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("2026");
    ws.getCell("A2").value = fx.site.name;
    ws.getCell("F4").value = "Date";
    ws.getCell("G4").value = new Date(Date.UTC(2026, 7, 1));
    ws.getCell("A5").value = "Broker";
    ws.getCell("D5").value = "Staff No.";
    ws.getCell("E5").value = "Tel";
    ws.getCell("F5").value = "Name";
    ws.getCell("A6").value = "TEST-BA";
    ws.getCell("D6").value = "T-A01";
    ws.getCell("E6").value = "6100001";
    ws.getCell("F6").value = "測試安員甲——呢段文字唔應該俾AI讀到";
    ws.getCell("G6").value = "N";
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const res = await createUpload(reqMultipart("http://test.local/api/roster-uploads", ownerCookie, buf, "2026-08"));
    expect(res.status).toBe(201);
    const created = (await res.json()) as { upload: { id: string } };

    // public.audit_log 本身（用主連線）真係有呢一行——confirm 寫咗。
    const rawRow = await prisma.auditLog.findFirst({ where: { tableName: "roster_uploads", rowId: created.upload.id, action: "create" } });
    expect(rawRow).not.toBeNull();

    // ai.audit_log 一定搵唔到呢一行（連 roster_upload_rows 嘅 table_name 都一齊查埋，雖然 Phase A 冇逐行寫 audit）。
    const aiRows = await aiClient.query("SELECT * FROM ai.audit_log WHERE table_name IN ('roster_uploads', 'roster_upload_rows')");
    expect(aiRows.rows.length).toBe(0);

    // 保險：直接掃全部 ai.audit_log，逐行 JSON.stringify 埋一齊搵，都唔應該撞到呢段測試字面（防止未來有第二條寫入路徑漏咗 gate）。
    const allAiRows = await aiClient.query("SELECT before, after FROM ai.audit_log");
    const blob = JSON.stringify(allAiRows.rows);
    expect(blob).not.toContain("呢段文字唔應該俾AI讀到");
  });
});
