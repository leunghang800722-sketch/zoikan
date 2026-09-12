export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const Unauthorized = () => new ApiError(401, "unauthorized", "未登入");
export const Forbidden = (msg = "冇權限") => new ApiError(403, "forbidden", msg);
export const NotFound = (msg = "搵唔到") => new ApiError(404, "not_found", msg);
export const BadRequest = (msg: string) => new ApiError(400, "bad_request", msg);
export const Conflict = (msg: string) => new ApiError(409, "conflict", msg);
// P1-執行計劃.md §4 WP2 準則明文寫「403＋audit」，所以呢度用 403（唔係
// 語意上更貼切嘅 423 Locked）——跟返 dispatch 指定嘅 status code。
export const Locked = (msg = "月份已鎖定") => new ApiError(403, "month_locked", msg);
// Opus 對抗式驗收第二輪 R3：冇 `roster_layout` 模板嘅盤唔准匯出（之前
// 靜靜哋跌落 `buildGenericRosterWorkbook()` 出一份冧格式／可能唔準嘅
// 空/殘缺檔——用戶完全唔知呢份係「冧牌」版本）。雞頭同內部角色一致
// 對待（呢個唔係權限問題，係資料完整性問題）。
export const NoRosterLayout = (msg = "呢個盤未有更表版面模板，唔可以匯出") => new ApiError(409, "no_roster_layout", msg);
