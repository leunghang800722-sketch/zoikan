// P3-1.4（P3 計劃 §3.1 P8／附錄 b A-6／A-7／C-4）：三張上載表都有 bytea 欄
// （roster_uploads.file_bytes；postorder_uploads 四個 *_bytes；staff_list_uploads.file_bytes），
// Prisma 預設讀晒所有 scalar，只要一個 find* 漏 `select` 就連幾 MB 一齊讀入 Node heap。
// 凡係唔使解析原檔嘅讀取，一律用呢度嘅 META_SELECT（唔包任何 bytes 欄）。
// 需要原檔 bytes 嘅（reparse、guard-fix plan／apply、一鍵結算解析 Postorder 等）自己明確寫 select 或
// 列入 tests/p3-1-upload-meta-select.test.ts 白名單。
import type { Prisma } from "@prisma/client";

export const ROSTER_UPLOAD_META_SELECT = {
  id: true,
  month: true,
  siteId: true,
  siteNameRaw: true,
  uploaderUserId: true,
  uploadedAt: true,
  fileName: true,
  fileSha256: true,
  fileSize: true,
  version: true,
  status: true,
  parseSummary: true,
  parseError: true,
  layoutKey: true,
  voidedAt: true,
  voidedBy: true,
  voidReason: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
} as const satisfies Prisma.RosterUploadSelect;

export type RosterUploadMeta = Prisma.RosterUploadGetPayload<{ select: typeof ROSTER_UPLOAD_META_SELECT }>;

export const POSTORDER_UPLOAD_META_SELECT = {
  id: true,
  month: true,
  uploaderId: true,
  uploadedAt: true,
  fileName: true,
  fileSha256: true,
  fileSize: true,
  rowCount: true,
  status: true,
  parseSummary: true,
  createdAt: true,
} as const satisfies Prisma.PostorderUploadSelect;

export const STAFF_LIST_UPLOAD_META_SELECT = {
  id: true,
  uploaderId: true,
  uploadedAt: true,
  fileName: true,
  fileSha256: true,
  fileSize: true,
  rowCount: true,
  status: true,
  parseSummary: true,
  createdAt: true,
} as const satisfies Prisma.StaffListUploadSelect;
