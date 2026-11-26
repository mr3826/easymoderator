/**
 * Right-side drawer for one payment ACCOUNT (create or edit) — the per-account
 * config the Methods tab delegates here (guardrails §5.6/§12/§17; contract §2).
 *
 * Honesty rules this drawer is responsible for:
 * - Merchant API secrets (app_key/app_secret/username/password) are NEVER
 *   re-hydrated from the server — those inputs always start blank. Changing a
 *   gateway credential is "replace-by-entry": the merchant types new values and
 *   an explicit warning states that saving replaces the stored credentials and
 *   resets verification (§2 credential-change demotion). §8.3 "add/replace flow
 *   never echoes secrets".
 * - The wallet number (the receiver number customers pay to) is NOT a secret and
 *   is shown/editable through {@link BDPhoneInput} (§3.2 single-number display).
 * - Enable/disable is gated on REQUIRED CONFIG only and never implies a provider
 *   check (§7 row 3). The verification chip (owned by the row/drawer header)
 *   carries the honest level.
 * - The only provider-touching affordance is the owner "Check credentials"
 *   action (§2.1, rate-limited by bKash to 2/hour); it renders the SERVER verdict
 *   honestly (CREDENTIALS_VALID / SANDBOX_VERIFIED / 429 cooldown / 501 not-yet
 *   wired) and never labels it "verified with provider". certify-live records an
 *   owner evidence note only, and — per the A9-R2 rewrite of §2.3 — it mirrors
 *   the server contract exactly: the certify field renders for a bKash
 *   merchant_gateway row whose STORED config.environment is explicitly
 *   'production' and whose verification level is a certifiable rung
 *   (unverified / configured_unverified / sandbox_verified; the old
 *   sandbox_verified prerequisite is REMOVED, live_certified is refused
 *   server-side and hidden here). While the recorded environment is not
 *   production the drawer shows an honest CTA instead of a dead-end button,
 *   stating that switching resets the verification ladder — the server's own
 *   400 PROVIDER_ENVIRONMENT_NOT_PRODUCTION message instructs exactly that
 *   path, and the switch→save→reopen→certify flow is reachable in one flow.
 *
 * The drawer traps/restores focus and collapses its slide in unit tests via
 * `ANIMATE`, mirroring `delivery/ProviderDrawer`.
 */
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion, MotionConfig } from 'motion/react';
import { X, Lock, PhoneCall, ShieldCheck, CircleDashed } from 'lucide-react';
import { EmButton } from '../dashboard/EmButton';
import { ResultBanner } from '../dashboard/ResultBanner';
import { useDialogFocus } from '../inbox/useDialogFocus';
import { BDPhoneInput, BD_PHONE_REGEX } from '@/shared/components/BDPhoneInput';
import { getErrorMessage } from '@shared/lib/http/errors';
import { paymentClient } from './paymentClient';
import { VerificationChip } from './VerificationChip';
import type { AccountType, PaymentAccountView, Provider } from './taxonomy';
import {
  GATEWAY_ACCOUNT_TYPE,
  WALLET_PROVIDERS,
  accountTypeDefaultLabel,
  accountTypeKey,
  channelsForProvider,
  providerDefaultLabel,
  providerNameKey,
} from './taxonomy';

const ANIMATE = import.meta.env.MODE !== 'test';

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';

const INPUT_CLASSES =
  `w-full min-h-11 border border-em-border-input rounded-lg bg-em-bg-surface px-3 py-2 text-sm text-em-text-primary focus:outline-none ${FOCUS_RING}`;

/**
 * Mirror of CERTIFIABLE_RUNGS in the backend certifyLiveAccount
 * (payment-verification.service.js:315, A9-R2). `live_certified` and any
 * unknown/archived rung are deliberately absent — the server refuses them.
 */
const CERTIFIABLE_RUNGS: readonly string[] = ['unverified', 'configured_unverified', 'sandbox_verified'];

