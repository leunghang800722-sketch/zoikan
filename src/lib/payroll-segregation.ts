// 硬性規則2（設計文件§5.1）：同一用戶不可同時係糧務批次嘅入數人同批核人。
// payout_batches 本身要 P3 先實作（P1-執行計劃.md §6「唔做」清單），但
// P1-WP2 依 dispatch 指示先寫呢個 helper＋test 鎖住，等 P3 個 API 一落地
// 就即刻有得用，唔使嗰陣先諗隔離邏輯。
import { ApiError } from "./api/errors";

export class SameActorPayoutError extends ApiError {
  constructor() {
    super(409, "same_actor_payout", "入數人同批核人唔可以係同一個用戶（設計文件§5.1硬性規則2）");
  }
}

export function assertDifferentActorApprover(enteredByUserId: string, approvedByUserId: string): void {
  if (enteredByUserId === approvedByUserId) {
    throw new SameActorPayoutError();
  }
}
