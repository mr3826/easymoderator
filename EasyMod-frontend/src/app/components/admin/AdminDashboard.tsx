import { useEffect, useState } from 'react';
import { adminApi, type AdminDashboard as Dash } from '@/api/domains/admin';

function Stat({ label, value }: { label: string; value: number | string | null }) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{value ?? '—'}</div>
    </div>
  );
}

export default function AdminDashboard() {
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    adminApi.getDashboard().then(setD).catch((e) => setErr(String(e?.message || e)));
  }, []);

  if (err) return <div className="text-red-600">Failed to load: {err}</div>;
  if (!d) return <div className="text-gray-500">Loading…</div>;

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold text-gray-900">SaaS Health</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Total shops" value={d.shops.total} />
        <Stat label="Active" value={d.shops.active} />
        <Stat label="Suspended" value={d.shops.suspended} />
        <Stat label="Messages today" value={d.today.messages} />
        <Stat label="AI replies today" value={d.today.aiAutoReplies} />
        <Stat label="Orders today" value={d.today.orders} />
        <Stat label="Est. AI cost (Phase 2)" value={d.today.estimatedAiCost} />
      </div>
      <p className="text-xs text-gray-400">
        “—” metrics arrive in Phase 2. Generated {new Date(d.generatedAt).toLocaleTimeString()}.
      </p>
    </div>
  );
}
