import { useEffect, useState } from 'react';
import { apiClient } from '@/api';
import type { AuditLog } from '@/api/types/audit';
import { toast } from 'sonner';
import { getErrorMessage } from "@shared/lib/http/errors";

export default function AuditLogs() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState('');
  const [resourceType, setResourceType] = useState('');

  const loadLogs = async () => {
    try {
      setLoading(true);
      const rows = await apiClient.getAuditLogs({
        limit: 100,
        action: action || undefined,
        resourceType: resourceType || undefined,
      });
      setLogs(rows);
    } catch (error: any) {
      toast.error(getErrorMessage(error, 'Failed to load audit logs.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadLogs();
  }, [action, resourceType]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Audit Logs</h1>
        <p className="text-sm text-gray-600 mt-1">Review operational and compliance actions for this shop.</p>
      </div>

      <section className="bg-white border border-gray-200 rounded-xl p-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Action</label>
            <input
              className="min-h-11 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="HUMAN_TAKEOVER"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Resource Type</label>
            <input
              className="min-h-11 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="CONVERSATION"
              value={resourceType}
              onChange={(e) => setResourceType(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <button onClick={loadLogs} className="min-h-11 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">Refresh logs</button>
          </div>
        </div>

        {loading ? (
          <p className="text-sm text-gray-500">Loading logs...</p>
        ) : logs.length === 0 ? (
          <p className="text-sm text-gray-500">Audit activity matching these filters will appear here.</p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-gray-200 text-gray-600">
                  <th className="py-2 pr-3">Time</th>
                  <th className="py-2 pr-3">Action</th>
                  <th className="py-2 pr-3">Resource</th>
                  <th className="py-2 pr-3">Resource ID</th>
                  <th className="py-2 pr-3">User</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-gray-100">
                    <td className="py-2 pr-3">{new Date(log.created_at).toLocaleString()}</td>
                    <td className="py-2 pr-3">{log.action}</td>
                    <td className="py-2 pr-3">{log.resource_type}</td>
                    <td className="py-2 pr-3 max-w-xs truncate" title={log.resource_id}>{log.resource_id}</td>
                    <td className="py-2 pr-3">{log.user?.full_name || log.user_id || 'N/A'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
