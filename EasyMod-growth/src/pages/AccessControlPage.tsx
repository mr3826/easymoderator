import { useEffect, useState } from 'react';
import { LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { growthUsersApi, type GrowthUserRow } from '@/api/client';
import { useGrowthAuth } from '@/auth/GrowthAuthProvider';

function serverMessage(error: unknown, fallback: string) {
  const raw = error instanceof Error && error.message.trim() ? error.message : fallback;
  return raw.replace(/[<>]/g, '').slice(0, 400);
}

export function AccessControlPage() {
  const { reportApiError } = useGrowthAuth();
  const [users, setUsers] = useState<GrowthUserRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    growthUsersApi.list()
      .then((nextUsers) => {
        if (active) setUsers(nextUsers);
      })
      .catch((requestError: unknown) => {
        if (!active || reportApiError(requestError)) return;
        setError(serverMessage(requestError, 'Unable to load current access counts.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reloadToken, reportApiError]);

  const rows = users ?? [];
  const superAdmins = rows.filter((user) => user.role === 'SUPER_ADMIN').length;
  const growthUsers = rows.filter((user) => user.role === 'GROWTH_USER').length;
  const active = rows.filter((user) => user.status === 'active').length;
  const suspended = rows.filter((user) => user.status === 'suspended').length;
  const revoked = rows.filter((user) => user.status === 'revoked').length;

  return (
    <main className="page-content" aria-labelledby="access-control-title">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Read-only overview</p>
          <h2 id="access-control-title">Access control</h2>
          <p className="page-lede">
            How Growth OS authorization works today, and who currently holds access. Nothing on
            this page changes policy; manage grants from the Growth users page.
          </p>
        </div>
      </div>

      <section className="content-card" aria-labelledby="roles-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Two-role model</p>
            <h3 id="roles-title">What each role can do</h3>
          </div>
          <ShieldCheck aria-hidden="true" />
        </div>
        <div className="attention-grid">
          <div className="content-card attention-card">
            <p className="eyebrow panel-heading">Super Admin — SUPER_ADMIN</p>
            <ul className="work-list">
              <li>Everything a Growth user can do inside the growth workspace.</li>
              <li>Admin merchant records: full 360 view, owner identity, and usage limits.</li>
              <li>Main-app mutations via approved services: merchant status, conversation
                credit grants and Meta reconnect requests — each
                reason-required and audit-logged.</li>
              <li>Growth user management: grants, role changes, suspension, revocation,
                password resets, and session revocation.</li>
              <li>Operations snapshot and privileged audit trail.</li>
            </ul>
          </div>
          <div className="content-card attention-card">
            <p className="eyebrow panel-heading">Growth User — GROWTH_USER</p>
            <ul className="work-list">
              <li>Full growth workspace: prospects, capture, follow-ups, and search.</li>
              <li>Masked, read-only merchant insight for conversation context.</li>
              <li>No mutations against merchants, channels, AI, or subscription state.</li>
              <li>No user administration, operations metrics, or audit access.</li>
              <li>Admin navigation is hidden and the server rejects admin-only calls.</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="content-card" aria-labelledby="security-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Enforced by the server</p>
            <h3 id="security-title">Key security facts</h3>
          </div>
          <LockKeyhole aria-hidden="true" />
        </div>
        <ul className="work-list">
          <li className="work-item"><span>There is no self-registration. Growth OS access is granted only by a Super Admin.</span></li>
          <li className="work-item"><span>TOTP is optional; Growth access is authorized by an active role plus the endpoint permission.</span></li>
          <li className="work-item"><span>Revoked users are denied server-side, even with a stale browser session.</span></li>
          <li className="work-item"><span>Each user holds exactly one active Growth OS role at a time.</span></li>
          <li className="work-item"><span>The last Super Admin cannot be demoted, suspended, or revoked — the API returns a clear 409 conflict.</span></li>
          <li className="work-item"><span>Privileged mutations require a written reason and are recorded in the audit trail.</span></li>
        </ul>
      </section>

      <section className="content-card" aria-labelledby="populations-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Current population</p>
            <h3 id="populations-title">Access counts</h3>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Refresh access counts"
            title="Refresh access counts"
            onClick={() => setReloadToken((current) => current + 1)}
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>

        {loading ? (
          <div className="list-skeleton" aria-label="Loading access counts">
            <div className="skeleton-row" />
            <div className="skeleton-row" />
          </div>
        ) : null}
        {!loading && error ? (
          <div className="inline-state error-state" role="alert">
            <strong>Access counts could not be loaded.</strong>
            <p>{error}</p>
            <button className="secondary-button" type="button" onClick={() => setReloadToken((current) => current + 1)}>
              Try again
            </button>
          </div>
        ) : null}
        {!loading && !error ? (
          <>
            {rows.length === 0 ? (
              <div className="inline-state empty-state compact-state">
                <p>No Growth OS users have been granted access yet.</p>
              </div>
            ) : null}
            <dl className="detail-facts">
              <div><dt>Total users</dt><dd>{rows.length}</dd></div>
              <div><dt>Super Admins</dt><dd>{superAdmins}</dd></div>
              <div><dt>Growth users</dt><dd>{growthUsers}</dd></div>
              <div><dt>Active</dt><dd>{active}</dd></div>
              <div><dt>Suspended</dt><dd>{suspended}</dd></div>
              <div><dt>Revoked</dt><dd>{revoked}</dd></div>
            </dl>
          </>
        ) : null}
        <p className="field-hint">
          To change grants or roles, use the{' '}
          <Link className="table-link" to="/growth-users">Growth users page</Link>.
        </p>
      </section>
    </main>
  );
}
