// WP-GUARD-OCR §29：真 API 冒煙——**只准用合成證件圖**（scripts/ai/fixtures/make-synthetic-docs.py 生成，內容全部虛構）。
// 用法：npx tsx scripts/archive/ai/guard-ocr-smoke.ts <synthDir>
// 會真係扣費（每份文件 2 次視覺呼叫）；冇 DEEPSEEK_API_KEY 即中止。絕對唔准指去 data/ 或者任何真實證件。
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DeepSeekVisionClient, type VisionClient, type VisionRequest, type VisionResponse } from "../../../src/lib/guards/ocr/vision-client";
import { readDocument } from "../../../src/lib/guards/ocr/read";
import { normalizeField } from "../../../src/lib/guards/ocr/normalize";
import { parseModelJson } from "../../../src/lib/guards/ocr/read";
import { OCR_DOC_FIELDS, type OcrDocType, type OcrFieldKey } from "../../../src/lib/guards/ocr/config";

const dir = resolve(process.argv[2] ?? "");
if (!process.argv[2] || /\/data(\/|$)/.test(dir)) {
  console.error("請指定合成圖目錄（唔准 data/）");
  process.exit(2);
}
if (!process.env.DEEPSEEK_API_KEY) {
  console.error("冇 DEEPSEEK_API_KEY");
  process.exit(2);
}

const EXPECT: Record<string, Partial<Record<OcrFieldKey, string>>> = {
  id: { name_zh: "陳大文", name_en: "CHAN TAI MAN", hkid: "A1234563", dob: "1988-03-15", sex: "M" },
  "address-proof": { address: "新界火炭示範街99號虛構大廈15樓A室" },
  "onboarding-form": { phone: "61234567", address: "新界火炭示範街99號虛構大廈15樓A室" },
};
const SETS: { name: string; type: OcrDocType; expect: string }[] = [
  { name: "id-clean", type: "id_card", expect: "id" },
  { name: "id-small-rotated", type: "id_card", expect: "id" },
  { name: "id-blurred", type: "id_card", expect: "id" },
  { name: "id-injection", type: "id_card", expect: "id" },
  { name: "address-proof", type: "address_proof", expect: "address-proof" },
  { name: "onboarding-form", type: "onboarding_form", expect: "onboarding-form" },
];
const img = (n: string) => `data:image/jpeg;base64,${readFileSync(join(dir, n)).toString("base64")}`;

interface CallLog { kind: "A" | "B"; ms: number; p: number; c: number; raw: string }
const real = new DeepSeekVisionClient();
let log: CallLog[] = [];
const rec: VisionClient = {
  model: real.model,
  async complete(req: VisionRequest): Promise<VisionResponse> {
    const t = Date.now();
    const r = await real.complete(req);
    log.push({ kind: req.images.length === 1 ? "A" : "B", ms: Date.now() - t, p: r.promptTokens, c: r.completionTokens, raw: r.text });
    return r;
  },
};

async function main() {
  let totalP = 0, totalC = 0, fieldsTotal = 0, confirmedOk = 0, confirmedWrong = 0, review = 0, missing = 0, agree = 0, readsTotal = 0;
  for (const s of SETS) {
    log = [];
    const t0 = Date.now();
    const r = await readDocument(rec, s.type, { full: img(`${s.name}.jpg`), tiles: [1, 2, 3, 4].map((i) => img(`${s.name}.t${i}.jpg`)) });
    const ms = Date.now() - t0;
    const exp = EXPECT[s.expect]!;
    const lines: string[] = [];
    const fields = OCR_DOC_FIELDS[s.type];
    const pa = parseModelJson(log.find((l) => l.kind === "A")?.raw ?? "", fields);
    const pb = parseModelJson(log.find((l) => l.kind === "B")?.raw ?? "", fields);
    for (const f of fields) {
      const e = exp[f];
      if (!e) continue;
      const res = r.fields[f]!;
      fieldsTotal++;
      const canon = (v: string) => normalizeField(f, v).canon;
      const ok = res.status === "confirmed" && canon(res.value) === canon(e);
      const ra = pa?.[f], rb = pb?.[f];
      const aOk = !!ra && canon(ra) === canon(e), bOk = !!rb && canon(rb) === canon(e);
      readsTotal++;
      if (ra && rb && canon(ra) === canon(rb)) agree++;
      if (res.status === "confirmed") {
        if (ok) confirmedOk++;
        else confirmedWrong++;
      } else if (res.status === "review") review++;
      else missing++;
      lines.push(`${f}:${res.status}${res.status === "confirmed" ? (ok ? "(correct)" : "(WRONG)") : ""} A=${aOk ? "ok" : "x"} B=${bOk ? "ok" : "x"}`);
    }
    const p = log.reduce((a, l) => a + l.p, 0), c = log.reduce((a, l) => a + l.c, 0);
    totalP += p; totalC += c;
    console.log(`[${s.name}] ${ms}ms prompt=${p} completion=${c} (A ${log.find((l) => l.kind === "A")?.p}/${log.find((l) => l.kind === "A")?.c} ${log.find((l) => l.kind === "A")?.ms}ms; B ${log.find((l) => l.kind === "B")?.p}/${log.find((l) => l.kind === "B")?.c} ${log.find((l) => l.kind === "B")?.ms}ms) parse_ok=${r.parse_ok.a}/${r.parse_ok.b}`);
    console.log("   " + lines.join(" | "));
    if (s.name === "id-injection") {
      const inj = Object.values(r.fields).some((f) => f && (f.value.includes("王小明") || f.value.toUpperCase().includes("Z999999")));
      console.log(`   injection_leaked_into_fields=${inj}`);
    }
  }
  const inUsd = (totalP / 1e6) * 0.3, outUsd = (totalC / 1e6) * 1.2;
  console.log(`TOTAL prompt=${totalP} completion=${totalC} usd=${(inUsd + outUsd).toFixed(5)} hkd=${((inUsd + outUsd) * 7.8).toFixed(4)}`);
  console.log(`fields=${fieldsTotal} confirmed_correct=${confirmedOk} confirmed_wrong=${confirmedWrong} review=${review} missing=${missing} reads_agree=${agree}/${readsTotal}`);
}
main().catch((e) => {
  console.error("smoke failed:", e instanceof Error ? e.name : "error", (e as { status?: number }).status ?? "");
  process.exit(1);
});
