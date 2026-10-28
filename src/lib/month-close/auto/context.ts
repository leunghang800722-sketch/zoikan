// WP-ONE-CLICK-AUTO（§31）：一個一鍵結算 run 嘅「自動處理」收集器——
// 夾住 journal（還原用）、audit（帶 run id）、report 計數、分診題草稿，
// 以及 Postorder 證據／雞頭名單嘅 lazy cache（一個 run 淨係解析一次）。
// `runId=null`（直接 call step 函數、唔經 run）時 journal 唔寫（冇 run 可以掛），其餘照做。
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { writeAudit, writeAuditTx, type AuditAction } from "@/lib/audit";
import { safeErrorSummary } from "@/lib/api/http";
import { loadPostorderEvidence, type BrokerLite, type PostorderEvidence } from "./postorder-evidence";
import { emptyAutoSummary, type AutoChangeKind, type AutoItemLine, type AutoSummary, type McQuestionDraft } from "./types";

const AUTO_LINES_MAX = 80;

export interface VarianceFinding {
  siteId: string;
  siteName: string;
  current: number;
  previous: number | null;
  /** 差額拆解：delta ＝ dup+ic+sub+broker+trunc+residual（每格只歸一個成分）。 */
  components?: { delta: number; dup: number; ic: number; sub: number; broker: number; trunc: number; residual: number };
  external: number;
  internalCash: number;
  deltaPct: number | null;
  explained: boolean;
  /** 一句解釋（冇 PII）。 */
  sentence: string;
  unexplained: number;
}

/** 寫改動時用嘅最小介面：AutoCollector（一鍵結算）同分診一撳確認（`SimpleWriter`）共用。 */
export interface ChangeWriter {
  source: string;
  actorUserId: string;
  ip: string | null;
  journal(input: { kind: AutoChangeKind; refTable?: string; refId?: string; summary: string; detail?: unknown; undoable?: boolean }): Promise<string | null>;
  audit(input: { tableName: string; rowId: string; action: AuditAction; before?: unknown; after?: unknown }): Promise<void>;
  /** 喺 transaction 內寫 audit（分診一撳確認：建卡＋補價＋audit 同生同死）。 */
  auditTx?(tx: Prisma.TransactionClient, input: { tableName: string; rowId: string; action: AuditAction; before?: unknown; after?: unknown }): Promise<void>;
}

/** 分診題確認寫入：audit 帶 `triage:<questionId>`，唔寫還原流水帳（用戶明確確認，唔屬 auto）。 */
export class SimpleWriter implements ChangeWriter {
  constructor(
    readonly source: string,
    readonly actorUserId: string,
    readonly ip: string | null,
  ) {}
  async journal(): Promise<string | null> {
    return null;
  }
  async audit(input: { tableName: string; rowId: string; action: AuditAction; before?: unknown; after?: unknown }): Promise<void> {
    const after = input.after && typeof input.after === "object" ? { ...(input.after as Record<string, unknown>), auto_source: this.source } : { auto_source: this.source };
    await writeAudit({ actorUserId: this.actorUserId, tableName: input.tableName, rowId: input.rowId, action: input.action, before: input.before, after, ip: this.ip });
  }
  async auditTx(tx: Prisma.TransactionClient, input: { tableName: string; rowId: string; action: AuditAction; before?: unknown; after?: unknown }): Promise<void> {
    const after = input.after && typeof input.after === "object" ? { ...(input.after as Record<string, unknown>), auto_source: this.source } : { auto_source: this.source };
    await writeAuditTx(tx, { actorUserId: this.actorUserId, tableName: input.tableName, rowId: input.rowId, action: input.action, before: input.before, after, ip: this.ip });
  }
}

