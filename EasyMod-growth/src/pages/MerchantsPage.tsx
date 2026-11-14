import { useEffect, useState, type FormEvent } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  merchantsApi,
  type MerchantAdminRow,
  type MerchantInsightRow,
  type Paginated,
} from '@/api/client';
import { usePermission } from '@/auth/usePermission';
import { useGrowthAuth } from '@/auth/GrowthAuthProvider';
import { planLabel } from '@/planLabel';

const PAGE_SIZE = 25;

function codeLabel(value: string) {
  return value.replace(/_/g, ' ');
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'Not provided';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function StatusBadge({ value }: { value: string | null }) {
  if (!value) return <span className="status-badge">Unknown</span>;
  return (
    <span className={`status-badge status-${value.toLowerCase().replace(/_/g, '-')}`}>
      {codeLabel(value)}
    </span>
  );
}

function usageSummary(used: number | null, limit: number | null) {
  if (used === null && limit === null) return 'Not provided';
  return `${used ?? '—'} of ${limit ?? '—'}`;
}

function serverMessage(error: unknown, fallback: string) {
  const raw = error instanceof Error && error.message.trim() ? error.message : fallback;
  return raw.replace(/[<>]/g, '').slice(0, 400);
}

function LoadingRows() {
  return (
    <div className="list-skeleton" aria-label="Loading merchants">
      {['one', 'two', 'three', 'four', 'five'].map((row) => <div className="skeleton-row" key={row} />)}
    </div>
  );
}

export function MerchantsPage() {
  const isAdmin = usePermission('growth_os.admin.merchants.read');
  const { reportApiError } = useGrowthAuth();
  const [searchDraft, setSearchDraft] = useState('');
  const [searchApplied, setSearchApplied] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Paginated<MerchantAdminRow | MerchantInsightRow> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    merchantsApi.list({
      ...(searchApplied ? { search: searchApplied } : {}),
      page,
      pageSize: PAGE_SIZE,
    })
      .then((nextResult) => {
        if (active) setResult(nextResult);
      })
      .catch((requestError: unknown) => {
        if (!active || reportApiError(requestError)) return;
        setError(serverMessage(requestError, 'Unable to load merchants. Please try again.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [isAdmin, searchApplied, page, reloadToken, reportApiError]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPage(1);
    setSearchApplied(searchDraft.trim());
  }

  const adminRows = isAdmin
    ? (result?.items ?? []).filter((row): row is MerchantAdminRow => !('shopId' in row))
    : [];
  const insightRows = isAdmin
    ? []
    : (result?.items ?? []).filter((row): row is MerchantInsightRow => 'shopId' in row);
  const rows = isAdmin ? adminRows : insightRows;
  const total = result?.total ?? 0;
  const pageSize = result?.pageSize ?? result?.limit ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <main className="page-content" aria-labelledby="merchants-title">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Control plane</p>
          <h2 id="merchants-title">Merchants</h2>
          {isAdmin ? (
            <p className="page-lede">
              Full merchant records with ownership, plan, and conversation usage limits.
            </p>
          ) : (
            <p className="page-lede">
              Limited, masked merchant context for growth work. Owner contact details, shop
              identifiers, and usage limits are hidden by design.
            </p>
          )}
        </div>
      </div>

      <section className="content-card filter-card" aria-labelledby="merchant-search-title">
        <div className="section-heading compact-heading">
          <div>
            <p className="eyebrow">Find a record</p>
            <h3 id="merchant-search-title">Search</h3>
          </div>
          <Search aria-hidden="true" />
        </div>
        <form className="filter-form" onSubmit={submitSearch}>
          <label htmlFor="merchant-query">
            Search merchants
            <span className="input-with-icon">
              <Search aria-hidden="true" />
              <input
                id="merchant-query"
                type="search"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder={isAdmin ? 'Shop name, owner, or code' : 'Merchant name'}
              />
            </span>
          </label>
          <div className="filter-actions">
            <button className="primary-button" type="submit">Apply search</button>
          </div>
        </form>
      </section>

      <section className="content-card" aria-labelledby="merchant-results-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{isAdmin ? 'Full admin records' : 'Masked insight records'}</p>
            <h3 id="merchant-results-title">
              {loading ? 'Loading merchants' : `${total.toLocaleString()} merchant${total === 1 ? '' : 's'}`}
            </h3>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Refresh merchants"
            title="Refresh merchants"
            onClick={() => setReloadToken((current) => current + 1)}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>

        {loading ? <LoadingRows /> : null}
        {!loading && error ? (
          <div className="inline-state error-state" role="alert">
            <strong>Merchants could not be loaded.</strong>
            <p>{error}</p>
            <button className="secondary-button" type="button" onClick={() => setReloadToken((current) => current + 1)}>
              Try again
            </button>
          </div>
        ) : null}
        {!loading && !error && rows.length === 0 ? (
          <div className="inline-state empty-state">
            <strong>No merchants match this search.</strong>
            <p>Adjust the search or check back after new signups land in the control plane.</p>
          </div>
        ) : null}
        {!loading && !error && rows.length > 0 ? (
          <>
            <div className="table-scroll">
              {isAdmin ? (
                <table className="data-table">
                  <caption className="sr-only">Merchants with full admin context</caption>
                  <thead>
                    <tr>
                      <th scope="col">Shop</th>
                      <th scope="col">Owner</th>
                      <th scope="col">Plan</th>
                      <th scope="col">Status</th>
                      <th scope="col">Conversations</th>
                      <th scope="col">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {adminRows.map((row) => (
                      <tr key={row.id}>
                        <th scope="row">
                          <Link className="table-link" to={`/merchants/${encodeURIComponent(row.id)}`}>
                            {row.shopName || 'Unnamed shop'}
                          </Link>
                          <span className="table-subtext">{row.channelCount} channel{row.channelCount === 1 ? '' : 's'}</span>
                        </th>
                        <td>
                          {row.owner?.name || 'Name not provided'}
                          <span className="table-subtext">{row.owner?.email || 'No email provided'}</span>
                        </td>
                        <td>{row.plan ? codeLabel(row.plan) : 'No plan'}</td>
                        <td><StatusBadge value={row.status} /></td>
                        <td>{usageSummary(row.conversationsUsed, row.conversationsLimit)}</td>
                        <td>{formatDate(row.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="data-table">
                  <caption className="sr-only">Masked merchant insight for growth work</caption>
                  <thead>
                    <tr>
                      <th scope="col">Merchant</th>
                      <th scope="col">Sign-up date</th>
                      <th scope="col">Plan</th>
                      <th scope="col">Activated</th>
                      <th scope="col">Facebook</th>
                      <th scope="col">Linked prospects</th>
                    </tr>
                  </thead>
                  <tbody>
                    {insightRows.map((row) => (
                      <tr key={row.shopId}>
                        <th scope="row">
                          <Link className="table-link" to={`/merchants/${encodeURIComponent(row.shopId)}`}>
                            {row.merchantName || 'Unnamed merchant'}
                          </Link>
                        </th>
                        <td>{formatDate(row.signupDate)}</td>
                        <td>{planLabel(row.planName)}</td>
                        <td>{row.activatedAt ? formatDate(row.activatedAt) : 'Not activated'}</td>
                        <td>
                          <StatusBadge value={row.facebookConnected ? 'connected' : 'not-connected'} />
                        </td>
                        <td>{row.linkedProspects.length > 0 ? row.linkedProspects.join(' · ') : 'None'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div className="pagination" aria-label="Merchant pages">
              <span>Page {result?.page ?? page} of {totalPages}</span>
              <div className="pagination-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Previous
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        ) : null}
      </section>

      <p className="field-hint">
        {isAdmin
          ? 'Suspend status, grants, and channel actions are available from each merchant record and are audit-logged.'
          : 'Open a merchant for masked context that supports growth conversations without exposing owner data.'}
      </p>
    </main>
  );
}
