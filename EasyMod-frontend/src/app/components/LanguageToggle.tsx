import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { withLanguageOverride } from '@/i18n/language';
import { ensurePublicLocaleResources } from '@/i18n/publicLocale';

interface LanguageToggleProps {
  /** Visual variant — 'public' uses the local funnel palette. */
  /** Workspace styling follows the merchant shell brand tokens. */
  variant?: 'light' | 'dark' | 'public' | 'workspace';
}

export default function LanguageToggle({ variant = 'dark' }: LanguageToggleProps) {
  const { t, i18n } = useTranslation();
  const isBn = i18n.language === 'bn';
  const [isChangingLanguage, setIsChangingLanguage] = useState(false);
  const [languageLoadFailed, setLanguageLoadFailed] = useState(false);

  const toggle = async () => {
    if (isChangingLanguage) return;
    const nextLanguage = isBn ? 'en' : 'bn';
    setIsChangingLanguage(true);
    setLanguageLoadFailed(false);
    try {
      await ensurePublicLocaleResources(i18n, nextLanguage);
      await i18n.changeLanguage(nextLanguage);
      if (variant === 'public' && typeof window !== 'undefined') {
        window.history.replaceState(
          window.history.state,
          '',
          withLanguageOverride(window.location.href, nextLanguage),
        );
      }
    } catch {
      setLanguageLoadFailed(true);
    } finally {
      setIsChangingLanguage(false);
    }
  };

  // The workspace variant lives in the merchant sidebar, where the pointer is
  // often a finger (guardrails §18 → 44px). Public/marketing variants keep their
  // compact 28px pill so the funnel header is unchanged.
  const base =
    `inline-flex items-center rounded-full border text-xs font-semibold cursor-pointer select-none transition-colors overflow-hidden ${variant === 'workspace' ? 'min-h-11' : 'h-7'}`;

  const styles = variant === 'light'
    ? 'border-white/30 bg-white/10 text-white hover:bg-white/20'
    : variant === 'public'
      ? 'border-[#7460D9]/30 bg-white text-[#17223B] hover:bg-[#E8E4FF]/60'
      : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 shadow-sm';

  const activeSegment = variant === 'light'
    ? 'bg-white/25'
    : variant === 'public' || variant === 'workspace'
      ? 'bg-[#5D49BB] text-white'
      : 'bg-emerald-600 text-white';
  const inactiveSegment = variant === 'public' ? 'text-[#46506A]' : 'opacity-60';

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={isChangingLanguage}
      aria-busy={isChangingLanguage}
      className={`${base} ${styles} ${variant === 'workspace' ? 'mw-language-toggle' : ''}`}
      aria-label={isBn ? t('common.language.switchToEnglish') : t('common.language.switchToBengali')}
      title={isBn ? t('common.language.switchToEnglish') : t('common.language.switchToBengali')}
    >
      <span className={`px-2.5 py-0.5 rounded-full transition-all ${isBn ? activeSegment : inactiveSegment}`}>
        বাং
      </span>
      <span className={`px-2.5 py-0.5 rounded-full transition-all ${!isBn ? activeSegment : inactiveSegment}`}>
        EN
      </span>
      {languageLoadFailed && <span className="sr-only" role="status">{t('common.language.loadFailed')}</span>}
    </button>
  );
}
