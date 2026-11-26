/**
 * Tab 1 — "Payment Methods" (Payment Settings redesign; contract §1/§2/§6/§7).
 *
 * One COD row (single, credential-free) plus a row per wallet provider
 * (bKash / Nagad / Rocket); each provider row expands to its configured
 * accounts (self + business channels where legal, merchant_gateway for bKash
 * only). Every card carries its OWN honest verification chip — never colour,
 * never an implied provider check (§7 row 3; R-12). Enable/disable is gated on
 * required config only. Exactly one preferred account per shop is shown (D-8:
 * `payment_accounts.is_preferred` is DB truth; setting a new one clears the old
 * server-side, so the UI asserts the invariant rather than reordering the legacy
 * `platform_priority` PUT).
 *
 * The heavier per-account work (credentials, replace-by-entry, the rate-limited
 * credential check, go-live certification) lives in {@link AccountDrawer}.
 * Every mutation reloads from the server through `onMutate` so nothing is ever
 * claimed done before the server confirms it (§4); a failed reload keeps the
 * last known state and surfaces an honest error banner rather than pretending.
 *
 * Data is owned by the shell (loaded + reloaded there); this tab only dispatches
 * account CRUD through the documented `paymentClient` seam. No page-summary
 * paragraph (§3 "remove page summaries") — the shell header carries the facts.
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MotionConfig } from 'motion/react';
import {
  ChevronDown,
  ChevronUp,
  Plus,
  Star,
  Settings2,
  Trash2,
  Wallet,
  Banknote,
  TriangleAlert,
} from 'lucide-react';
import { EmButton } from '../dashboard/EmButton';
import { ResultBanner } from '../dashboard/ResultBanner';
import { useDialogFocus } from '../inbox/useDialogFocus';
import { getErrorMessage } from '@shared/lib/http/errors';
import { paymentClient } from './paymentClient';
import { VerificationChip } from './VerificationChip';
import AccountDrawer from './AccountDrawer';
import type { AccountType, PaymentAccountView, Provider } from './taxonomy';
import {
  WALLET_PROVIDERS,
  accountTypeDefaultLabel,
  accountTypeKey,
  providerDefaultLabel,
  providerNameKey,
} from './taxonomy';

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';
const MASK = '••••••••';

type DrawerState =
  | { mode: 'create'; provider: Provider }
  | { mode: 'edit'; provider: Provider; account: PaymentAccountView }
  | null;

export interface MethodsTabProps {
  accounts: PaymentAccountView[];
  /** Reload after a server-confirmed mutation (shell-owned fetch). */
  onMutate?: () => void | Promise<void>;
}

