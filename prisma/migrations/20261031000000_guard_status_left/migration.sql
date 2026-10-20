-- S-batch-1021：保安員狀態分開「已離職」(left) 同「作廢」(inactive)。
-- 純加 enum 值，唔改現有資料（現有 inactive 行保持 inactive）。鐵則：ADD VALUE IF NOT EXISTS，唔用 gen_random_uuid()／RAISE。
ALTER TYPE "ActiveStatus" ADD VALUE IF NOT EXISTS 'left';
