// OCR-6.2：伺服器端由系統內已存保安員查到嘅電話（獨立來源）只用嚟比對——phone_differs_from_list 時候選入面會有名單值，
// 回應前剔走（只留 OCR 讀到嘅值），避免經 OCR 端點洩漏已存電話。
import type { DocumentReadResult } from "./read";
import { normalizeField } from "./normalize";

export function stripListPhoneCandidates(r: DocumentReadResult): void {
  const f = r.fields.phone;
  if (!f || f.reason !== "phone_differs_from_list") return;
  const keep = normalizeField("phone", f.value).canon;
  f.candidates = f.candidates.filter((c) => normalizeField("phone", c).canon === keep);
  f.candidates_ranked = f.candidates_ranked.filter((c) => normalizeField("phone", c.value).canon === keep);
}
