import ShortfallDashboard from "../../ShortfallDashboard";

export default function ShortfallPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">尚欠總覽</h1>
        <p className="text-sm text-gray-500">今日各盤出勤 vs 所需；待審批數；本月毛利進度。</p>
      </div>
      <ShortfallDashboard />
    </div>
  );
}