export class AutoCollector implements ChangeWriter {
  readonly summary: AutoSummary = emptyAutoSummary();
  readonly autoLines: AutoItemLine[] = [];
  readonly questions: McQuestionDraft[] = [];
  readonly variance: VarianceFinding[] = [];
  readonly warnings: string[] = [];
  /** 呢個 run 自動建嘅新盤（site_new 分診用）。 */
  readonly newSiteIds = new Set<string>();
  /** HIST-3：歷史導入 run 設 true——自動建更種容許冇開始時間（時段欄唔係時間）同現有盤補新代號／新時段。正式月份恆 false。 */
  historical = false;
  /** HIST-3：歷史導入建出嚟嘅「冇開始時間」更種（只計出勤），報告逐盤列出（盤名＋代號，冇 PII）。 */
  readonly noTimeShiftTypes: Array<{ siteName: string; code: string }> = [];
  /** P8 M1：分診 session 擁有人（自動 run＝該月最新上載者／系統帳號）；冇設＝actorUserId（人手撳一鍵嗰個人）。 */
  triageOwnerUserId?: string;
  private postorderP: Promise<PostorderEvidence | null> | null = null;
  private brokersP: Promise<BrokerLite[]> | null = null;

  constructor(
    readonly runId: string | null,
    readonly month: Date,
    readonly actorUserId: string,
    readonly ip: string | null,
    /** 分診一撳確認重用呢個 collector 嘅 helper（建盤／更種）時，audit 來源標記改為 `triage:<題目 id>`。 */
    private readonly sourceLabel?: string,
  ) {}

  /** `rate_cards.source`／audit `auto_source` 嘅標記。 */
  get source(): string {
    return this.sourceLabel ?? `auto:one-click:${this.runId ?? "direct"}`;
  }

  line(kind: AutoItemLine["kind"], text: string): void {
    if (this.autoLines.length < AUTO_LINES_MAX) this.autoLines.push({ kind, text });
  }

  addQuestion(draft: McQuestionDraft): void {
    if (this.questions.some((q) => q.groupKey === draft.groupKey)) return;
    this.questions.push(draft);
  }

  async brokers(): Promise<BrokerLite[]> {
    if (!this.brokersP) {
      this.brokersP = prisma.broker
        .findMany({ select: { id: true, code: true, name: true, kind: true, aliases: true } })
        .then((rows) => rows.map((b) => ({ id: b.id, code: b.code, name: b.name, kind: b.kind, aliases: b.aliases })));
    }
    return this.brokersP;
  }

  /** 本月最新已解析 Postorder 嘅證據；冇上載／解析失敗就 null（冇都要行得通）。 */
  async postorder(): Promise<PostorderEvidence | null> {
    if (!this.postorderP) {
      this.postorderP = (async () => {
        const upload = await prisma.postorderUpload.findFirst({ where: { month: this.month, status: "parsed" }, orderBy: { uploadedAt: "desc" } });
        if (!upload) return null;
        try {
          return await loadPostorderEvidence(upload, this.month);
        } catch (e) {
          this.warnings.push(`Postorder 證據讀取失敗（${safeErrorSummary(e)}），自動定價／歸屬唔用 Postorder，靠歷史`);
          return null;
        }
      })();
    }
    return this.postorderP;
  }

  /** 寫一行還原流水帳。 */
  async journal(input: { kind: AutoChangeKind; refTable?: string; refId?: string; summary: string; detail?: unknown; undoable?: boolean }): Promise<string | null> {
    if (!this.runId) return null;
    const row = await prisma.monthCloseAutoChange.create({
      data: {
        runId: this.runId,
        kind: input.kind,
        refTable: input.refTable ?? null,
        refId: input.refId ?? null,
        summary: input.summary,
        detailJson: JSON.parse(JSON.stringify(input.detail ?? {})) as Prisma.InputJsonValue,
        undoable: input.undoable ?? true,
      },
    });
    return row.id;
  }

  /** 自動改動嘅 audit：`auto_source` 帶 run id（白名單 meta key，見 audit-dto.ts）。 */
  async audit(input: { tableName: string; rowId: string; action: AuditAction; before?: unknown; after?: unknown }): Promise<void> {
    const after = input.after && typeof input.after === "object" ? { ...(input.after as Record<string, unknown>), auto_source: this.source } : { auto_source: this.source };
    await writeAudit({ actorUserId: this.actorUserId, tableName: input.tableName, rowId: input.rowId, action: input.action, before: input.before, after, ip: this.ip });
  }
}
