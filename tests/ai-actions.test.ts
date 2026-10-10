// WP-AI-DIAG（§37.4）：`extractActions()` / 白名單 / strict / href 規則 / 最多 5 張。純函數，冇 DB。
import { describe, it, expect } from "vitest";
import { extractActions, sanitizeActionCards, normalizeInternalHref, MAX_ACTION_CARDS } from "@/lib/ai/actions";

function block(cards: unknown): string {
  return "\n```actions\n" + JSON.stringify(cards) + "\n```";
}
const openPage = (href: string) => ({ type: "open_page", label: "去睇", basis: "依據", params: { href } });

describe("extractActions", () => {
  it("剝走 block、保留正文、解析出合法卡", () => {
    const r = extractActions("2026-09 仲有 18 題未答。" + block([{ type: "one_click_run", label: "重新跑 9 月", basis: "18 題未答", params: { month: "2026-09" } }]));
    expect(r.text).toBe("2026-09 仲有 18 題未答。");
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]!.type).toBe("one_click_run");
  });

  it("冇 block：文字原樣，冇卡", () => {
    const r = extractActions("普通回覆");
    expect(r).toEqual({ text: "普通回覆", actions: [] });
  });

  it("JSON 壞：block 照剝，冇卡", () => {
    const r = extractActions("文字\n```actions\n[{oops\n```");
    expect(r.text).toBe("文字");
    expect(r.actions).toEqual([]);
  });

  it("冇收尾 fence（被截斷）：由 fence 起剝到尾", () => {
    const r = extractActions('文字\n```actions\n[{"type":"open_page"');
    expect(r.text).toBe("文字");
    expect(r.actions).toEqual([]);
  });

  it("白名單以外 type 丟棄，其餘照留", () => {
    const r = extractActions(
      "x" +
        block([
          { type: "delete_everything", label: "壞", basis: "b", params: {} },
          { type: "roster_reparse", label: "重新解析", basis: "b", params: { upload_id: "abc-123" } },
        ]),
    );
    expect(r.actions.map((a) => a.type)).toEqual(["roster_reparse"]);
  });

  it("params 多餘 key（strict）→ 成張卡丟棄", () => {
    const r = extractActions("x" + block([{ type: "one_click_run", label: "l", basis: "b", params: { month: "2026-09", force: true } }]));
    expect(r.actions).toEqual([]);
  });

  it("params 缺欄／格式唔啱（month、id）→ 丟棄", () => {
    const bad = [
      { type: "one_click_run", label: "l", basis: "b", params: { month: "2026-13" } },
      { type: "backfill_from_postorder", label: "l", basis: "b", params: { month: "9月" } },
      { type: "roster_reparse", label: "l", basis: "b", params: { upload_id: "../../x" } },
      { type: "site_set_default_broker", label: "l", basis: "b", params: { site_id: "s1" } },
      { type: "triage_answer", label: "l", basis: "b", params: { question_id: "a/b", option: "mc_accept" } },
    ];
    expect(sanitizeActionCards(bad)).toEqual([]);
  });

  it("label ≤60、basis ≤200", () => {
    const ok = { type: "one_click_run", label: "字".repeat(60), basis: "字".repeat(200), params: { month: "2026-09" } };
    const tooLong = { ...ok, label: "字".repeat(61) };
    const tooLong2 = { ...ok, basis: "字".repeat(201) };
    expect(sanitizeActionCards([ok])).toHaveLength(1);
    expect(sanitizeActionCards([tooLong])).toHaveLength(0);
    expect(sanitizeActionCards([tooLong2])).toHaveLength(0);
  });

  it("最多 5 張", () => {
    const cards = Array.from({ length: 9 }, (_, i) => ({ type: "roster_reparse", label: `l${i}`, basis: "b", params: { upload_id: `u${i}` } }));
    expect(extractActions("x" + block(cards)).actions).toHaveLength(MAX_ACTION_CARDS);
    expect(sanitizeActionCards(cards)).toHaveLength(MAX_ACTION_CARDS);
  });

  it("triage_answer option 唔准 skip／唔喺現有選項清單", () => {
    const mk = (option: string) => ({ type: "triage_answer", label: "l", basis: "b", params: { question_id: "q-1", option } });
    expect(sanitizeActionCards([mk("skip"), mk("not_an_option"), mk("mc_pick"), mk("link")]).length).toBe(2);
  });

  it("triage_answer 合法形狀（candidate_id 可選）", () => {
    const r = extractActions(
      "x" +
        block([
          { type: "triage_answer", label: "答第 1 題", basis: "b", params: { question_id: "q-1", option: "mc_pick", candidate_id: "c-1" } },
          { type: "triage_answer", label: "答第 2 題", basis: "b", params: { question_id: "q-2", option: "mc_ack" } },
        ]),
    );
    expect(r.actions).toHaveLength(2);
  });
});

describe("open_page href 規則", () => {
  it.each([
    ["/month-close?month=2026-09", true],
    ["/triage", true],
    ["/roster-uploads/abc?x=1", true],
    ["/reports/payroll", true],
    ["/sites", true],
    ["//evil.com/month-close", false],
    ["https://evil.com/month-close", false],
    ["javascript:alert(1)", false],
    ["month-close", false],
    ["/api/month-close/one-click", false],
    ["/roles", false],
    ["/month-close/../api/users", false],
    ["/month-closeX", false],
    ["/month-close\\evil", false],
    ["/month-close?next=//evil.com", false],
    ["/month-close with space", false],
    ["", false],
  ])("%s → %s", (href, allowed) => {
    expect(normalizeInternalHref(href) !== null).toBe(allowed);
    expect(sanitizeActionCards([openPage(href)]).length).toBe(allowed ? 1 : 0);
  });
});