export interface AccountDrawerProps {
  mode: 'create' | 'edit';
  /** Provider context (create: preselected; edit: fixed). */
  provider: Provider;
  /** Lock provider selection (opened from a provider row). */
  lockProvider?: boolean;
  /** The account being edited (edit mode). */
  account?: PaymentAccountView;
  /** Channels already configured for the chosen provider (create only). */
  existingChannels?: AccountType[];
  onClose: () => void;
  /** Reload after a server-confirmed save (shell-owned fetch). */
  onSaved: () => void | Promise<void>;
}

export function AccountDrawer({
  mode,
  provider: initialProvider,
  lockProvider = false,
  account,
  existingChannels = [],
  onClose,
  onSaved,
}: AccountDrawerProps) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(panelRef, true);

  const isEdit = mode === 'edit' && Boolean(account);
  const isGateway = (p: Provider, type: AccountType | null) => p === 'bkash' && type === GATEWAY_ACCOUNT_TYPE;

  const [provider, setProvider] = useState<Provider>(initialProvider);
  const walletProviders = useMemo<Provider[]>(() => [...WALLET_PROVIDERS], []);

  // Account channel. Create defaults to the first legal, unconfigured channel.
  const availableChannels = useMemo(
    () => channelsForProvider(provider).filter((c) => !existingChannels.includes(c)),
    [provider, existingChannels],
  );
  const [accountType, setAccountType] = useState<AccountType>(
    isEdit ? (account?.account_type ?? 'self') : (availableChannels[0] ?? 'self'),
  );

  // Wallet fields — number is displayable; never a secret.
  const [number, setNumber] = useState(isEdit ? (account?.credential_summary?.mfs_number ?? '') : '');
  // Gateway secret fields — ALWAYS start blank (never re-hydrated, §8.3).
  const [appKey, setAppKey] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // A0 ruling (spec-audit #7): the environment selection is REAL — it persists
  // to account.config.environment, which bkash-tokenized.resolveEnvironment()
  // reads for the sandbox handshake / production grant split (§2.2). Edit mode
  // hydrates from the stored config; create defaults to sandbox because the
  // certification ladder starts there (§2.3: sandbox_verified → live_certified).
  // Wallet/self-MFS channels never see this field (no provider API at all, §2).
  //
  // M5 (2026-11-26): UNSET config.environment hydrates as SANDBOX — that is
  // exactly what the server's resolveEnvironment() does for an unset value
  // (bkash-tokenized.service.js:105-110) — and the drawer says so honestly
  // ("not recorded"). An untouched environment is NEVER re-sent on PATCH:
  // only an explicit merchant change writes config.environment.
  const storedEnv = String((isEdit ? account?.config?.environment : '') ?? '').trim().toLowerCase();
  const envRecorded = storedEnv === 'sandbox' || storedEnv === 'production';
  const [isSandbox, setIsSandbox] = useState(isEdit ? storedEnv !== 'production' : true);
  const [envTouched, setEnvTouched] = useState(false);

  const [isEnabled, setIsEnabled] = useState(isEdit ? Boolean(account?.is_enabled) : false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<null | 'save' | 'verify' | 'certify'>(null);
  const [result, setResult] = useState<null | { status: 'success' | 'error' | 'pending'; title: string; description: string }>(null);
  const [evidence, setEvidence] = useState('');

  const titleId = 'account-drawer-title';

  const gatewayHasEntry = Boolean(appKey.trim() || appSecret.trim() || username.trim() || password.trim());
  // Explicit "replace by entry" warning: editing an account that already stores
  // credentials, and the merchant is entering values that would overwrite them.
  const showReplaceWarning = isEdit
    && account?.credential_summary?.has_credentials === true
    && (isGateway(provider, accountType) ? gatewayHasEntry : (number !== (account?.credential_summary?.mfs_number ?? '')));

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (isGateway(provider, accountType)) {
      const requireAll = !isEdit || gatewayHasEntry;
      if (requireAll && (!appKey.trim() || !appSecret.trim() || !username.trim())) {
        errors.gateway = t(`manageShop.paymentSettings.errors.merchantCredentialsRequired`, {
          defaultValue: 'App key, app secret and username are required',
        });
      }
    } else if (number && !BD_PHONE_REGEX.test(number)) {
      errors.number = t('common.bdPhoneInvalid', { defaultValue: 'Enter a valid 11-digit BD number (01XXXXXXXXX)' });
    } else if (!number) {
      errors.number = t(`manageShop.paymentSettings.errors.phoneRequired`, { defaultValue: 'Wallet number is required' });
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const save = async () => {
    if (!validate()) return;
    setPending('save');
    setResult(null);
    try {
      if (isEdit && account) {
        const patch: Parameters<typeof paymentClient.updatePaymentAccount>[1] = { is_enabled: isEnabled };
        if (isGateway(provider, accountType)) {
          // Only send new secrets if the merchant actually entered the full set —
          // never blank out stored credentials with empty fields.
          if (appKey.trim() && appSecret.trim() && username.trim()) {
            // M8: a BLANK password is omitted from the payload entirely — the
            // server merge keeps the stored one ("leave blank to keep the
            // stored password"). Only a typed password is ever sent.
            patch.credentials = {
              app_key: appKey.trim(),
              app_secret: appSecret.trim(),
              username: username.trim(),
              ...(password.trim() ? { password } : {}),
            };
          }
          // Environment selection persists to config (non-secret; sanitize keeps
          // it, credential write is what demotes the ladder — not this).
          // M5: only an EXPLICIT merchant touch writes environment — an untouched
          // drawer omits config from the PATCH entirely, so the stored value (or
          // its honest "unset" state) is never silently rewritten.
          if (envTouched) {
            patch.config = { ...(account.config || {}), environment: isSandbox ? 'sandbox' : 'production' };
          }
        } else {
          patch.credentials = { mfs_type: provider, mfs_number: number, mfs_mode: (accountType === 'business' ? 'business' : 'self') };
        }
        await paymentClient.updatePaymentAccount(account.id, patch);
      } else {
        const payload: Parameters<typeof paymentClient.savePaymentAccount>[0] = {
          provider,
          account_type: accountType,
          is_enabled: isEnabled,
          // Gateway channels persist their environment choice (§2.2 split);
          // wallet channels keep the field hidden and send no environment.
          config: isGateway(provider, accountType)
            ? { environment: isSandbox ? 'sandbox' : 'production' }
            : {},
        };
        if (isGateway(provider, accountType)) {
          payload.credentials = {
            app_key: appKey.trim(),
            app_secret: appSecret.trim(),
            username: username.trim(),
            // M8 mirror: never ship an empty password key on create either.
            ...(password.trim() ? { password } : {}),
          };
        } else {
          payload.credentials = { mfs_type: provider, mfs_number: number, mfs_mode: (accountType === 'business' ? 'business' : 'self') };
        }
        await paymentClient.savePaymentAccount(payload);
      }
      await onSaved();
      onClose();
    } catch (err: unknown) {
      setResult({
        status: 'error',
        title: t(`manageShop.paymentSettings.errors.saveFailedTitle`, { defaultValue: 'Could not save the account' }),
        description: getErrorMessage(err, t(`manageShop.paymentSettings.errors.saveConfigFailed`)),
      });
    } finally {
      setPending(null);
    }
  };

  // §2.1 rate-limited credential check — the ONLY provider-touching action.
  const verify = async () => {
    if (!account) return;
    setPending('verify');
    setResult(null);
    try {
      const res = await paymentClient.verifyPaymentAccountCredentials(account.id);
      const message = typeof res?.message === 'string' ? res.message : '';
      // A0 ruling (spec-audit #7): the verdict must state WHICH environment was
      // exercised. Prefer the server token, fall back to the stored/selected one.
      const envToken = String(
        (res as { environment?: unknown })?.environment
        ?? account?.config?.environment
        ?? (isSandbox ? 'sandbox' : 'production'),
      ).toLowerCase();
      const envLabel = envToken === 'production'
        ? t(`manageShop.paymentSettings.verify.envProduction`, { defaultValue: 'Production' })
        : t(`manageShop.paymentSettings.verify.envSandbox`, { defaultValue: 'Sandbox' });
      const envLine = isGateway(provider, accountType)
        ? ` ${t(`manageShop.paymentSettings.verify.environmentLine`, {
            env: envLabel,
            defaultValue: 'Environment exercised: {{env}}.',
          })}`
        : '';
      setResult({
        status: 'pending',
        title: t(`manageShop.paymentSettings.verify.resultTitle`, { defaultValue: 'Provider response' }),
        // Surface the server's own verdict verbatim; do NOT upgrade to "verified".
        description: (message || t(`manageShop.paymentSettings.ladder.credentialsValidated`, {
          defaultValue: 'Credentials validated (format) — not verified with bKash',
        })) + envLine,
      });
      await onSaved();
    } catch (err: unknown) {
      // 429 CREDENTIAL_CHECK_RATE_LIMITED / 501 PAYMENT_SERVICE_NOT_IMPLEMENTED
      // / any provider error all render honestly through the server message.
      setResult({
        status: 'error',
        title: t(`manageShop.paymentSettings.verify.failedTitle`, { defaultValue: 'Check not completed' }),
        description: getErrorMessage(err, t(`manageShop.paymentSettings.errors.testFailed`)),
      });
    } finally {
      setPending(null);
    }
  };

  // §2.3 (A9-R2 rewrite) owner records live_certified evidence from ANY
  // certifiable rung, but ONLY against an explicitly-recorded production
  // posture — mirrors certifyLiveAccount (payment-verification.service.js).
  const certify = async () => {
    if (!account) return;
    const trimmed = evidence.trim();
    if (trimmed.length < 3) {
      setFieldErrors((prev) => ({
        ...prev,
        evidence: t(`manageShop.paymentSettings.verify.evidenceRequired`, { defaultValue: 'A go-live evidence reference is required' }),
      }));
      return;
    }
    setPending('certify');
    setResult(null);
    try {
      await paymentClient.certifyLiveAccount(account.id, trimmed);
      await onSaved();
      setEvidence('');
      setResult({
        status: 'pending',
        title: t(`manageShop.paymentSettings.verify.certifyTitle`, { defaultValue: 'Certification recorded' }),
        description: t(`manageShop.paymentSettings.ladder.liveCertified`, {
          defaultValue: 'Live-certified by the owner — payments are still confirmed manually. The app never declares this itself.',
        }),
      });
    } catch (err: unknown) {
      setResult({
        status: 'error',
        title: t(`manageShop.paymentSettings.verify.certifyFailedTitle`, { defaultValue: 'Could not record the certification' }),
        description: getErrorMessage(err, t(`manageShop.paymentSettings.errors.saveConfigFailed`)),
      });
    } finally {
      setPending(null);
    }
  };

  // F1 (A8 round-2): the server certifies when the STORED row says
  // config.environment === 'production' AND the level is a CERTIFIABLE_RUNGS
  // rung (unverified / configured_unverified / sandbox_verified — live_certified
  // rows are refused 409 server-side and are not certifiable rungs; unknown/
  // archived rungs likewise). Drive off the SAVED account, never the unsaved
  // draft toggle: certify against a draft that was never persisted would 400.
  const recordedEnvironment = String(account?.config?.environment ?? '').trim().toLowerCase();
  const isCertifiableRung = CERTIFIABLE_RUNGS.includes(String(account?.verification_level ?? 'unverified'));
  const canCertify = isEdit
    && Boolean(account)
    && isGateway(provider, accountType)
    && isCertifiableRung
    && recordedEnvironment === 'production';
  // Honest CTA instead of a dead-end button: every non-production recorded
  // state (sandbox or legacy unset) is exactly what the server 400s, and the
  // 400's own instruction is "switch to production (this demotes the ladder)
  // and certify" — so say that here and make the switch reachable.
  const certifyNeedsProduction = isEdit
    && Boolean(account)
    && isGateway(provider, accountType)
    && isCertifiableRung
    && recordedEnvironment !== 'production';
  const showVerifyAction = isEdit && account && (
    isGateway(provider, accountType) || provider !== 'cod'
  );

  const sectionClass = 'border-t border-em-border pt-4 first:border-t-0 first:pt-0';
  const headingClass = 'flex items-center gap-2 text-sm font-semibold text-em-text-primary';

  const walletChannel = !isGateway(provider, accountType);

  return (
    <MotionConfig reducedMotion="user">
      <div
        className="fixed inset-0 z-50 flex justify-end bg-em-midnight-950/60"
        onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      >
        <motion.div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          initial={ANIMATE ? { x: '100%' } : false}
          animate={ANIMATE ? { x: 0 } : undefined}
          transition={{ duration: 0.25, ease: [0.2, 0.8, 0.3, 1] }}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
          className="flex h-full w-full max-w-md flex-col border-l border-em-border bg-em-bg-surface shadow-xl"
          data-testid="account-drawer"
        >
          <div className="flex items-start justify-between gap-3 border-b border-em-border p-5">
            <div>
              <h2 id={titleId} className="text-base font-semibold text-em-text-primary">
                {t(isEdit ? `manageShop.paymentSettings.accounts.manageTitle` : `manageShop.paymentSettings.accounts.addTitle`, {
                  defaultValue: isEdit ? 'Manage payment account' : 'Add payment account',
                })}
              </h2>
              {account && (
                <div className="mt-2">
                  <VerificationChip account={account} />
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className={`inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-em-text-secondary hover:bg-em-bg-muted ${FOCUS_RING}`}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            {result && (
              <ResultBanner
                status={result.status}
                title={result.title}
                description={result.description}
              />
            )}

            {/* Provider + channel selection (§1.1 legal matrix). */}
            <section className={sectionClass}>
              {!lockProvider && !isEdit && (
                <div className="mb-4">
                  <label htmlFor="drawer-provider" className="mb-1 block text-sm font-medium text-em-text-primary">
                    {t(`manageShop.paymentSettings.accounts.provider`, { defaultValue: 'Provider' })}
                  </label>
                  <select
                    id="drawer-provider"
                    value={provider}
                    onChange={(event) => {
                      const next = event.target.value as Provider;
                      setProvider(next);
                      const nextChannels = channelsForProvider(next).filter((c) => !existingChannels.includes(c));
                      setAccountType(nextChannels[0] ?? 'self');
                      setFieldErrors({});
                    }}
                    className={INPUT_CLASSES}
                  >
                    {walletProviders.map((p) => (
                      <option key={p} value={p}>{t(providerNameKey(p), { defaultValue: providerDefaultLabel(p) })}</option>
                    ))}
                  </select>
                </div>
              )}

              <div className="mb-1 block text-sm font-medium text-em-text-primary">
                {t(`manageShop.paymentSettings.accountType`, { defaultValue: 'Account type' })}
              </div>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t(`manageShop.paymentSettings.accountType`, { defaultValue: 'Account type' })}>
                {channelsForProvider(provider).map((channel) => {
                  const disabled = !isEdit && existingChannels.includes(channel);
                  return (
                    <button
                      key={channel}
                      type="button"
                      role="radio"
                      aria-checked={accountType === channel}
                      disabled={disabled || isEdit}
                      onClick={() => { setAccountType(channel); setFieldErrors({}); }}
                      className={`min-h-11 flex-1 rounded-lg border px-3 py-2 text-sm font-medium ${FOCUS_RING} ${
                        accountType === channel
                          ? 'border-em-violet-600 bg-em-violet-600 text-white'
                          : 'border-em-border-strong bg-em-bg-surface text-em-text-primary'
                      } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
                      data-testid={`channel-option-${channel}`}
                    >
                      {t(accountTypeKey(channel), { defaultValue: accountTypeDefaultLabel(channel) })}
                    </button>
                  );
                })}
              </div>
              {isEdit && (
                <p className="mt-1 text-xs text-em-text-secondary">
                  {t(`manageShop.paymentSettings.accounts.channelLocked`, { defaultValue: 'The provider and account type cannot be changed. Add a new account to use another channel.' })}
                </p>
              )}
              {!isEdit && availableChannels.length === 0 && (
                <p className="mt-2 rounded-lg border border-em-info-700/20 bg-em-info-100 px-3 py-2 text-xs text-em-info-700">
                  {t(`manageShop.paymentSettings.accounts.allChannelsConfigured`, { defaultValue: 'Every channel for this provider is already configured.' })}
                </p>
              )}
            </section>

            {/* Credentials per channel. */}
            <section className={sectionClass} aria-labelledby="drawer-creds">
              <h3 id="drawer-creds" className={headingClass}>
                {walletChannel ? (
                  <PhoneCall className="h-4 w-4 text-em-text-secondary" aria-hidden="true" />
                ) : (
                  <Lock className="h-4 w-4 text-em-text-secondary" aria-hidden="true" />
                )}
                {t(`manageShop.paymentSettings.accounts.credentials`, { defaultValue: 'Credentials' })}
              </h3>

              {showReplaceWarning && (
                <p role="status" className="mt-2 rounded-lg border border-em-sunlight-500/40 bg-em-sunlight-100 px-3 py-2 text-xs text-em-sunlight-700" data-testid="replace-warning">
                  {t(`manageShop.paymentSettings.accounts.replaceWarning`, { defaultValue: 'Saving new credentials replaces the stored ones and resets this account’s verification. This cannot be undone from here.' })}
                </p>
              )}

              {walletChannel && (
                <div className="mt-3">
                  <BDPhoneInput
                    id="drawer-wallet-number"
                    label={t(`manageShop.paymentSettings.mfsPhoneNumber`, { name: t(providerNameKey(provider), { defaultValue: providerDefaultLabel(provider) }) })}
                    value={number}
                    onChange={setNumber}
                    error={fieldErrors.number}
                    required
                  />
                  <p className="mt-1 text-xs text-em-text-secondary">
                    {t(`manageShop.paymentSettings.accounts.walletHint`, { defaultValue: 'This is the number customers send payments to. Payments are confirmed by you, never automatically.' })}
                  </p>
                </div>
              )}

              {!walletChannel && (
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-em-text-secondary">
                    {t(`manageShop.paymentSettings.accounts.gatewayStored`, { defaultValue: 'Merchant API secrets are stored securely and are never shown back to you. Enter all values to replace them.' })}
                  </p>
                  <div>
                    <label htmlFor="drawer-app-key" className="mb-1 block text-sm font-medium text-em-text-primary">
                      {t(`manageShop.paymentSettings.appKey`)}
                    </label>
                    <input id="drawer-app-key" type="text" autoComplete="off" value={appKey} onChange={(e) => setAppKey(e.target.value)} className={INPUT_CLASSES} data-testid="gateway-app-key" />
                  </div>
                  <div>
                    <label htmlFor="drawer-app-secret" className="mb-1 block text-sm font-medium text-em-text-primary">
                      {t(`manageShop.paymentSettings.appSecret`)}
                    </label>
                    <input id="drawer-app-secret" type="password" autoComplete="new-password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} className={INPUT_CLASSES} data-testid="gateway-app-secret" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="drawer-username" className="mb-1 block text-sm font-medium text-em-text-primary">
                        {t(`manageShop.paymentSettings.username`)}
                      </label>
                      <input id="drawer-username" type="text" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} className={INPUT_CLASSES} data-testid="gateway-username" />
                    </div>
                    <div>
                      {/* M8: on EDIT the label states the true merge semantics —
                          blank keeps the stored password (the server keeps it; a
                          typed value replaces it). On CREATE there is nothing to
                          keep, so the plain "Password" label stands. */}
                      <label htmlFor="drawer-password" className="mb-1 block text-sm font-medium text-em-text-primary">
                        {t(`manageShop.paymentSettings.password`)}
                        {isEdit && (
                          <span className="mt-0.5 block text-xs font-normal text-em-text-secondary" data-testid="password-keep-hint">
                            {t(`manageShop.paymentSettings.passwordKeepBlank`, { defaultValue: 'Leave blank to keep the stored password' })}
                          </span>
                        )}
                      </label>
                      <input id="drawer-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={INPUT_CLASSES} data-testid="gateway-password" />
                    </div>
                  </div>
                  {fieldErrors.gateway && <p role="alert" className="text-xs text-em-danger-700">{fieldErrors.gateway}</p>}
                </div>
              )}
            </section>

            {/* Enable / disable — gated on required config only, never verification (§7 row 3). */}
            <section className={sectionClass} aria-labelledby="drawer-enable">
              <h3 id="drawer-enable" className={headingClass}>
                <ShieldCheck className="h-4 w-4 text-em-text-secondary" aria-hidden="true" />
                {t(`manageShop.paymentSettings.accounts.available`, { defaultValue: 'Offered to customers' })}
              </h3>
              <label className="mt-2 inline-flex min-h-11 items-center gap-2 text-sm text-em-text-primary">
                <input
                  type="checkbox"
                  checked={isEnabled}
                  onChange={(event) => setIsEnabled(event.target.checked)}
                  className="h-5 w-5 rounded border-em-border-strong accent-em-violet-600"
                  data-testid="drawer-enable-checkbox"
                />
                {t(`manageShop.paymentSettings.accounts.enableLabel`, { defaultValue: 'Make this account available to customers' })}
              </label>
              <p className="mt-1 text-xs text-em-text-secondary">
                {t(`manageShop.paymentSettings.accounts.enableHonesty`, { defaultValue: 'Enabling only controls whether customers see this option. It does not verify anything with the provider.' })}
              </p>
              {isGateway(provider, accountType) && (
                <div className="mt-2">
                  <label className="inline-flex min-h-11 items-center gap-2 text-sm text-em-text-primary">
                    <input
                      type="checkbox"
                      checked={isSandbox}
                      onChange={(event) => {
                        setIsSandbox(event.target.checked);
                        // M5: touching the selection is what arms the environment
                        // write — until then PATCH never carries config.environment.
                        setEnvTouched(true);
                      }}
                      className="h-5 w-5 rounded border-em-border-strong accent-em-violet-600"
                      data-testid="drawer-environment"
                    />
                    {t(`manageShop.paymentSettings.sandbox`)}
                  </label>
                  {/* M5 honesty: an account created before the selection persisted
                      (or never saved one) has NO recorded environment; the server
                      treats that as sandbox, and we say so instead of implying a
                      recorded choice. */}
                  {isEdit && !envRecorded && !envTouched && (
                    <p className="mt-1 text-xs text-em-text-secondary" data-testid="environment-not-recorded">
                      {t(`manageShop.paymentSettings.accounts.environmentNotRecorded`, { defaultValue: 'Not recorded — treated as sandbox.' })}
                    </p>
                  )}
                  {/* F1 (A8 round-2): the server DEMOTES the verification ladder
                      whenever the recorded environment changes
                      (payment-accounts.service.js applyEnvironmentChangeDemotion,
                      :174-187). The drawer must say that ON the control, before
                      the merchant saves, not only after a refusal. */}
                  {isEdit && envTouched && (isSandbox ? 'sandbox' : 'production') !== storedEnv && (
                    <p
                      role="status"
                      className="mt-1 rounded-lg border border-em-sunlight-500/40 bg-em-sunlight-100 px-3 py-2 text-xs text-em-sunlight-700"
                      data-testid="environment-change-warning"
                    >
                      {t(`manageShop.paymentSettings.accounts.environmentChangeWarning`, {
                        defaultValue: 'Saving this switch changes the recorded environment and resets this account’s verification ladder — a check earned in the other environment proves nothing here. Credentials are not re-checked automatically.',
                      })}
                    </p>
                  )}
                </div>
              )}
            </section>

            {/* Owner verification actions (edit mode only — they need an account row). */}
            {showVerifyAction && (
              <section className={sectionClass} aria-labelledby="drawer-verify">
                <h3 id="drawer-verify" className={headingClass}>
                  <CircleDashed className="h-4 w-4 text-em-text-secondary" aria-hidden="true" />
                  {t(`manageShop.paymentSettings.accounts.verification`, { defaultValue: 'Verification' })}
                </h3>
                {isGateway(provider, accountType) ? (
                  <>
                    <p className="mt-1 text-xs text-em-text-secondary">
                      {t(`manageShop.paymentSettings.verify.credentialHelp`, { defaultValue: 'bKash allows at most 2 credential checks per hour. This checks credentials only — it never confirms a payment.' })}
                    </p>
                    <EmButton
                      variant="secondary"
                      className="mt-2"
                      onClick={() => void verify()}
                      loading={pending === 'verify'}
                      disabled={pending !== null}
                      data-testid="drawer-verify-credentials"
                    >
                      {t(`manageShop.paymentSettings.verify.checkCredentials`, { defaultValue: 'Check credentials (limited to 2 per hour by bKash)' })}
                    </EmButton>
                    {/* F1 honest CTA: no certify button on a state the server
                        would 400 — instead the exact one-flow path the server's
                        own 400 message instructs (switch → save → certify). */}
                    {certifyNeedsProduction && (
                      <p
                        className="mt-2 rounded-lg border border-em-sunlight-500/40 bg-em-sunlight-100 px-3 py-2 text-xs text-em-sunlight-700"
                        data-testid="certify-needs-production"
                      >
                        {envTouched && !isSandbox
                          ? t(`manageShop.paymentSettings.verify.certifyAfterSave`, {
                              defaultValue: 'Production will be recorded once you save. Save, then reopen this account — the certification field appears. The switch itself resets the verification ladder.',
                            })
                          : t(`manageShop.paymentSettings.verify.certifyNeedsProduction`, {
                              defaultValue: 'Switch to Production to certify live credentials — this resets the verification ladder.',
                            })}
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="mt-1 text-xs text-em-text-secondary">
                      {t(`manageShop.paymentSettings.verify.formatHelp`, { defaultValue: 'This only validates the number format. It never contacts the provider.' })}
                    </p>
                    <EmButton
                      variant="secondary"
                      className="mt-2"
                      onClick={() => void verify()}
                      loading={pending === 'verify'}
                      disabled={pending !== null}
                      data-testid="drawer-validate-format"
                    >
                      {t(`manageShop.paymentSettings.verify.validateFormat`, { defaultValue: 'Validate format' })}
                    </EmButton>
                  </>
                )}

                {canCertify && (
                  <div className="mt-4">
                    <label htmlFor="drawer-evidence" className="mb-1 block text-sm font-medium text-em-text-primary">
                      {t(`manageShop.paymentSettings.verify.evidenceLabel`, { defaultValue: 'Go-live certification evidence' })}
                    </label>
                    <textarea
                      id="drawer-evidence"
                      rows={3}
                      value={evidence}
                      maxLength={500}
                      onChange={(e) => setEvidence(e.target.value)}
                      placeholder={t(`manageShop.paymentSettings.verify.evidencePlaceholder`, { defaultValue: 'e.g. bKash onboarding email 2026-11-30' })}
                      aria-invalid={fieldErrors.evidence ? true : undefined}
                      className={INPUT_CLASSES}
                      data-testid="certify-evidence"
                    />
                    {fieldErrors.evidence && <p role="alert" className="mt-1 text-xs text-em-danger-700">{fieldErrors.evidence}</p>}
                    <EmButton
                      variant="secondary"
                      className="mt-2"
                      onClick={() => void certify()}
                      loading={pending === 'certify'}
                      disabled={pending !== null}
                      data-testid="drawer-certify-live"
                    >
                      {t(`manageShop.paymentSettings.verify.certify`, { defaultValue: 'Record go-live certification' })}
                    </EmButton>
                    <p className="mt-1 text-xs text-em-text-secondary">
                      {t(`manageShop.paymentSettings.verify.certifyHonesty`, { defaultValue: 'This records the owner’s certification reference. The app never self-declares live certification.' })}
                    </p>
                  </div>
                )}
              </section>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <EmButton
                variant="primary"
                onClick={() => void save()}
                loading={pending === 'save'}
                disabled={pending !== null || (!isEdit && availableChannels.length === 0)}
                data-testid="account-drawer-save"
              >
                {t(`manageShop.paymentSettings.save`, { defaultValue: 'Save account' })}
              </EmButton>
              <EmButton variant="secondary" onClick={onClose}>
                {t('common.cancel')}
              </EmButton>
            </div>
          </div>
        </motion.div>
      </div>
    </MotionConfig>
  );
}

export default AccountDrawer;
