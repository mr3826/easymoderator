import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  CreditCard,
  MessagesSquare,
  NotebookPen,
  RefreshCw,
  Share2,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import {
  adminApi,
  merchantsApi,
  workspaceApi,
  type Merchant360,
  type MerchantInsight,
} from '@/api/client';
import { usePermission } from '@/auth/usePermission';
import { useGrowthAuth } from '@/auth/GrowthAuthProvider';
import { planLabel } from '@/planLabel';

type BusyAction = 'status' | 'credits' | 'reconnect' | 'note' | null;

type PendingCreditOperation = {
  shopId: string;
  amount: number;
  reason: string;
  key: string;
};

const PENDING_CREDIT_OPERATION_KEY = 'growth-os:pending-credit-operation';

function pendingCreditStorageKey(shopId: string) {
  return `${PENDING_CREDIT_OPERATION_KEY}:${shopId}`;
}

function readPendingCreditOperation(shopId: string | undefined): PendingCreditOperation | null {
  if (!shopId) return null;
  try {
    const raw = sessionStorage.getItem(pendingCreditStorageKey(shopId));
    if (!raw) return null;
    const pending = JSON.parse(raw) as Partial<PendingCreditOperation>;
    return pending.shopId === shopId
      && typeof pending.amount === 'number'
      && typeof pending.reason === 'string'
      && typeof pending.key === 'string'
      ? pending as PendingCreditOperation
      : null;
  } catch (_error) {
    return null;
  }
}

function savePendingCreditOperation(operation: PendingCreditOperation) {
  try {
    sessionStorage.setItem(pendingCreditStorageKey(operation.shopId), JSON.stringify(operation));
  } catch (_error) {
    // The server still enforces the key; storage is only for reload recovery.
  }
}

function clearPendingCreditOperation(shopId: string | undefined) {
  if (!shopId) return;
  try {
    sessionStorage.removeItem(pendingCreditStorageKey(shopId));
  } catch (_error) {
    // Ignore storage restrictions in private browsing/test environments.
  }
}

interface ResultSummary {
  label: string;
  data: unknown;
}

function codeLabel(value: string) {
  return value.replace(/_/g, ' ');
}

function formatDate(value: string | null | undefined, includeTime = false) {
  if (!value) return 'Not provided';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, includeTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' }).format(date);
}

function formatNumber(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'Not provided';
  return new Intl.NumberFormat().format(value);
}

