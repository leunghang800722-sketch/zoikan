"use client";
// P3-5.3：Drawer 表單底部「儲存／取消」掣（brokers／sites／quotas／rate-cards／users／roles 一致）。
import { Button } from "./Button";

export function DrawerFormFooter({ saving, onCancel }: { saving: boolean; onCancel: () => void }) {
  return (
    <div className="flex gap-2 pt-2">
      <Button variant="primary" size="sm" type="submit" disabled={saving}>
        {saving ? "儲存緊…" : "儲存"}
      </Button>
      <Button variant="secondary" size="sm" type="button" onClick={onCancel}>
        取消
      </Button>
    </div>
  );
}
