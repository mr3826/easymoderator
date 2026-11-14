import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiError, workspaceApi, type SearchResults } from '@/api/client';
import { useGrowthAuth } from '@/auth/GrowthAuthProvider';
import { planLabel } from '@/planLabel';

const EMPTY_FEEDBACK = 'Nothing matched within your access scope. Try an exact email, phone digits, or unique shop code.';
const MAX_SEARCH_QUERY_LENGTH = 100;

function readNavigationQuery(state: unknown): string {
  if (typeof state !== 'object' || state === null || !('query' in state)) return '';
  const query = state.query;
  return typeof query === 'string' ? query.trim().slice(0, MAX_SEARCH_QUERY_LENGTH) : '';
}

const sourceLabel = (source: string) => source.replace(/_/g, ' ');

export function SearchPage() {
  const location = useLocation();
  const { reportApiError, session } = useGrowthAuth();
  const navigationQuery = readNavigationQuery(location.state);
  const [query, setQuery] = useState(navigationQuery);
  const [input, setInput] = useState(navigationQuery);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSuperAdmin = session?.role === 'SUPER_ADMIN';

  useEffect(() => {
    setInput(navigationQuery);
    setQuery(navigationQuery);
  }, [navigationQuery]);

  useEffect(() => {
    setInput(query);
    if (query.length < 2) {
      setResults(null);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    workspaceApi.search(query)
      .then((data) => { if (!cancelled) setResults(data); })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (reportApiError(err)) return;
        setError(err instanceof ApiError ? err.message : 'Search is unavailable right now.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [query, reportApiError]);

  const total = results
    ? results.prospects.length + results.merchants.length + (isSuperAdmin ? results.users.length : 0)
    : 0;

  return (
    <main className="page-content" aria-labelledby="search-title">
      <div className="page-heading detail-heading">
        <div>
          <p className="eyebrow">Internal search</p>
          <h1 id="search-title">Search</h1>
          <p className="page-lede">
            Prospects, merchants, and platform users where allowed. Result depth is decided by the server, per role.
          </p>
        </div>
      </div>

      <form
        className="global-search-form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const term = input.trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
          if (term) setQuery(term);
        }}
      >
        <label className="sr-only" htmlFor="search-page-q">Search query</label>
        <input
          id="search-page-q"
          name="q"
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value.slice(0, MAX_SEARCH_QUERY_LENGTH))}
          placeholder="Business, contact, phone, email, page URL, or code"
          maxLength={MAX_SEARCH_QUERY_LENGTH}
          minLength={2}
        />
        <button type="submit" className="primary-button" disabled={loading || input.trim().length < 2}>
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {query.length < 2 ? <p className="table-subtext">Enter at least 2 characters.</p> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {loading && query.length >= 2 ? (
        <div className="work-list" role="status" aria-label="Searching">
          <p className="skeleton-row" />
          <p className="skeleton-row" />
          <p className="skeleton-row" />
        </div>
      ) : null}
      {!loading && !error && results && total === 0 && query.length >= 2 ? (
        <p className="table-subtext">{EMPTY_FEEDBACK}</p>
      ) : null}

      {!loading && results && total > 0 ? (
        <>
          {results.prospects.length > 0 ? (
            <section className="search-group" aria-label="Prospect results">
              <h2>Prospects</h2>
              <ul className="work-list">
                {results.prospects.map((prospect) => (
                  <li key={prospect.prospectId} className="work-item content-card">
                    <div>
                      <Link to={`/prospects/${prospect.prospectId}`}>
                        {prospect.businessName || prospect.prospectId}
                      </Link>{' '}
                      <span className={`status-badge status-${prospect.status}`}>{prospect.status}</span>
                      <p className="table-subtext">
                        {sourceLabel(prospect.source)}
                        {prospect.contactEmail ? ` · ${prospect.contactEmail}` : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {results.merchants.length > 0 ? (
            <section className="search-group" aria-label="Merchant results">
              <h2>Merchants</h2>
              <ul className="work-list">
                {results.merchants.map((merchant) => (
                  <li key={merchant.shopId} className="work-item content-card">
                    <div>
                      <Link to={`/merchants/${merchant.shopId}`}>{merchant.merchantName || merchant.shopId}</Link>
                      <p className="table-subtext">
                        {planLabel(merchant.planName)}
                        {merchant.owner?.email ? ` · ${merchant.owner.email}` : ''}
                        {typeof merchant.activated === 'boolean'
                          ? ` · ${merchant.activated ? 'activated' : 'not activated'}`
                          : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {isSuperAdmin && results.users.length > 0 ? (
            <section className="search-group" aria-label="Platform user results">
              <h2>Users</h2>
              <ul className="work-list">
                {results.users.map((user) => (
                  <li key={user.userId} className="work-item content-card">
                    <div>
                      <Link to="/growth-users" state={{ search: user.email }}>
                        {user.displayName || user.email}
                      </Link>
                      <p className="table-subtext">{user.email}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
