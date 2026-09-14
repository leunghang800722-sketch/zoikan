// A5（Opus 整合驗收）：報表／列表頁預設顯示「當月」，但一個新月頭幾日
// （或者跳去未來月份）當月未必有任何排更記錄，畫面淨係得空表，用戶未必
// 知道係咪成個系統壞咗定係淨係呢個月冇嘢。呢個唯讀 endpoint 俾前端查
// 「最近一個有資料（shift_records）嘅月份」，等頁面可以喺當月零資料時
// 加一句提示＋一撳跳去嗰個月（見 src/components/ui/EmptyMonthNotice.tsx）。
//
// 權限跟「更表」（睇更表本身唔需要收客價/出街價，呢個 endpoint 淨係
// 回一個 YYYY-MM 字串，冇金錢欄）；雞頭 session 用
// `scopeShiftRecordWhere()` scope 做自己（雞頭見到嘅「最近有資料嘅月」
// 應該係自己有份嗰啲更，唔係全公司）。
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/rbac/requirePermission";
import { scopeShiftRecordWhere } from "@/lib/broker-isolation";
import { ok, withApiError } from "@/lib/api/http";
import { brandSafeResponse } from "@/lib/api/serialize";

export async function GET(req: Request) {
  return withApiError(async () => {
    const session = await requirePermission(req, "更表", "view");
    const latest = await prisma.shiftRecord.findFirst({
      where: scopeShiftRecordWhere(session, { recordType: "shift" }),
      orderBy: { workDate: "desc" },
      select: { workDate: true },
    });
    return ok(
      brandSafeResponse({
        latest_month: latest ? latest.workDate.toISOString().slice(0, 7) : null,
      }),
    );
  });
}
