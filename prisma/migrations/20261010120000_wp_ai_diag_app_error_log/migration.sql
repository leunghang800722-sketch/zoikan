-- WP-AI-DIAG（§37）：應用層錯誤日誌表。只新增、冇資料搬移；冪等（IF NOT EXISTS）。
-- 唔入 `ai` schema、唔開 view 俾 zoikan_ai_ro；唔存 body／header／IP／stack／query string。
CREATE TABLE IF NOT EXISTS "app_error_log" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "method" TEXT,
    "route" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "error_code" TEXT,
    "error_name" TEXT,
    "message_masked" TEXT NOT NULL,
    "actor_user_id" TEXT,
    CONSTRAINT "app_error_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "app_error_log_created_at_idx" ON "app_error_log"("created_at");
