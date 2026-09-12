"use client";

export function Drawer({
  open,
  title,
  onClose,
  children,
  widthClassName = "w-[420px]",
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  widthClassName?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className={`relative z-50 flex h-full ${widthClassName} flex-col overflow-y-auto border-l border-gray-200 bg-white p-5 shadow-xl`}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="rounded px-2 py-1 text-sm text-gray-500 hover:bg-gray-100">
            關閉
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
