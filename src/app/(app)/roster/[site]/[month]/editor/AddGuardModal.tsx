// 更表編輯器「加保安員行」對話框。
// P3-5.1：由 RosterEditor.tsx 原樣搬出，行為零改變。
"use client";

import { Button } from "@/components/ui/Button";
import type { BrokerDto, GuardDto, ShiftTypeDto } from "./roster-types";

export function AddGuardModal({
  showAddGuard,
  setShowAddGuard,
  addGuardId,
  setAddGuardId,
  addShiftTypeId,
  setAddShiftTypeId,
  addBrokerId,
  setAddBrokerId,
  guardOptions,
  shiftTypeOptions,
  brokerSelectOptions,
  isBrokerSession,
  guardsById,
  brokersById,
  handleAddGuardRow,
}: {
  showAddGuard: boolean;
  setShowAddGuard: (v: boolean) => void;
  addGuardId: string;
  setAddGuardId: (v: string) => void;
  addShiftTypeId: string;
  setAddShiftTypeId: (v: string) => void;
  addBrokerId: string;
  setAddBrokerId: (v: string) => void;
  guardOptions: GuardDto[];
  shiftTypeOptions: ShiftTypeDto[];
  brokerSelectOptions: BrokerDto[];
  isBrokerSession: boolean;
  guardsById: Map<string, GuardDto>;
  brokersById: Map<string, BrokerDto>;
  handleAddGuardRow: () => void;
}) {
  return (
    <>
      {showAddGuard && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30" onClick={() => setShowAddGuard(false)}>
          <div className="bg-white rounded shadow-lg p-4 w-80 space-y-3" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-semibold text-zk-dark">加保安員行</h2>
            <label className="block text-xs text-zk-text-secondary">
              保安員
              <select
                aria-label="加保安員行:保安員"
                data-testid="add-guard-select-guard"
                className="mt-1 w-full border border-zk-input-border rounded px-2 py-1 text-sm"
                value={addGuardId}
                onChange={(e) => setAddGuardId(e.target.value)}
              >
                <option value="">請揀保安員</option>
                {guardOptions.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name_zh}
                    {g.staff_no ? `（${g.staff_no}）` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-zk-text-secondary">
              更別
              <select
                aria-label="加保安員行:更別"
                data-testid="add-guard-select-shift-type"
                className="mt-1 w-full border border-zk-input-border rounded px-2 py-1 text-sm"
                value={addShiftTypeId}
                onChange={(e) => setAddShiftTypeId(e.target.value)}
              >
                <option value="">請揀更別</option>
                {shiftTypeOptions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code} · {s.label}
                  </option>
                ))}
              </select>
            </label>
            {/* B1-5（WP-ATTRIB）：結算單位——預設跟揀咗嗰個保安員嘅
                default_broker_id（顯示喺 placeholder），可以人手改。
                驗收修正（Opus 5.5）：雞頭 session 唔顯示（自己永遠係自己，
                後端亦強制）。 */}
            {!isBrokerSession && (
            <label className="block text-xs text-zk-text-secondary">
              結算單位（唔揀就跟保安員預設）
              <select
                aria-label="加保安員行:結算單位"
                data-testid="add-guard-select-broker"
                className="mt-1 w-full border border-zk-input-border rounded px-2 py-1 text-sm"
                value={addBrokerId}
                onChange={(e) => setAddBrokerId(e.target.value)}
              >
                <option value="">（跟保安員預設：{addGuardId ? (guardsById.get(addGuardId)?.default_broker_id ? brokersById.get(guardsById.get(addGuardId)!.default_broker_id!)?.code : "冇預設") : "—"}）</option>
                {brokerSelectOptions.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code} · {b.name}
                  </option>
                ))}
              </select>
            </label>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm"
                type="button"

                onClick={() => {
                  setShowAddGuard(false);
                  setAddBrokerId("");
                }}
              >
                取消
              </Button>
              <Button variant="primary" size="sm"
                type="button"
                disabled={!addGuardId || !addShiftTypeId}

                onClick={handleAddGuardRow}
              >
                加入
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
