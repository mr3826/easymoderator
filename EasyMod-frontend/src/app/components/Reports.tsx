import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { TrendingUp, TrendingDown, ShoppingCart, MessageSquare, Package, Download, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { apiClient } from '@/api';
import { listMetaChannels, type MetaChannel } from '@/api/domains/meta-channels';
import type { DashboardMetrics } from '@/api/types/dashboard';

interface ChannelPerformance {
  channel: string;
  messages: number;
}

interface KnowledgeGapRow {
  id: number;
  question: string;
  platform: string;
  language: string;
  created_at: string;
}

type Period = 7 | 30 | 90;

// ── helpers ──────────────────────────────────────────────────────────────────

function downloadCsv(filename: string, rows: string[][]): void {
  const content = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function SkeletonCard() {
  return (
    <div className="bg-white rounded-xl p-6 border border-gray-200 animate-pulse">
      <div className="flex items-center justify-between mb-4">
        <div className="w-8 h-8 bg-gray-200 rounded-lg" />
        <div className="w-10 h-4 bg-gray-100 rounded" />
      </div>
      <div className="w-20 h-7 bg-gray-200 rounded mb-2" />
      <div className="w-32 h-4 bg-gray-100 rounded" />
    </div>
  );
}

function ChangeBadge({ value }: { value: number }) {
  if (value === 0) return <span className="text-gray-400 text-xs font-medium">—</span>;
  const positive = value > 0;
  const Icon = positive ? TrendingUp : TrendingDown;
  return (
    <span className={`inline-flex items-center gap-0.5 text-xs font-semibold ${positive ? 'text-green-600' : 'text-red-500'}`}>
      <Icon className="w-3 h-3" />
      {positive ? '+' : ''}{value.toFixed(1)}%
    </span>
  );
}

// ── component ─────────────────────────────────────────────────────────────────

export default function Reports() {
  const { t }    = useTranslation();
  const navigate = useNavigate();

  const [period, setPeriod]             = useState<Period>(30);
  const [channelPerformance, setChannelPerformance] = useState<ChannelPerformance[]>([]);
  const [dashboardMetrics, setDashboardMetrics]     = useState<DashboardMetrics | null>(null);
  const [knowledgeGaps, setKnowledgeGaps]           = useState<KnowledgeGapRow[]>([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState<string | null>(null);

  const loadData = useCallback(async (p: Period) => {
    try {
      setLoading(true);
      setError(null);

      const [channels, metrics, gaps] = await Promise.all([
        listMetaChannels(),
        apiClient.getDashboardMetrics(p),
        apiClient.getKnowledgeGaps(50),
      ]);

      setDashboardMetrics(metrics);
      setKnowledgeGaps(gaps);
      setChannelPerformance(
        channels.map((ch: MetaChannel) => ({
          channel:  ch.displayName || ch.platform || 'Unknown',
          messages: 0,
        }))
      );
    } catch (err) {
      console.error('Failed to load report data:', err);
      setError(t('reports.errors.loadChannelData'));
      toast.error(t('reports.errors.loadReportData'));
      setChannelPerformance([]);
      setDashboardMetrics(null);
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { loadData(period); }, [period, loadData]);

  const weeklyChange = dashboardMetrics?.metrics.weeklyChange ?? 0;
  const ai           = dashboardMetrics?.analytics;

  // ── CSV helpers ─────────────────────────────────────────────────────────────

  function exportChannelCsv() {
    downloadCsv('channel-performance.csv', [
      ['Channel', 'Messages'],
      ...channelPerformance.map(c => [c.channel, String(c.messages)]),
    ]);
  }

  function exportGapsCsv() {
    downloadCsv('knowledge-gaps.csv', [
      ['Question', 'Platform', 'Language', 'Date'],
      ...knowledgeGaps.map(g => [g.question, g.platform, g.language, new Date(g.created_at).toLocaleDateString()]),
    ]);
  }

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 md:p-8">

      {/* Header + period tabs */}
      <div className="flex items-start justify-between mb-6 md:mb-8 flex-wrap gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900">{t('reports.title')}</h1>
          <p className="text-gray-600 mt-1 text-sm md:text-base">{t('reports.subtitle')}</p>
        </div>
        <div className="flex items-center bg-gray-100 rounded-lg p-1 gap-1">
          {([7, 30, 90] as Period[]).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`min-h-11 px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
                period === p
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {p}d
            </button>
          ))}
        </div>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
        {loading ? (
          <>
            <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
          </>
        ) : dashboardMetrics ? (
          <>
            {/* Total Messages */}
            <div className="bg-white rounded-xl p-6 border border-gray-200">
              <div className="flex items-center justify-between mb-4">
                <MessageSquare className="w-8 h-8 text-blue-600" />
              </div>
              <h3 className="text-2xl font-bold text-gray-900">
                {dashboardMetrics.metrics.totalMessages.toLocaleString()}
              </h3>
              <p className="text-gray-600 text-sm mt-1">{t('reports.metrics.totalMessages')}</p>
            </div>

            {/* Active Products */}
            <div className="bg-white rounded-xl p-6 border border-gray-200">
              <div className="flex items-center justify-between mb-4">
                <Package className="w-8 h-8 text-purple-600" />
              </div>
              <h3 className="text-2xl font-bold text-gray-900">
                {dashboardMetrics.metrics.activeProducts.toLocaleString()}
              </h3>
              <p className="text-gray-600 text-sm mt-1">{t('reports.metrics.activeProducts')}</p>
            </div>

            {/* Orders in Period */}
            <div className="bg-white rounded-xl p-6 border border-gray-200">
              <div className="flex items-center justify-between mb-4">
                <ShoppingCart className="w-8 h-8 text-green-600" />
                <ChangeBadge value={weeklyChange} />
              </div>
              <h3 className="text-2xl font-bold text-gray-900">
                {(dashboardMetrics.metrics.ordersInPeriod ?? dashboardMetrics.metrics.ordersToday).toLocaleString()}
              </h3>
              <p className="text-gray-600 text-sm mt-1">{t('reports.metrics.ordersInPeriod', { period })}</p>
            </div>

            {/* Conversion Rate */}
            <div className="bg-white rounded-xl p-6 border border-gray-200">
              <div className="flex items-center justify-between mb-4">
                <TrendingUp className="w-8 h-8 text-orange-600" />
              </div>
              <h3 className="text-2xl font-bold text-gray-900">
                {dashboardMetrics.metrics.conversionRate}%
              </h3>
              <p className="text-gray-600 text-sm mt-1">{t('reports.metrics.conversionRate')}</p>
            </div>
          </>
        ) : (
          <div className="col-span-full bg-white rounded-xl p-6 border border-gray-200 text-gray-500 text-center">
            {t('reports.errors.noMetrics')}
          </div>
        )}
      </div>

      {/* AI Insights */}
      {(loading || ai) && (
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl p-6 border border-blue-100 mb-8">
          <div className="flex items-center gap-2 mb-5">
            <Zap className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-gray-900">{t('reports.aiPerformance')}</h2>
          </div>
          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="bg-white rounded-lg p-4 animate-pulse">
                  <div className="w-16 h-6 bg-gray-200 rounded mb-1" />
                  <div className="w-24 h-4 bg-gray-100 rounded" />
                </div>
              ))}
            </div>
          ) : ai ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { label: t('reports.ai.messagesHandled'), value: ai.total_messages.toLocaleString() },
                { label: t('reports.ai.llmCalls'),         value: ai.llm_calls.toLocaleString() },
                { label: t('reports.ai.cacheHits'),        value: ai.cache_hits.toLocaleString() },
                { label: t('reports.ai.estCost'),          value: `৳${Number(ai.cost_estimate).toFixed(2)}` },
              ].map(({ label, value }) => (
                <div key={label} className="bg-white rounded-lg p-4 border border-blue-100">
                  <p className="text-xl font-bold text-gray-900">{value}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{label}</p>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {/* Knowledge Gaps */}
      <div className="bg-white rounded-xl p-6 border border-gray-200 mb-8">
        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <MessageSquare className="w-6 h-6 text-purple-600" />
            <div>
              <h2 className="text-lg font-semibold text-gray-900">{t('reports.knowledgePerformance')}</h2>
              <p className="text-sm text-gray-500">{t('reports.knowledgeGapsSubtitle')}</p>
            </div>
          </div>
          {knowledgeGaps.length > 0 && (
            <button
              onClick={exportGapsCsv}
              className="flex items-center gap-1.5 text-sm text-gray-600 border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
            >
              <Download className="w-3.5 h-3.5" />
              {t('reports.exportCsv')}
            </button>
          )}
        </div>

        {loading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-10 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : knowledgeGaps.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-gray-400 text-sm mb-3">{t('reports.noKnowledgeGaps')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{t('reports.gapColumns.question')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-28">{t('reports.gapColumns.platform')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-28">{t('reports.gapColumns.language')}</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-32">{t('reports.gapColumns.date')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {knowledgeGaps.map(gap => (
                  <tr key={gap.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm text-gray-800">{gap.question}</td>
                    <td className="px-4 py-3 text-sm text-gray-500 capitalize">{gap.platform}</td>
                    <td className="px-4 py-3 text-sm text-gray-500 uppercase">{gap.language}</td>
                    <td className="px-4 py-3 text-sm text-gray-400">{new Date(gap.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Channel Performance */}
      <div className="bg-white rounded-xl p-6 border border-gray-200 mb-8">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h2 className="text-lg font-semibold text-gray-900">{t('reports.channelPerformance')}</h2>
          <div className="flex items-center gap-3">
            {error && <span className="text-sm text-red-600">{error}</span>}
            {channelPerformance.length > 0 && (
              <button
                onClick={exportChannelCsv}
                className="flex items-center gap-1.5 text-sm text-gray-600 border border-gray-300 px-3 py-1.5 rounded-lg hover:bg-gray-50"
              >
                <Download className="w-3.5 h-3.5" />
                Export CSV
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-12 bg-gray-100 rounded animate-pulse" />
            ))}
          </div>
        ) : channelPerformance.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-gray-500 text-sm mb-4">{t('reports.noChannelData')}</p>
            <button
              onClick={() => navigate('/manage-shop/chat-settings')}
              className="inline-flex min-h-11 items-center gap-2 text-sm bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 font-medium"
            >
              {t('reports.connectFirstChannel')}
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{t('reports.columns.channel')}</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{t('reports.columns.messages')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {channelPerformance.map(ch => (
                  <tr key={ch.channel} className="hover:bg-gray-50">
                    <td className="px-6 py-4 text-sm font-medium text-gray-900">{ch.channel}</td>
                    <td className="px-6 py-4 text-sm text-gray-600">{ch.messages.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

    </div>
  );
}