function truncate(value: string | null, max = 140) {
  if (!value) return 'None';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function serverMessage(error: unknown, fallback: string) {
  const raw = error instanceof Error && error.message.trim() ? error.message : fallback;
  return raw.replace(/[<>]/g, '').slice(0, 400);
}

function yesNo(value: boolean) {
  return value ? 'Yes' : 'No';
}

function isMerchant360(data: Merchant360 | MerchantInsight): data is Merchant360 {
  return 'overview' in data;
}

function statusBadgeClass(status: string | null | undefined) {
  return `status-badge${status ? ` status-${status.toLowerCase().replace(/_/g, '-')}` : ''}`;
}

function isMerchantOperational(status: string | null | undefined, fallback: boolean) {
  if (!status) return fallback;
  return !['cancelled', 'canceled', 'expired', 'suspended'].includes(status.toLowerCase());
}

function changePairs(data: unknown): Array<[string, unknown]> {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const pairs: Array<[string, unknown]> = [];
  const before = record.before ?? record.oldValues;
  const after = record.after ?? record.newValues;
  if (before !== undefined) pairs.push(['Before', before]);
  if (after !== undefined) pairs.push(['After', after]);
  return pairs;
}

export function MerchantDetailPage() {
  const { shopId } = useParams<{ shopId: string }>();
  const { reportApiError } = useGrowthAuth();
  const isAdmin = usePermission('growth_os.admin.merchants.read');
  const [data, setData] = useState<Merchant360 | MerchantInsight | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [busy, setBusy] = useState<BusyAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [result, setResult] = useState<ResultSummary | null>(null);

  const [statusReason, setStatusReason] = useState('');
  const [statusArmed, setStatusArmed] = useState(false);
  const [creditAmount, setCreditAmount] = useState('');
  const [creditReason, setCreditReason] = useState('');
  const [creditArmed, setCreditArmed] = useState(false);
  const [pendingCreditOperation, setPendingCreditOperation] = useState<PendingCreditOperation | null>(
    () => readPendingCreditOperation(shopId),
  );
  const [channelId, setChannelId] = useState('');
  const [reconnectReason, setReconnectReason] = useState('');
  const [reconnectConfirm, setReconnectConfirm] = useState('');
  const [noteBody, setNoteBody] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!shopId) {
      setError('This merchant URL is missing a shop identifier.');
      setLoading(false);
      return () => {
        active = false;
      };
    }

    setLoading(true);
    setError(null);
    merchantsApi.detail(shopId)
      .then((nextData) => {
        if (active) setData(nextData);
      })
      .catch((requestError: unknown) => {
        if (!active || reportApiError(requestError)) return;
        setData(null);
        setError(serverMessage(requestError, 'Unable to load this merchant.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [shopId, isAdmin, reloadToken, reportApiError]);

  function validateReason(reason: string, verb: string): boolean {
    if (!reason.trim()) {
      setActionError(`A reason is required to ${verb}.`);
      return false;
    }
    if (reason.trim().length > 300) {
      setActionError('Reasons must stay within 300 characters.');
      return false;
    }
    return true;
  }

  function refreshDetails() {
    setReloadToken((current) => current + 1);
  }

  async function handleStatusToggle() {
    if (!shopId || !data || !isMerchant360(data)) return;
    const becomingActive = !isMerchantOperational(data.subscription?.status, data.overview.shop.isActive);
    if (!validateReason(statusReason, becomingActive ? 'reactivate this merchant' : 'suspend this merchant')) return;
    if (!becomingActive && !statusArmed) {
      setStatusArmed(true);
      setActionError(null);
      return;
    }
    setBusy('status');
    setActionError(null);
    setResult(null);
    try {
      const next = await adminApi.setMerchantStatus(shopId, {
        active: becomingActive,
        reason: statusReason.trim(),
      });
      setResult({
        label: becomingActive ? 'Merchant reactivated.' : 'Merchant suspended.',
        data: next,
      });
      setStatusReason('');
      setStatusArmed(false);
      refreshDetails();
    } catch (requestError: unknown) {
      if (reportApiError(requestError)) return;
      setStatusArmed(false);
      setActionError(serverMessage(requestError, 'The merchant status change could not be applied.'));
    } finally {
      setBusy(null);
    }
  }

  async function handleGrantCredits() {
    if (!shopId) return;
    const amount = Number(creditAmount);
    if (!creditAmount.trim() || !Number.isInteger(amount) || amount < 1 || amount > 100000) {
      setActionError('Enter a whole number of credits between 1 and 100,000.');
      return;
    }
    if (!validateReason(creditReason, 'grant conversation credits')) return;
    if (!creditArmed) {
      const normalizedReason = creditReason.trim();
      const reusableOperation = pendingCreditOperation
        && pendingCreditOperation.shopId === shopId
        && pendingCreditOperation.amount === amount
        && pendingCreditOperation.reason === normalizedReason
        ? pendingCreditOperation
        : {
          shopId,
          amount,
          reason: normalizedReason,
          key: crypto.randomUUID(),
        };
      savePendingCreditOperation(reusableOperation);
      setPendingCreditOperation(reusableOperation);
      setCreditArmed(true);
      setActionError(null);
      return;
    }
    const requestKey = pendingCreditOperation?.key ?? crypto.randomUUID();
    if (!pendingCreditOperation) {
      const operation = { shopId, amount, reason: creditReason.trim(), key: requestKey };
      savePendingCreditOperation(operation);
      setPendingCreditOperation(operation);
    }
    setBusy('credits');
    setActionError(null);
    setResult(null);
    try {
      const next = await adminApi.grantMerchantCredits(shopId, {
        amount,
        reason: creditReason.trim(),
      }, requestKey);
      setResult({ label: `Granted ${formatNumber(amount)} conversation credits.`, data: next });
      setCreditAmount('');
      setCreditReason('');
      setCreditArmed(false);
      clearPendingCreditOperation(shopId);
      setPendingCreditOperation(null);
      refreshDetails();
    } catch (requestError: unknown) {
      if (reportApiError(requestError)) return;
      setCreditArmed(false);
      setActionError(serverMessage(requestError, 'The credit grant could not be applied.'));
    } finally {
      setBusy(null);
    }
  }

  async function handleReconnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shopId) return;
    if (!channelId) {
      setActionError('Choose a Meta channel to reconnect.');
      return;
    }
    if (!validateReason(reconnectReason, 'request a Meta reconnect')) return;
    if (reconnectConfirm.trim() !== 'RECONNECT') {
      setActionError('Type RECONNECT exactly to confirm the reconnect request.');
      return;
    }
    setBusy('reconnect');
    setActionError(null);
    setResult(null);
    try {
      const next = await adminApi.requestChannelReconnect(shopId, channelId, {
        reason: reconnectReason.trim(),
        confirm: 'RECONNECT',
      });
      setResult({ label: 'Reconnect request recorded for the selected channel.', data: next });
      setReconnectReason('');
      setReconnectConfirm('');
      refreshDetails();
    } catch (requestError: unknown) {
      if (reportApiError(requestError)) return;
      setActionError(serverMessage(requestError, 'The reconnect request could not be submitted.'));
    } finally {
      setBusy(null);
    }
  }

  async function handleAddNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shopId) return;
    if (!noteBody.trim()) {
      setNoteError('Write a note before saving.');
      return;
    }
    setBusy('note');
    setNoteError(null);
    try {
      await workspaceApi.createNote({ targetType: 'shop', targetId: shopId, body: noteBody.trim() });
      setNoteBody('');
      refreshDetails();
    } catch (requestError: unknown) {
      if (reportApiError(requestError)) return;
      setNoteError(serverMessage(requestError, 'The note could not be saved.'));
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <main className="page-content" aria-label="Loading merchant">
        <div className="content-card detail-loading">
          <div className="loading-mark" aria-hidden="true" />
          <p>Loading merchant details</p>
        </div>
      </main>
    );
  }

  if (error || !data || !shopId) {
    return (
      <main className="page-content" aria-labelledby="merchant-error-title">
        <div className="inline-state error-state" role="alert">
          <h2 id="merchant-error-title">Merchant unavailable</h2>
          <p>{error || 'This merchant could not be found.'}</p>
          <div className="button-row">
            <button className="secondary-button" type="button" onClick={() => setReloadToken((current) => current + 1)}>
              Try again
            </button>
            <Link className="secondary-button" to="/merchants">Back to merchants</Link>
          </div>
        </div>
      </main>
    );
  }

  const heading = (title: string, eyebrow: string, badges: ReactNode) => (
    <div className="page-heading detail-heading">
      <div>
        <Link className="back-link" to="/merchants">
          <ArrowLeft aria-hidden="true" />
          <span>All merchants</span>
        </Link>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id="merchant-detail-title">{title}</h2>
        <div className="heading-meta">{badges}</div>
      </div>
      <button
        className="icon-button"
        type="button"
        aria-label="Refresh merchant"
        title="Refresh merchant"
        onClick={() => setReloadToken((current) => current + 1)}
      >
        <RefreshCw aria-hidden="true" />
      </button>
    </div>
  );

  if (!isAdmin) {
    if (isMerchant360(data)) {
      return (
        <main className="page-content">
          <div className="inline-state error-state" role="alert">
            <h2>Merchant view unavailable</h2>
            <p>The full merchant payload is not available for your role. Return to the masked view.</p>
            <Link className="secondary-button" to="/merchants">Back to merchants</Link>
          </div>
        </main>
      );
    }
    const insight = data;
    return (
      <main className="page-content" aria-labelledby="merchant-detail-title">
        {heading(
          insight.merchantName || 'Unnamed merchant',
          'Masked merchant insight',
          <span className={statusBadgeClass(insight.subscriptionStatus)}>
            {insight.subscriptionStatus ? codeLabel(insight.subscriptionStatus) : 'Status unknown'}
          </span>,
        )}
        <p className="page-lede">
          Limited, masked merchant context for growth work. Admin identifiers, owner contact
          details, usage limits, and mutation controls are not available in this view.
        </p>

        <section className="content-card" aria-labelledby="insight-facts-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Growth context</p>
              <h3 id="insight-facts-title">Merchant summary</h3>
            </div>
            <ShieldCheck aria-hidden="true" />
          </div>
          <dl className="detail-facts">
            <div><dt>Merchant</dt><dd>{insight.merchantName || 'Unnamed merchant'}</dd></div>
            <div><dt>Sign-up date</dt><dd>{formatDate(insight.signupDate)}</dd></div>
            <div><dt>Plan</dt><dd>{planLabel(insight.planName)}</dd></div>
            <div><dt>Subscription status</dt><dd>{insight.subscriptionStatus ? codeLabel(insight.subscriptionStatus) : 'Not provided'}</dd></div>
            <div><dt>Activation state</dt><dd>{codeLabel(insight.activation.state)}</dd></div>
            <div><dt>Activated at</dt><dd>{insight.activation.activatedAt ? formatDate(insight.activation.activatedAt) : 'Not activated'}</dd></div>
            <div><dt>Facebook connected</dt><dd>{yesNo(insight.facebook.connected)}</dd></div>
          </dl>
        </section>

        <section className="content-card" aria-labelledby="insight-prospects-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Conversion history</p>
              <h3 id="insight-prospects-title">Linked prospects</h3>
            </div>
            <Workflow aria-hidden="true" />
          </div>
          {insight.linkedProspects.length === 0 ? (
            <div className="inline-state empty-state compact-state"><p>No prospects are linked to this merchant yet.</p></div>
          ) : (
            <ul className="work-list">
              {insight.linkedProspects.map((prospect) => (
                <li className="work-item" key={prospect.prospectId}>
                  <div>
                    <Link className="table-link" to={`/prospects/${encodeURIComponent(prospect.prospectId)}`}>
                      {prospect.businessName}
                    </Link>
                    <span className="table-subtext">
                      {codeLabel(prospect.source)} · created {formatDate(prospect.createdAt)}
                    </span>
                  </div>
                  <span className={statusBadgeClass(prospect.status)}>{codeLabel(prospect.status)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    );
  }

  if (!isMerchant360(data)) {
    return (
      <main className="page-content">
        <div className="inline-state error-state" role="alert">
          <h2>Merchant view unavailable</h2>
          <p>The admin view for this merchant could not be loaded. Try again or return to the list.</p>
          <div className="button-row">
            <button className="secondary-button" type="button" onClick={() => setReloadToken((current) => current + 1)}>
              Try again
            </button>
            <Link className="secondary-button" to="/merchants">Back to merchants</Link>
          </div>
        </div>
      </main>
    );
  }
  const view = data;
  const shop = view.overview.shop;
  const channels = view.facebook.channels;
  const subscription = view.subscription;
  const merchantIsOperational = isMerchantOperational(subscription?.status, shop.isActive);
  const usage = subscription?.usage ?? view.overview.usage;
  const effectiveLimit = 'effectiveLimit' in usage ? usage.effectiveLimit : usage.effectiveConversationLimit;

  return (
    <main className="page-content" aria-labelledby="merchant-detail-title">
      {heading(
        shop.shopName || 'Unnamed shop',
        'Merchant 360',
        <>
          <span className={statusBadgeClass(shop.isActive ? 'active' : 'inactive')}>
            {shop.isActive ? 'Active' : 'Inactive'}
          </span>
          <span>Code {shop.uniqueCode}</span>
          <span>Shop ID {shop.id}</span>
        </>,
      )}

      {actionError ? (
        <div className="inline-state error-state" role="alert">
          <strong>Action could not be completed.</strong>
          <p>{actionError}</p>
        </div>
      ) : null}
      {result ? (
        <div className="inline-state" role="status">
          <strong>{result.label}</strong>
          {changePairs(result.data).map(([label, value]) => (
            <div key={label}>
              <p className="eyebrow">{label}</p>
              <pre className="json-block">{JSON.stringify(value, null, 2)}</pre>
            </div>
          ))}
          <p>The action was written to the privileged audit trail.</p>
          <div className="button-row">
            <Link className="secondary-button" to="/audit">View audit trail</Link>
          </div>
        </div>
      ) : null}

      <div className="detail-grid">
        <div className="detail-main-column">
          <section className="content-card" aria-labelledby="overview-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Account and shop</p>
                <h3 id="overview-title">Overview</h3>
              </div>
              <ShieldCheck aria-hidden="true" />
            </div>
            <dl className="detail-facts">
              <div><dt>Shop name</dt><dd>{shop.shopName || 'Unnamed shop'}</dd></div>
              <div><dt>Unique code</dt><dd>{shop.uniqueCode}</dd></div>
              <div><dt>Active</dt><dd>{yesNo(merchantIsOperational)}</dd></div>
              <div><dt>Timezone</dt><dd>{shop.timezone}</dd></div>
              <div><dt>Created</dt><dd>{formatDate(shop.createdAt, true)}</dd></div>
              <div><dt>Owner</dt><dd>{view.overview.owner?.name || view.overview.owner?.email || 'No owner linked'}</dd></div>
              <div><dt>Owner email</dt><dd>{view.overview.owner?.email || 'No email provided'}</dd></div>
              <div><dt>Owner phone</dt><dd>{view.overview.owner?.phone || 'No phone provided'}</dd></div>
              <div><dt>Last activity</dt><dd>{formatDate(view.overview.lastActivityAt, true)}</dd></div>
              <div><dt>Onboarding completed</dt><dd>{yesNo(view.overview.onboarding.completed)}</dd></div>
              <div><dt>Activated at</dt><dd>{view.overview.activation.activatedAt ? formatDate(view.overview.activation.activatedAt, true) : 'Not activated'}</dd></div>
            </dl>
          </section>

          <section className="content-card" aria-labelledby="growth-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Conversion history</p>
                <h3 id="growth-title">Growth linkage</h3>
              </div>
              <Workflow aria-hidden="true" />
            </div>
            {view.growth.linkedProspects.length === 0 ? (
              <div className="inline-state empty-state compact-state"><p>No prospects are linked to this shop.</p></div>
            ) : (
              <ul className="work-list">
                {view.growth.linkedProspects.map((prospect) => (
                  <li className="work-item" key={prospect.prospectId}>
                    <div>
                      <Link className="table-link" to={`/prospects/${encodeURIComponent(prospect.prospectId)}`}>
                        {prospect.businessName}
                      </Link>
                      <span className="table-subtext">
                        {codeLabel(prospect.source)} · linked {prospect.linkedAt ? formatDate(prospect.linkedAt, true) : 'unknown date'}
                      </span>
                    </div>
                    <span className={statusBadgeClass(prospect.status)}>{codeLabel(prospect.status)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="content-card" aria-labelledby="subscription-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Billing</p>
                <h3 id="subscription-title">Subscription and usage</h3>
              </div>
              <CreditCard aria-hidden="true" />
            </div>
            {!subscription ? (
              <div className="inline-state empty-state compact-state"><p>No subscription record exists for this shop.</p></div>
            ) : (
              <>
                <dl className="detail-facts">
                  <div><dt>Plan</dt><dd>{planLabel(subscription.plan.name)}</dd></div>
                  <div><dt>Cycle / model</dt><dd>{subscription.plan.cycle} · {subscription.plan.model}</dd></div>
                  <div><dt>Status</dt><dd><span className={statusBadgeClass(subscription.status)}>{codeLabel(subscription.status)}</span></dd></div>
                  <div><dt>Current period</dt><dd>{formatDate(subscription.period.start)} – {formatDate(subscription.period.end)}</dd></div>
                  <div><dt>Next billing date</dt><dd>{formatDate(subscription.period.nextBillingDate)}</dd></div>
                  <div><dt>Outstanding amount</dt><dd>{subscription.outstandingAmount > 0
                    ? <span className="overdue-text">{formatNumber(subscription.outstandingAmount)} overdue</span>
                    : 'None'}</dd></div>
                  <div><dt>Conversations used</dt><dd>{formatNumber(usage.conversationsUsed)}</dd></div>
                  <div><dt>Effective limit</dt><dd>{formatNumber(effectiveLimit)}</dd></div>
                  <div><dt>Top-up balance</dt><dd>{formatNumber(usage.topupBalance)}</dd></div>
                </dl>
                <h4 className="subsection-title">Invoices</h4>
                {subscription.invoices.length === 0 ? (
                  <div className="inline-state empty-state compact-state"><p>No invoices have been issued yet.</p></div>
                ) : (
                  <div className="table-scroll">
                    <table className="data-table">
                      <caption className="sr-only">Invoices for this shop</caption>
                      <thead>
                        <tr>
                          <th scope="col">Invoice</th>
                          <th scope="col">Type</th>
                          <th scope="col">Amount</th>
                          <th scope="col">Status</th>
                          <th scope="col">Due</th>
                          <th scope="col">Paid</th>
                        </tr>
                      </thead>
                      <tbody>
                        {subscription.invoices.map((invoice) => (
                          <tr key={invoice.id}>
                            <th scope="row">{invoice.invoiceNumber}</th>
                            <td>{invoice.type ? codeLabel(invoice.type) : 'Standard'}</td>
                            <td>{formatNumber(invoice.amount)}</td>
                            <td><span className={statusBadgeClass(invoice.status)}>{codeLabel(invoice.status)}</span></td>
                            <td>{formatDate(invoice.dueDate)}</td>
                            <td>{invoice.paidAt ? formatDate(invoice.paidAt, true) : 'Not paid'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="content-card" aria-labelledby="channels-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Messaging</p>
                <h3 id="channels-title">Meta / Facebook channels</h3>
              </div>
              <Share2 aria-hidden="true" />
            </div>
            {channels.length === 0 ? (
              <div className="inline-state empty-state compact-state"><p>No Meta channels are connected to this shop.</p></div>
            ) : (
              <div className="table-scroll">
                <table className="data-table">
                  <caption className="sr-only">Meta channels for this shop</caption>
                  <thead>
                    <tr>
                      <th scope="col">Channel</th>
                      <th scope="col">Platform</th>
                      <th scope="col">Status</th>
                      <th scope="col">Token expires</th>
                      <th scope="col">Webhook verified</th>
                      <th scope="col">Last error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {channels.map((channel) => (
                      <tr key={channel.id}>
                        <th scope="row">{channel.displayName || 'Unnamed channel'}</th>
                        <td>{codeLabel(channel.platform)}</td>
                        <td><span className={statusBadgeClass(channel.status)}>{codeLabel(channel.status)}</span></td>
                        <td>{channel.tokenExpiresAt ? formatDate(channel.tokenExpiresAt, true) : 'No expiry provided'}</td>
                        <td>{channel.webhookLastVerifiedAt ? formatDate(channel.webhookLastVerifiedAt, true) : 'Never verified'}</td>
                        <td title={channel.lastError ?? undefined}>{truncate(channel.lastError)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="field-hint">
              Access tokens and secrets are never displayed in Growth OS. Expire dates and webhook
              verification times are shown for diagnosis only.
            </p>
          </section>

          <section className="content-card" aria-labelledby="ai-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Automation</p>
                <h3 id="ai-title">AI configuration</h3>
              </div>
              <Sparkles aria-hidden="true" />
            </div>
            <dl className="detail-facts">
              <div><dt>AI configured</dt><dd>{yesNo(view.overview.ai.configured)}</dd></div>
              <div><dt>Automation mode</dt><dd>{view.overview.ai.automationMode ?? 'Not provided'}</dd></div>
              <div><dt>Draft mode</dt><dd>{view.overview.ai.draftModeEnabled === undefined || view.overview.ai.draftModeEnabled === null
                ? 'Not provided'
                : String(view.overview.ai.draftModeEnabled)}</dd></div>
            </dl>
          </section>

          <section className="content-card" aria-labelledby="notes-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Internal record</p>
                <h3 id="notes-title">Internal notes</h3>
              </div>
              <NotebookPen aria-hidden="true" />
            </div>
            {view.notes.length === 0 ? (
              <div className="inline-state empty-state compact-state"><p>No internal notes have been added to this shop.</p></div>
            ) : (
              <ul className="work-list">
                {view.notes.map((note) => (
                  <li className="work-item" key={note.id}>
                    <div>
                      <strong>{note.body}</strong>
                      <span className="table-subtext">
                        By {note.author?.name || note.author?.userId || 'unknown'} · {formatDate(note.createdAt, true)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <form className="action-form" onSubmit={handleAddNote}>
              <label htmlFor="merchant-new-note">
                Add internal note
                <textarea
                  id="merchant-new-note"
                  value={noteBody}
                  onChange={(event) => setNoteBody(event.target.value)}
                  rows={3}
                  maxLength={2000}
                  required
                />
              </label>
              <button className="primary-button" type="submit" disabled={busy === 'note'}>
                {busy === 'note' ? 'Saving' : 'Add note'}
              </button>
            </form>
            {noteError ? <p className="form-error" role="alert">{noteError}</p> : null}
          </section>
        </div>

        <aside className="detail-side-column">
          <section className="content-card" aria-labelledby="mutations-title">
            <div className="section-heading compact-heading">
              <div>
                <p className="eyebrow">Super Admin</p>
                <h3 id="mutations-title">Administrative actions</h3>
              </div>
              <MessagesSquare aria-hidden="true" />
            </div>
            <p className="state-copy">
              Every action below is written to the privileged audit trail with your reason.
            </p>

            <h4 className="subsection-title">Merchant status</h4>
            <div className="action-form">
              <label htmlFor="status-reason">
                Reason for status change (required, max 300 chars)
                <textarea
                  id="status-reason"
                  value={statusReason}
                  onChange={(event) => {
                    setStatusReason(event.target.value);
                    setStatusArmed(false);
                  }}
                  rows={2}
                  maxLength={300}
                  required
                />
              </label>
              <button
                className="primary-button"
                type="button"
                disabled={busy !== null}
                onClick={() => void handleStatusToggle()}
              >
                {busy === 'status'
                  ? 'Saving'
                   : !merchantIsOperational
                    ? 'Reactivate merchant'
                    : statusArmed
                      ? 'Confirm suspend'
                      : 'Suspend merchant'}
              </button>
              {statusArmed ? <p className="field-hint">Click again to confirm the suspension.</p> : null}
            </div>

            <h4 className="subsection-title">Grant conversation credits</h4>
            <div className="action-form">
              <label htmlFor="credit-amount">
                Amount (whole number, 1 to 100,000)
                <input
                  id="credit-amount"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100000}
                  step={1}
                  value={creditAmount}
                  onChange={(event) => {
                    setCreditAmount(event.target.value);
                    setCreditArmed(false);
                  }}
                  required
                />
              </label>
              <label htmlFor="credit-reason">
                Reason for the credit grant (required, max 300 chars)
                <textarea
                  id="credit-reason"
                  value={creditReason}
                  onChange={(event) => {
                    setCreditReason(event.target.value);
                    setCreditArmed(false);
                  }}
                  rows={2}
                  maxLength={300}
                  required
                />
              </label>
              <button
                className="primary-button"
                type="button"
                disabled={busy !== null}
                onClick={() => void handleGrantCredits()}
              >
                {busy === 'credits' ? 'Saving' : creditArmed ? 'Confirm grant credits' : 'Grant credits'}
              </button>
              {creditArmed ? <p className="field-hint">Click again to confirm the credit grant.</p> : null}
            </div>

            <h4 className="subsection-title">Request Meta reconnect</h4>
            {channels.length === 0 ? (
              <p className="field-hint">No Meta channels are available to reconnect.</p>
            ) : (
              <form className="action-form" onSubmit={handleReconnect}>
                <label htmlFor="reconnect-channel">
                  Channel
                  <select
                    id="reconnect-channel"
                    value={channelId}
                    onChange={(event) => setChannelId(event.target.value)}
                    required
                  >
                    <option value="">Choose a channel…</option>
                    {channels.map((channel) => (
                      <option key={channel.id} value={channel.id}>
                        {channel.displayName || `Channel ${channel.id.slice(0, 8)}`} ({codeLabel(channel.status)})
                      </option>
                    ))}
                  </select>
                </label>
                <label htmlFor="reconnect-reason">
                  Reconnect reason (required, max 300 chars)
                  <textarea
                    id="reconnect-reason"
                    value={reconnectReason}
                    onChange={(event) => setReconnectReason(event.target.value)}
                    rows={2}
                    maxLength={300}
                    required
                  />
                </label>
                <label htmlFor="reconnect-confirm">
                  Type RECONNECT to confirm
                  <input
                    id="reconnect-confirm"
                    value={reconnectConfirm}
                    onChange={(event) => setReconnectConfirm(event.target.value)}
                    autoComplete="off"
                    required
                  />
                </label>
                <button className="primary-button" type="submit" disabled={busy !== null}>
                  {busy === 'reconnect' ? 'Submitting' : 'Send reconnect request'}
                </button>
              </form>
            )}
          </section>

        </aside>
      </div>
    </main>
  );
}
