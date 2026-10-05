// WP-GUARD-OCR §29：單人證件包（source=single_ocr）輔助。
import type { ImportPackage, PackagePerson, PersonField } from "./package";

const SNAKE_TO_FIELD: Record<string, PersonField> = { name_zh: "nameZh", name_en: "nameEn", date_of_birth: "dateOfBirth", phone: "phone", address: "address" };

/**
 * apply 帶 decisions 完成後出分診題用：用戶已逐欄決定咗嘅欄當「已解決」——
 * confirm／replace／keep_pending＝status confirmed（值用決定嘅 value，冇就包內值）；skip＝missing。
 * 唔改原包、唔入 DB；淨係令分診唔重複問用戶啱啱確認過嘅欄。
 */
export function resolveDecidedFields(pkg: ImportPackage, decisions: Record<string, Record<string, unknown>>): ImportPackage {
  return {
    ...pkg,
    persons: pkg.persons.map((p): PackagePerson => {
      const d = decisions[p.key];
      if (!d) return p;
      const next = { ...p } as Record<string, unknown>;
      for (const [snake, dec0] of Object.entries(d)) {
        const f = SNAKE_TO_FIELD[snake];
        const dec = dec0 as { action: string; value?: string } | undefined;
        if (!f || !dec) continue;
        const cur = p[f] as { value: string | null; status: string };
        next[f] = dec.action === "skip" ? { ...cur, status: "missing" } : { ...cur, value: dec.value?.trim() || cur.value, status: "confirmed" };
      }
      return next as unknown as PackagePerson;
    }),
  };
}