export default function MethodsTab({ accounts, onMutate }: MethodsTabProps) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [busy, setBusy] = useState<string | null>(null); // accountId or 'cod'
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PaymentAccountView | null>(null);
  const deleteRef = useRef<HTMLDivElement>(null);
  useDialogFocus(deleteRef, Boolean(deleteTarget));

  const numberFormat = useMemo(
    () => new Intl.NumberFormat(i18n.language?.toLowerCase().startsWith('bn') ? 'bn-BD' : 'en-US'),
    [i18n.language],
  );

  const codAccounts = accounts.filter((a) => a.provider === 'cod');
  const byProvider = (p: Provider) => accounts.filter((a) => a.provider === p);

  const reload = async () => {
    try {
      await onMutate?.();
    } catch {
      // Shell owns the load error surface; a failed reload keeps last-known state.
    }
  };

  const runAction = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err: unknown) {
      setError(getErrorMessage(err, t(`manageShop.paymentSettings.errors.toggleFailed`)));
    } finally {
      setBusy(null);
    }
  };

  // ── COD enable/disable (creates the single cod row on first enable) ─────────
  const toggleCod = async () => {
    const cod = codAccounts[0];
    const next = !(cod?.is_enabled ?? false);
    setError(null);
    try {
      if (cod) await paymentClient.updatePaymentAccount(cod.id, { is_enabled: next });
      else await paymentClient.savePaymentAccount({ provider: 'cod', account_type: 'standard', is_enabled: next, config: {} });
      await reload();
    } catch (err: unknown) {
      setError(getErrorMessage(err, t(`manageShop.paymentSettings.errors.toggleFailed`)));
    }
  };

  // ── Wallet account enable/disable (gated on credentials only, §7 row 3) ─────
  const toggleAccountEnabled = async (account: PaymentAccountView) => {
    const hasCredentials = account.credential_summary?.has_credentials === true;
    if (!account.is_enabled && !hasCredentials) return; // honest gate; toggle is disabled anyway
    await runAction(account.id, () => paymentClient.updatePaymentAccount(account.id, { is_enabled: !account.is_enabled }));
  };

  const setPreferred = async (account: PaymentAccountView) => {
    if (account.is_preferred || !account.is_enabled) return; // single preferred; server clears others
    await runAction(account.id, () => paymentClient.setPreferredAccount(account.id));
  };

  const requestDelete = (account: PaymentAccountView) => setDeleteTarget(account);
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    await runAction(id, () => paymentClient.deletePaymentAccount(id));
  };

  const expandKeyFor = (p: Provider) => {
    setExpanded((prev) => ({ ...prev, [p]: !prev[p] }));
  };

  const existingChannelsFor = (p: Provider): AccountType[] =>
    byProvider(p).map((a) => a.account_type).filter((c): c is AccountType => Boolean(c));

  return (
    <MotionConfig reducedMotion="user">
      {/* NOTE: no `em-payment` here — the scope class belongs to the workspace
          root ONLY (PaymentWorkspace.tsx); re-wrapping here double-scoped the
          token layer and the e2e axe/em-payment selectors. */}
      <div className="space-y-4" data-testid="methods-tab">
        {error && (
          <ResultBanner
            status="error"
            title={t(`manageShop.paymentSettings.accounts.actionFailedTitle`, { defaultValue: 'Action not completed' })}
            description={error}
          />
        )}

        {/* ── COD row (single) ───────────────────────────────────────────────── */}
        <div className="rounded-xl border border-em-border bg-em-bg-surface p-5" data-testid="method-row-cod">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-em-success-100 text-em-success-700">
                <Banknote className="h-6 w-6" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-em-text-primary">{t(`manageShop.paymentSettings.codName`)}</h3>
                {codAccounts[0] ? (
                  <VerificationChip account={codAccounts[0]} />
                ) : (
                  <p className="mt-1 text-xs text-em-text-secondary">
                    {t(`manageShop.paymentSettings.ladder.cod`, { defaultValue: 'No verification needed — cash on delivery.' })}
                  </p>
                )}
                <p className="mt-1 text-xs text-em-text-secondary">
                  {t(`manageShop.paymentSettings.accounts.codAvailability`, { defaultValue: 'Cash availability per delivery zone is set in Delivery Settings.' })}
                </p>
              </div>
            </div>
            <Switch
              checked={codAccounts[0]?.is_enabled ?? false}
              busy={busy === 'cod'}
              label={t(`manageShop.paymentSettings.codName`)}
              disabledReason={undefined}
              onToggle={toggleCod}
            />
          </div>
        </div>

        {/* ── Wallet provider rows ───────────────────────────────────────────── */}
        {WALLET_PROVIDERS.map((provider) => {
          const list = byProvider(provider);
          const enabledCount = list.filter((a) => a.is_enabled).length;
          const isOpen = Boolean(expanded[provider]);
          const preferredHere = list.some((a) => a.is_preferred);

          return (
            <div key={provider} className="rounded-xl border border-em-border bg-em-bg-surface" data-testid={`method-row-${provider}`}>
              <div className="flex items-center gap-3 p-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-em-violet-100 text-em-violet-700">
                  <Wallet className="h-5 w-5" aria-hidden="true" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-em-text-primary">
                      {t(providerNameKey(provider), { defaultValue: providerDefaultLabel(provider) })}
                    </h3>
                    <span className="em-tabular whitespace-nowrap rounded-full border border-em-border bg-em-bg-muted px-2 py-0.5 text-xs font-medium text-em-text-secondary">
                      {t(`manageShop.paymentSettings.accounts.enabledCount`, {
                        count: enabledCount,
                        formatted: numberFormat.format(enabledCount),
                        defaultValue: `${numberFormat.format(enabledCount)} enabled`,
                      })}
                    </span>
                    {preferredHere && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-em-violet-100 px-2 py-0.5 text-xs font-semibold text-em-violet-700" data-testid={`preferred-badge-${provider}`}>
                        <Star className="h-3 w-3 fill-current" aria-hidden="true" />
                        {t(`manageShop.paymentSettings.accounts.preferred`, { defaultValue: 'Preferred' })}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-em-text-secondary">
                    {t(`manageShop.paymentSettings.accounts.accountsCount`, {
                      count: list.length,
                      formatted: numberFormat.format(list.length),
                      defaultValue: `${numberFormat.format(list.length)} account(s) configured`,
                    })}
                  </p>
                </div>
                <EmButton
                  variant="ghost"
                  className="gap-1.5"
                  onClick={() => setDrawer({ mode: 'create', provider })}
                  data-testid={`add-account-${provider}`}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">{t(`manageShop.paymentSettings.accounts.add`, { defaultValue: 'Add account' })}</span>
                </EmButton>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-label={t(`manageShop.paymentSettings.accounts.expandProvider`, {
                    name: t(providerNameKey(provider), { defaultValue: providerDefaultLabel(provider) }),
                    defaultValue: `Show ${providerDefaultLabel(provider)} accounts`,
                  })}
                  onClick={() => expandKeyFor(provider)}
                  className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-bg-muted ${FOCUS_RING}`}
                  data-testid={`expand-${provider}`}
                >
                  {isOpen ? <ChevronUp className="h-5 w-5" aria-hidden="true" /> : <ChevronDown className="h-5 w-5" aria-hidden="true" />}
                </button>
              </div>

              {isOpen && (
                <div className="space-y-3 border-t border-em-border p-4" data-testid={`accounts-panel-${provider}`}>
                  {list.length === 0 && (
                    <p className="text-sm text-em-text-secondary">
                      {t(`manageShop.paymentSettings.accounts.noneConfigured`, { defaultValue: 'No accounts yet. Add one to offer this method to customers.' })}
                    </p>
                  )}
                  {list.map((account) => (
                    <AccountCard
                      key={account.id}
                      account={account}
                      busy={busy === account.id}
                      onToggleEnabled={() => toggleAccountEnabled(account)}
                      onSetPreferred={() => setPreferred(account)}
                      onManage={() => setDrawer({ mode: 'edit', provider, account })}
                      onDelete={() => requestDelete(account)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {drawer && (
          <AccountDrawer
            mode={drawer.mode}
            provider={drawer.provider}
            account={drawer.mode === 'edit' ? drawer.account : undefined}
            existingChannels={existingChannelsFor(drawer.provider)}
            onClose={() => setDrawer(null)}
            onSaved={reload}
          />
        )}

        {deleteTarget && (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-em-midnight-950/60 p-4"
            onClick={(event) => { if (event.target === event.currentTarget) setDeleteTarget(null); }}
          >
            <div
              ref={deleteRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-account-title"
              onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setDeleteTarget(null); } }}
              className="w-full max-w-md rounded-xl bg-em-bg-surface p-5 shadow-xl md:p-6"
            >
              <div className="flex items-start gap-3">
                <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-em-danger-700" aria-hidden="true" />
                <div>
                  <h3 id="delete-account-title" className="text-lg font-semibold text-em-text-primary">
                    {t(`manageShop.paymentSettings.delete.title`, { defaultValue: 'Delete this payment account?' })}
                  </h3>
                  <p className="mt-2 text-sm text-em-text-secondary" data-testid="delete-account-body">
                    {/* F4: TRUE semantics — the server refuses deletion while payment
                        records are unresolved (409), and the orders/payment_transactions
                        FK is ON DELETE SET NULL: transaction records persist, the link
                        to THIS account entry becomes NULL. Never claim attribution is
                        kept when the link is nulled. */}
                    {t(`manageShop.paymentSettings.delete.body`, {
                      name: deleteTarget.provider ? t(providerNameKey(deleteTarget.provider), { defaultValue: deleteTarget.provider }) : '',
                      type: deleteTarget.account_type ? t(accountTypeKey(deleteTarget.account_type), { defaultValue: accountTypeDefaultLabel(deleteTarget.account_type) }) : '',
                      defaultValue: 'Accounts with pending or unclosed payment records cannot be deleted until those are resolved. After a deletion, historical orders keep their payment transaction records but no longer link to this account entry.',
                    })}
                  </p>
                </div>
              </div>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
                <EmButton variant="secondary" onClick={() => setDeleteTarget(null)}>
                  {t('common.cancel')}
                </EmButton>
                <EmButton
                  variant="danger"
                  onClick={() => void confirmDelete()}
                  data-testid="confirm-delete-account"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  {t('common.delete', { defaultValue: 'Delete' })}
                </EmButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </MotionConfig>
  );
}

// ── Account card (one configured account) ─────────────────────────────────────
interface AccountCardProps {
  account: PaymentAccountView;
  busy: boolean;
  onToggleEnabled: () => void;
  onSetPreferred: () => void;
  onManage: () => void;
  onDelete: () => void;
}

function AccountCard({ account, busy, onToggleEnabled, onSetPreferred, onManage, onDelete }: AccountCardProps) {
  const { t } = useTranslation();
  const isGateway = account.account_type === 'merchant_gateway';
  const hasCredentials = account.credential_summary?.has_credentials === true;
  const enableDisabled = !account.is_enabled && !hasCredentials;

  const summary = isGateway
    ? (hasCredentials
        ? t(`manageShop.paymentSettings.accounts.gatewayStored`, { defaultValue: 'Merchant API secrets are never shown' })
        : t(`manageShop.paymentSettings.accounts.noCredentials`, { defaultValue: 'No credentials saved yet' }))
    : (hasCredentials
        ? (account.credential_summary?.mfs_number || MASK)
        : t(`manageShop.paymentSettings.accounts.noCredentials`, { defaultValue: 'No credentials saved yet' }));

  return (
    <div className="rounded-lg border border-em-border bg-em-bg-surface p-4" data-testid={`account-card-${account.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-em-text-primary">
              {t(accountTypeKey(account.account_type ?? 'self'), { defaultValue: accountTypeDefaultLabel(account.account_type ?? 'self') })}
            </span>
            {account.is_preferred && (
              <span className="inline-flex items-center gap-1 rounded-full bg-em-violet-100 px-2 py-0.5 text-xs font-semibold text-em-violet-700" data-testid={`preferred-star-${account.id}`}>
                <Star className="h-3 w-3 fill-current" aria-hidden="true" />
                {t(`manageShop.paymentSettings.accounts.preferred`, { defaultValue: 'Preferred' })}
              </span>
            )}
          </div>
          <p className="em-tabular mt-1 break-all font-mono text-sm text-em-text-primary" aria-label={t(`manageShop.paymentSettings.accounts.storedValue`, { defaultValue: 'Stored value' })}>
            {summary}
          </p>
        </div>
        <Switch
          checked={account.is_enabled}
          busy={busy}
          label={`${t(accountTypeKey(account.account_type ?? 'self'), { defaultValue: accountTypeDefaultLabel(account.account_type ?? 'self') })}`}
          disabledReason={enableDisabled ? t(`manageShop.paymentSettings.saveConfigFirst`) : undefined}
          onToggle={onToggleEnabled}
        />
      </div>

      <div className="mt-2">
        <VerificationChip account={account} />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          role="radio"
          aria-checked={account.is_preferred}
          aria-label={t(`manageShop.paymentSettings.accounts.setPreferred`, { defaultValue: 'Set as preferred' })}
          disabled={account.is_preferred || !account.is_enabled || busy}
          title={
            account.is_preferred
              ? t(`manageShop.paymentSettings.accounts.alreadyPreferred`, { defaultValue: 'Already preferred' })
              : !account.is_enabled
                ? t(`manageShop.paymentSettings.accounts.preferredNeedsEnabled`, { defaultValue: 'Enable this account before setting it preferred' })
                : undefined
          }
          onClick={onSetPreferred}
          className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border text-sm ${FOCUS_RING} ${
            account.is_preferred
              ? 'border-em-violet-600 bg-em-violet-600 text-white'
              : 'border-em-border-strong bg-em-bg-surface text-em-text-secondary hover:border-em-violet-300 disabled:opacity-40 disabled:cursor-not-allowed'
          }`}
          data-testid={`preferred-toggle-${account.id}`}
        >
          <Star className={`h-4 w-4 ${account.is_preferred ? 'fill-current' : ''}`} aria-hidden="true" />
        </button>
        <EmButton variant="secondary" className="gap-2" onClick={onManage} disabled={busy} data-testid={`manage-${account.id}`}>
          <Settings2 className="h-4 w-4" aria-hidden="true" />
          {t('common.manage', { defaultValue: 'Manage' })}
        </EmButton>
        <EmButton variant="ghost" className="ml-auto gap-2 text-em-danger-700" onClick={onDelete} disabled={busy} data-testid={`delete-${account.id}`}>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">{t('common.delete', { defaultValue: 'Delete' })}</span>
        </EmButton>
      </div>
    </div>
  );
}

// ── Switch primitive (44px target, aria-checked, honest disabled title) ───────
interface SwitchProps {
  checked: boolean;
  busy: boolean;
  label: string;
  disabledReason?: string;
  onToggle: () => void;
}

function Switch({ checked, busy, label, disabledReason, onToggle }: SwitchProps) {
  const { t } = useTranslation();
  const disabled = busy || Boolean(disabledReason);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={disabledReason ?? t(`manageShop.paymentSettings.toggleActivateTitle`)}
      disabled={disabled}
      onClick={onToggle}
      className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-full ${FOCUS_RING} ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
      }`}
    >
      <span className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full ${checked ? 'bg-em-violet-600' : 'bg-em-border-strong'}`}>
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
      </span>
    </button>
  );
}
