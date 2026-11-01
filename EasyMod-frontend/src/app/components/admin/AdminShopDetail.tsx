import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { adminApi, type AdminPilotFeatures } from '@/api/domains/admin';
import { useIsPlatformAdmin } from '@/shared/lib/auth/useIsPlatformAdmin';

const TABS = ['Overview', 'Channels', 'Billing', 'AI & Inbox', 'Orders & Courier'] as const;
type Tab = typeof TABS[number];

const TAB_LABEL_KEYS: Record<Tab, string> = {
  Overview: 'admin.shopDetail.tabs.overview',
  Channels: 'admin.shopDetail.tabs.channels',
  Billing: 'admin.shopDetail.tabs.billing',
  'AI & Inbox': 'admin.shopDetail.tabs.aiInbox',
  'Orders & Courier': 'admin.shopDetail.tabs.ordersCourier',
};

export default function AdminShopDetail() {
  const { t } = useTranslation();
  const { shopId = '' } = useParams();
  const { role } = useIsPlatformAdmin();
  const canMutate = role === 'SUPER_ADMIN';
  const [tab, setTab] = useState<Tab>('Overview');
  const [overview, setOverview] = useState<any>(null);
  const [channels, setChannels] = useState<any[]>([]);
  const [billing, setBilling] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pilot, setPilot] = useState<AdminPilotFeatures | null>(null);

  const reload = () => {
    adminApi.getShop(shopId).then(setOverview).catch(() => {});
    adminApi.getShopChannels(shopId).then(setChannels).catch(() => {});
    adminApi.getShopBilling(shopId).then(setBilling).catch(() => {});
    adminApi.getPilotFeatures(shopId).then(setPilot).catch(() => {});
  };
  useEffect(reload, [shopId]);

  const act = async (fn: () => Promise<any>, label: string) => {
    try { await fn(); setMsg(t('admin.shopDetail.actionSuccess', { label })); reload(); }
    catch (e: any) { setMsg(t('admin.shopDetail.actionFailed', { label, error: e?.message || e })); }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-gray-900">{overview?.shop?.shopName || t('admin.shopDetail.shopFallback')}</h1>
      {msg && <div className="rounded bg-gray-100 px-3 py-2 text-sm">{msg}</div>}

      <div className="flex gap-1 border-b">
        {TABS.map((tabKey) => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`px-3 py-2 text-sm ${tab === tabKey ? 'border-b-2 border-blue-600 text-blue-700' : 'text-gray-500'}`}
          >
            {t(TAB_LABEL_KEYS[tabKey])}
          </button>
        ))}
      </div>

      {tab === 'Overview' && overview && (
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-3">
          <div><dt className="text-gray-500">{t('admin.shopDetail.overview.owner')}</dt><dd>{overview.owner?.email || '—'}</dd></div>
          <div><dt className="text-gray-500">{t('admin.shopDetail.overview.plan')}</dt><dd>{overview.subscription?.planName || '—'}</dd></div>
          <div><dt className="text-gray-500">{t('admin.shopDetail.overview.status')}</dt><dd>{overview.subscription?.status || '—'}</dd></div>
           <div><dt className="text-gray-500">{t('admin.shopDetail.overview.periodEnd')}</dt><dd>{overview.subscription?.currentPeriodEnd ? new Date(overview.subscription.currentPeriodEnd).toLocaleDateString() : '—'}</dd></div>
           <div><dt className="text-gray-500">{t('admin.shopDetail.overview.conversations')}</dt><dd>{overview.usage?.conversationsUsed ?? '—'}/{overview.usage?.effectiveConversationLimit ?? overview.usage?.conversationsLimit ?? '—'}</dd></div>
          <div><dt className="text-gray-500">{t('admin.shopDetail.overview.onboarding')}</dt><dd>{overview.onboarding?.completed ? t('admin.shopDetail.overview.complete') : t('admin.shopDetail.overview.incomplete')}</dd></div>
        </dl>
      )}

      {tab === 'Channels' && (
        <div className="space-y-3">
          <button
            disabled={!canMutate}
            title={canMutate ? t('admin.shopDetail.channels.emergencyTitle') : t('admin.shopDetail.superAdminRequired')}
            onClick={() => {
              if (!canMutate) return;
              if (window.confirm(t('admin.shopDetail.channels.emergencyConfirm'))) {
                act(() => adminApi.emergencyAiOff(shopId), t('admin.shopDetail.channels.emergencyAction'));
              }
            }}
            className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            {t('admin.shopDetail.channels.emergencyButton')}
          </button>
          {!canMutate && <span className="text-xs text-gray-500">{t('admin.shopDetail.channels.superAdminNote')}</span>}
          <table className="min-w-full rounded-lg border bg-white text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">{t('admin.shopDetail.channels.colChannel')}</th>
                <th className="px-3 py-2">{t('admin.shopDetail.channels.colPlatform')}</th>
                <th className="px-3 py-2">{t('admin.shopDetail.channels.colToken')}</th>
                <th className="px-3 py-2">{t('admin.shopDetail.channels.colWebhook')}</th>
                <th className="px-3 py-2">{t('admin.shopDetail.channels.colError')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.id} className="border-t">
                  <td className="px-3 py-2">{c.displayName}</td>
                  <td className="px-3 py-2">{c.platform}</td>
                  <td className="px-3 py-2">{c.status}</td>
                  <td className="px-3 py-2">{c.webhookLastVerifiedAt ? t('admin.shopDetail.channels.verified') : '—'}</td>
                  <td className="px-3 py-2 text-red-600">{c.lastError || '—'}</td>
                  <td className="px-3 py-2">
                    <button
                      disabled={!canMutate}
                      title={canMutate ? t('admin.shopDetail.channels.markReconnectTitle') : t('admin.shopDetail.superAdminRequired')}
                      onClick={() => {
                        if (canMutate) act(() => adminApi.markReconnect(shopId, c.id), t('admin.shopDetail.channels.markReconnectAction'));
                      }}
                      className="text-blue-600 disabled:cursor-not-allowed disabled:text-gray-400"
                    >
                      {t('admin.shopDetail.channels.markReconnect')}
                    </button>
                  </td>
                </tr>
              ))}
              {channels.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">{t('admin.shopDetail.channels.noChannels')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'Billing' && billing && (
        <div className="space-y-4 text-sm">
          {/* Summary grid */}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
            <div><dt className="text-gray-500">{t('admin.shopDetail.billing.plan')}</dt><dd><b>{billing.planName}</b> ({billing.billingCycle || '—'})</dd></div>
            <div><dt className="text-gray-500">{t('admin.shopDetail.billing.status')}</dt><dd className={billing.status === 'suspended' || billing.status === 'trial_expired' ? 'text-red-700 font-medium' : ''}>{billing.status}</dd></div>
            <div><dt className="text-gray-500">{t('admin.shopDetail.billing.conversations')}</dt><dd>{billing.conversationsUsed ?? '—'}/{billing.conversationsLimit ?? '—'}</dd></div>
            <div><dt className="text-gray-500">{t('admin.shopDetail.billing.topupBalance')}</dt><dd>{billing.topupBalance ?? 0}</dd></div>
            <div><dt className="text-gray-500">{t('admin.shopDetail.billing.nextBilling')}</dt><dd>{billing.nextBillingDate ? new Date(billing.nextBillingDate).toLocaleDateString() : '—'}</dd></div>
             <div><dt className="text-gray-500">{t('admin.shopDetail.billing.effectiveLimit')}</dt><dd>{billing.effectiveConversationLimit ?? billing.conversationsLimit ?? '—'}</dd></div>
             <div><dt className="text-gray-500">{t('admin.shopDetail.billing.partnerEligibility')}</dt><dd>{billing.partnerEligibility?.delivered_orders_30d ?? 0} / {billing.partnerEligibility?.minimum_delivered_orders ?? 300}</dd></div>
            <div><dt className="text-gray-500">{t('admin.shopDetail.billing.outstanding')}</dt><dd className={billing.outstandingAmount > 0 ? 'text-amber-700 font-medium' : ''}>৳{(billing.outstandingAmount ?? 0).toLocaleString()}</dd></div>
          </dl>

          {!canMutate && <p className="text-xs text-gray-500">{t('admin.shopDetail.billing.superAdminNote')}</p>}
          <div className="flex flex-wrap gap-2">
            <button disabled={!canMutate} onClick={() => act(() => adminApi.addCredits(shopId, 50, 'admin_grant'), t('admin.shopDetail.billing.addCredits'))} className="rounded border px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-45">{t('admin.shopDetail.billing.addCredits')}</button>
             {billing.status === 'suspended' || billing.status === 'trial_expired' || billing.status === 'past_due' || billing.status === 'cancelled' || billing.status === 'inactive'
              ? <button disabled={!canMutate} onClick={() => act(() => adminApi.setStatus(shopId, 'active'), t('admin.shopDetail.billing.reactivate'))} className="rounded border px-3 py-1.5 text-green-700 disabled:cursor-not-allowed disabled:opacity-45">{t('admin.shopDetail.billing.reactivateAiOn')}</button>
              : <button disabled={!canMutate} onClick={() => act(() => adminApi.setStatus(shopId, 'suspended'), t('admin.shopDetail.billing.suspend'))} className="rounded border px-3 py-1.5 text-red-700 disabled:cursor-not-allowed disabled:opacity-45">{t('admin.shopDetail.billing.suspendAiOff')}</button>}
          </div>

          {/* Invoices */}
          <div>
            <h3 className="mb-1 font-medium text-gray-700">{t('admin.shopDetail.billing.invoices')}</h3>
            {Array.isArray(billing.invoices) && billing.invoices.length > 0 ? (
              <table className="w-full text-xs">
                <thead><tr className="text-left text-gray-500">
                  <th className="py-1">{t('admin.shopDetail.billing.invInvoice')}</th><th>{t('admin.shopDetail.billing.invType')}</th><th>{t('admin.shopDetail.billing.invAmount')}</th><th>{t('admin.shopDetail.billing.invStatus')}</th><th>{t('admin.shopDetail.billing.invDue')}</th><th>{t('admin.shopDetail.billing.invPaid')}</th>
                </tr></thead>
                <tbody>
                  {billing.invoices.map((inv: any) => (
                    <tr key={inv.id} className="border-t">
                      <td className="py-1 font-mono">{inv.invoiceNumber}</td>
                      <td>{inv.type}</td>
                      <td>৳{(inv.amount ?? 0).toLocaleString()}</td>
                      <td className={inv.status === 'paid' ? 'text-green-700' : inv.status === 'overdue' ? 'text-red-700' : 'text-amber-700'}>{inv.status}</td>
                      <td>{inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : '—'}</td>
                      <td>{inv.paidAt ? new Date(inv.paidAt).toLocaleDateString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="text-xs text-gray-400">{t('admin.shopDetail.billing.noInvoices')}</p>}
          </div>
        </div>
      )}

      {tab === 'AI & Inbox' && (
        <div className="rounded border border-dashed p-6 text-center text-gray-400">{t('admin.shopDetail.phase2')}</div>
      )}

      {tab === 'Orders & Courier' && (
        <div className="space-y-3 text-sm" data-testid="admin-pilot-features">
          <h3 className="font-medium text-gray-800">{t('admin.shopDetail.pilot.title')}</h3>
          <p className="text-xs text-gray-500">{t('admin.shopDetail.pilot.help')}</p>
          {pilot ? (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={pilot.customer_intelligence}
                  disabled={!canMutate}
                  onChange={(e) => act(
                    () => adminApi.setPilotFeatures(shopId, { customer_intelligence: e.target.checked }).then(setPilot),
                    t('admin.shopDetail.pilot.customerIntelligence'),
                  )}
                />
                {t('admin.shopDetail.pilot.customerIntelligence')}
              </label>
              <label className="inline-flex items-center gap-2">
                {t('admin.shopDetail.pilot.orderConfidence')}
                <select
                  value={pilot.order_confidence_mode}
                  disabled={!canMutate}
                  onChange={(e) => act(
                    () => adminApi.setPilotFeatures(shopId, {
                      order_confidence_mode: e.target.value as 'off' | 'shadow' | 'enforce',
                    }).then(setPilot),
                    t('admin.shopDetail.pilot.orderConfidence'),
                  )}
                  className="rounded border px-2 py-1"
                >
                  {(['off', 'shadow', 'enforce'] as const).map((mode) => (
                    <option key={mode} value={mode}>{t(`admin.shopDetail.pilot.modes.${mode}`)}</option>
                  ))}
                </select>
              </label>
              </div>
              <fieldset className="mt-5 space-y-3 border-t pt-4" data-testid="admin-founder-pilot-flags">
                <legend className="font-medium text-gray-800">{t('admin.shopDetail.pilot.founderTitle')}</legend>
                <p className="text-xs leading-5 text-gray-500">{t('admin.shopDetail.pilot.founderHelp')}</p>
                <div className="grid gap-3 text-sm md:grid-cols-2">
                  <label className="inline-flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={pilot.ads_studio}
                      disabled={!canMutate}
                      onChange={(e) => act(
                        () => adminApi.setPilotFeatures(shopId, { ads_studio: e.target.checked }).then(setPilot),
                        t('admin.shopDetail.pilot.adsStudio'),
                      )}
                    />
                    <span>
                      <span className="block font-medium">{t('admin.shopDetail.pilot.adsStudio')}</span>
                      <span className="block text-xs text-gray-500">{t('admin.shopDetail.pilot.adsStudioHelp')}</span>
                    </span>
                  </label>
                  <label className="inline-flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={pilot.storefront}
                      disabled={!canMutate}
                      onChange={(e) => act(
                        () => adminApi.setPilotFeatures(shopId, { storefront: e.target.checked }).then(setPilot),
                        t('admin.shopDetail.pilot.storefront'),
                      )}
                    />
                    <span>
                      <span className="block font-medium">{t('admin.shopDetail.pilot.storefront')}</span>
                      <span className="block text-xs text-gray-500">{t('admin.shopDetail.pilot.storefrontHelp')}</span>
                    </span>
                  </label>
                  <label className="inline-flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={pilot.ai_reply_shadow_meter}
                      disabled={!canMutate}
                      onChange={(e) => act(
                        () => adminApi.setPilotFeatures(shopId, { ai_reply_shadow_meter: e.target.checked }).then(setPilot),
                        t('admin.shopDetail.pilot.shadowMeter'),
                      )}
                    />
                    <span>
                      <span className="block font-medium">{t('admin.shopDetail.pilot.shadowMeter')}</span>
                      <span className="block text-xs text-gray-500">{t('admin.shopDetail.pilot.shadowMeterHelp')}</span>
                      {pilot.ai_reply_shadow_meter && pilot.ai_reply_shadow_meter_enabled_at && (
                        <span className="mt-1 block text-xs text-gray-500">
                          {t('admin.shopDetail.pilot.shadowMeterStarted', {
                            date: new Date(pilot.ai_reply_shadow_meter_enabled_at).toISOString(),
                          })}
                        </span>
                      )}
                    </span>
                  </label>
                </div>
              </fieldset>
            </>
          ) : <p className="text-xs text-gray-400">…</p>}
          {!canMutate && <p className="text-xs text-gray-500">{t('admin.shopDetail.superAdminRequired')}</p>}
        </div>
      )}
    </div>
  );
}
