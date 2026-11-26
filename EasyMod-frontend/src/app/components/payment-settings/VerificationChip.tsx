/**
 * Verification ladder chip (§2 ladder; A0 ratification R-12, D-3 exact copy).
 *
 * The single honest statement of how verified an account actually is. It MUST
 * never imply a live provider check that did not happen: below `live_certified`
 * it renders the "Credentials validated (format) — not verified with bKash" /
 * Nagad-Rocket "official verification unavailable" family, and `live_certified`
 * is presented as a recorded OWNER act, never the app's own verification. The
 * forbidden string "…via official merchant API" (guardrails §8.3 merchant-mode
 * honesty) is never emitted here — automation is inert (R-12).
 *
 * It is icon + visible label, never colour alone (§8), and lives inside the
 * `.em-payment` scope using `--em-*` tokens.
 */
import { useTranslation } from 'react-i18next';
import {
  CircleDashed,
  ShieldCheck,
  ShieldQuestion,
  BadgeCheck,
  Banknote,
  type LucideIcon,
} from 'lucide-react';
import type { PaymentAccountView } from './taxonomy';
import { GATEWAY_ACCOUNT_TYPE, isWalletOnly } from './taxonomy';


const LEVEL_BADGE: Record<string, { key: string; def: string; icon: LucideIcon; tone: string }> = {
  unverified: {
    key: `manageShop.paymentSettings.ladder.level.unverified`,
    def: 'Not verified',
    icon: CircleDashed,
    tone: 'bg-em-bg-muted text-em-text-secondary border-em-border',
  },
  configured_unverified: {
    key: `manageShop.paymentSettings.ladder.level.configured`,
    def: 'Format validated',
    icon: ShieldQuestion,
    tone: 'bg-em-sunlight-100 text-em-sunlight-700 border-em-sunlight-500/40',
  },
  sandbox_verified: {
    key: `manageShop.paymentSettings.ladder.level.sandbox`,
    def: 'Sandbox tested',
    icon: ShieldCheck,
    tone: 'bg-em-info-100 text-em-info-700 border-em-info-700/20',
  },
  live_certified: {
    key: `manageShop.paymentSettings.ladder.level.certified`,
    def: 'Owner-certified',
    icon: BadgeCheck,
    tone: 'bg-em-success-100 text-em-success-700 border-em-success-700/20',
  },
};

export interface VerificationChipProps {
  account: PaymentAccountView;
  /** COD has no ladder — render the credential-free statement instead. */
  className?: string;
}

/** Pure text resolution so it can be asserted without rendering (§2 honesty). */
function resolveHonesty(
  account: PaymentAccountView,
): { detailKey: string; detailDef: string; extraKey?: string; extraDef?: string } {
  const provider = account.provider ?? '';
  const level = account.verification_level;

  if (provider === 'cod') {
    return {
      detailKey: `manageShop.paymentSettings.ladder.cod`,
      detailDef: 'No verification needed — cash on delivery.',
    };
  }

  // Nagad / Rocket: official verification unavailable, regardless of ladder rung (§2).
  if (isWalletOnly(provider as PaymentAccountView['provider'])) {
    return {
      detailKey: `manageShop.paymentSettings.accounts.walletOnlyNotice`,
      detailDef:
        'Official automated verification is not available for Nagad/Rocket. ' +
        'Payments to these numbers are confirmed by you (the merchant), never automatically.',
    };
  }

  // bKash merchant_gateway.
  if (account.account_type === GATEWAY_ACCOUNT_TYPE) {
    if (level === 'live_certified') {
      return {
        detailKey: `manageShop.paymentSettings.ladder.liveCertified`,
        detailDef:
          'Live-certified by the owner — payments are still confirmed manually. The app never declares this itself.',
      };
    }
    if (level === 'sandbox_verified') {
      return {
        detailKey: `manageShop.paymentSettings.ladder.sandboxVerified`,
        // D-3 mandated sentence, rendered exactly.
        detailDef: 'sandbox checkout handshake verified; no settlement implied',
        extraKey: `manageShop.paymentSettings.verify.notActiveYet`,
        extraDef: 'Automated checkout is not active yet — you confirm payments manually.',
      };
    }
    // unverified | configured_unverified → the exact R-12 founder-visible status
    // + the automation-inert honesty (§7 row 3).
    return {
      detailKey: level === 'configured_unverified'
        ? `manageShop.paymentSettings.ladder.credentialsValidated`
        : `manageShop.paymentSettings.ladder.unverified`,
      detailDef: level === 'configured_unverified'
        ? 'Credentials validated (format) — not verified with bKash'
        : 'Not verified yet.',
      extraKey: `manageShop.paymentSettings.verify.notActiveYet`,
      extraDef: 'Automated checkout is not active yet — you confirm payments manually.',
    };
  }

  // bKash self / business wallet — the self-MFS merchant-confirm path (§3).
  return {
    detailKey: level === 'configured_unverified'
      ? `manageShop.paymentSettings.ladder.credentialsValidated`
      : `manageShop.paymentSettings.ladder.unverified`,
    detailDef: level === 'configured_unverified'
      ? 'Credentials validated (format) — not verified with bKash'
      : 'Not verified yet.',
  };
}

export function VerificationChip({ account, className = '' }: VerificationChipProps) {
  const { t } = useTranslation();
  const badge = LEVEL_BADGE[account.verification_level] ?? LEVEL_BADGE.unverified;
  const honesty = resolveHonesty(account);
  const Icon = account.provider === 'cod' ? Banknote : badge.icon;

  return (
    <div className={`min-w-0 ${className}`} data-testid={`verification-chip-${account.id ?? account.provider ?? 'unknown'}`}>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badge.tone}`}
        data-testid="verification-level-badge"
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {t(badge.key, { defaultValue: badge.def })}
      </span>
      <p className="mt-1 text-xs text-em-text-secondary" data-testid="verification-honesty">
        {t(honesty.detailKey, { defaultValue: honesty.detailDef })}
      </p>
      {honesty.extraKey && (
        <p className="mt-0.5 text-xs text-em-text-secondary" data-testid="verification-extra">
          {t(honesty.extraKey, { defaultValue: honesty.extraDef })}
        </p>
      )}
    </div>
  );
}

export default VerificationChip;
