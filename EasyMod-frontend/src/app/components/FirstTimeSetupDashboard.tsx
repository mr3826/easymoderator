/**
 * First-time setup variant of /dashboard — guardrails restyle. Same props,
 * same localStorage gating, same three sub-variants (welcome / in-progress /
 * complete). One primary action per screen: welcome → Start, in-progress →
 * the NEXT incomplete task's CTA (other tasks secondary, completed tasks a
 * resolved badge with no CTA).
 *
 * P04 truthfulness: the complete branch reports CONFIGURATION complete, and a
 * separate operational ladder from the backend (configured / waiting_for_test /
 * action_required / verified_operational) tells the merchant whether a real
 * approved reply has actually reached Messenger. Warnings render on every
 * branch — completing the checklist does not silence them. Capability claims
 * appear only in the verified_operational state.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  CheckCircle2,
  Facebook,
  Info,
  MessageCircle,
  Package,
  Store,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { SetupOperationalState, SetupStatus, SetupTaskKey, SetupTaskWarning } from '@/api/types';
import { EmButton } from './dashboard/EmButton';
import { PageHeader } from './dashboard/PageHeader';
import { ResultBanner } from './dashboard/ResultBanner';
import { SignalBadge } from './dashboard/SignalBadge';
import { EvidenceFooter } from './dashboard/EvidenceFooter';
import { deriveNarrative } from './dashboard/derive';
import type { Action, Signal } from './dashboard/types';

type FirstTimeSetupDashboardProps = {
  setupStatus: SetupStatus;
  onRefresh?: () => void | Promise<unknown>;
  onDismissCompletion?: () => void;
  storageKeyPrefix?: string;
};

const iconByTask: Record<SetupTaskKey, LucideIcon> = {
  connect_channel: Facebook,
  shop_profile: Store,
  first_product: Package,
  ai_settings: MessageCircle,
};

/** Design-system banner tone per operational state — never inferred from isComplete. */
const bannerByState: Record<SetupOperationalState, 'success' | 'error' | 'pending'> = {
  configured: 'pending',
  waiting_for_test: 'pending',
  action_required: 'error',
  verified_operational: 'success',
};

function stringList(value: unknown, fallback: string[]) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : fallback;
}

function dedupeWarnings(warnings: SetupTaskWarning[]): SetupTaskWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    if (seen.has(warning.code)) return false;
    seen.add(warning.code);
    return true;
  });
}

export default function FirstTimeSetupDashboard({
  setupStatus,
  onRefresh,
  onDismissCompletion,
  storageKeyPrefix = 'easymod:business-setup',
}: FirstTimeSetupDashboardProps) {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const locale = i18n?.language === 'bn' ? 'bn-BD' : 'en-BD';
  const welcomeStartedKey = `${storageKeyPrefix}:started`;
  const [hasStarted, setHasStarted] = useState(() => {
    if (setupStatus.completedCount > 0 || setupStatus.isComplete) return true;
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(welcomeStartedKey) === '1';
  });

  useEffect(() => {
    if (setupStatus.completedCount > 0 || setupStatus.isComplete) {
      setHasStarted(true);
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(welcomeStartedKey, '1');
      }
    }
  }, [setupStatus.completedCount, setupStatus.isComplete, welcomeStartedKey]);

  const progressLabel = useMemo(
    () => t('dashboard.setup.progress', {
      completed: setupStatus.completedCount,
      total: setupStatus.totalCount,
    }),
    [setupStatus.completedCount, setupStatus.totalCount, t],
  );

  const readinessLabel = useMemo(() => {
    if (setupStatus.progressPercent >= 100) return t('dashboard.setup.progressReady');
    if (setupStatus.totalCount - setupStatus.completedCount === 1) return t('dashboard.setup.progressOneLeft');
    if (setupStatus.progressPercent >= 75) return t('dashboard.setup.progressAlmostReady');
    return t('dashboard.setup.progressPercent', { percent: setupStatus.progressPercent });
  }, [setupStatus.completedCount, setupStatus.progressPercent, setupStatus.totalCount, t]);

  const handleStartSetup = () => {
    setHasStarted(true);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(welcomeStartedKey, '1');
    }
  };
  const welcomeBullets = stringList(t('dashboard.setup.welcomeBullets', { returnObjects: true }), [
    'Connect Facebook',
    'Add Products',
    'Configure Replies',
    'Get ready to receive orders',
  ]);
  const completeBullets = stringList(t('dashboard.setup.completeBullets', { returnObjects: true }), [
    'Reply to customers',
    'Recommend products',
    'Capture orders',
    'Reduce manual work',
  ]);

  const formatStamp = useMemo(() => (value: string | null | undefined) => {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Dhaka',
    }).format(date);
  }, [locale]);

  // generatedAt is the moment the BACKEND COMPUTED this status — it is not a
  // verification time. The label says "Status checked", and real operational
  // evidence is listed separately below.
  const statusCheckedLabel = useMemo(() => {
    const stamp = formatStamp(setupStatus.generatedAt);
    return stamp ? t('dashboard.setup.statusCheckedAt', { time: stamp }) : '';
  }, [formatStamp, setupStatus.generatedAt, t]);

  const shell = 'em-dashboard min-h-full p-4 md:p-6';
  const inner = 'mx-auto w-full max-w-[1440px]';
  const breadcrumb = [{ label: t('dashboard.pulse.context.workspace') }, { label: t('dashboard.setup.eyebrow') }];
  const attentionSignal: Signal = { kind: 'attention', label: t('dashboard.pulse.signal.attention') };
  const resolvedSignal: Signal = { kind: 'resolved', label: t('dashboard.pulse.signal.resolved') };
  const pendingSignal: Signal = { kind: 'pending', label: t('dashboard.pulse.signal.pending') };
  const setupNarrative = (provenResultOverride?: string) =>
    deriveNarrative(
      { phase: setupStatus.isComplete ? 'setup-complete' : 'setup', pulse: null, workItems: [], caughtUp: false, hasAllWorkSources: false },
      t,
      { provenResultOverride },
    );
  const setupEvidence = [progressLabel, statusCheckedLabel]
    .filter(Boolean)
    .join(' · ');

  if (!setupStatus.isComplete && !hasStarted) {
    const narrative = setupNarrative(setupEvidence);
    const primary: Action = { label: t('dashboard.setup.startCta'), onClick: handleStartSetup };
    return (
      <div className={shell}>
        <div className={inner}>
          <PageHeader
            title={t('dashboard.setup.welcomeTitle')}
            breadcrumb={breadcrumb}
            signal={attentionSignal}
            whyHere={t('dashboard.setup.welcomeSubtitle')}
            primaryAction={primary}
          />
          <section className="mb-4 rounded-xl border border-em-border bg-em-bg-surface p-4" aria-labelledby="setup-welcome-list">
            <h2 id="setup-welcome-list" className="text-sm font-semibold text-em-text-primary">
              {t('dashboard.setup.eyebrow')}
            </h2>
            <ul className="mt-3 grid gap-2 md:grid-cols-2">
              {welcomeBullets.map((item) => (
                <li key={item} className="flex items-start gap-2 rounded-lg bg-em-bg-app p-3">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-em-success-700" aria-hidden="true" />
                  <span className="text-sm font-medium text-em-text-primary">{item}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs font-medium text-em-text-secondary">{t('dashboard.setup.estimatedTime')}</p>
          </section>
          <EvidenceFooter
            provenResult={narrative.provenResult}
            whereNext={narrative.whereNext}
            isStale={false}
            coverageComplete={false}
            onRefresh={() => void onRefresh?.()}
          />
        </div>
      </div>
    );
  }

  if (setupStatus.isComplete) {
    const operational = setupStatus.operational;
    // An older payload without the operational block is NOT evidence of a
    // working pipeline — it stays at the most conservative claim.
    const state: SetupOperationalState = operational?.state ?? 'configured';
    const verified = state === 'verified_operational';
    const windowDays = operational?.evidenceWindowDays ?? 30;
    const webhook = operational?.evidence.webhook;
    const assistant = operational?.evidence.assistant;

    const narrative = setupNarrative(setupEvidence);
    const headerSignal: Signal = verified
      ? resolvedSignal
      : state === 'action_required'
        ? attentionSignal
        : pendingSignal;
    const primary: Action = { label: t('dashboard.setup.goToDashboard'), onClick: onDismissCompletion };
    const secondary: Action = {
      label: t('dashboard.setup.reviewReplySettings'),
      onClick: () => {
        onDismissCompletion?.();
        // A8 Task 8 / F-7: the label promises REPLY settings — the canonical
        // automation/reply-settings page is /manage-shop/automation
        // (BusinessAutomationDefaults); business-info was a mis-wired target.
        navigate('/manage-shop/automation');
      },
    };

    const warnings = dedupeWarnings([
      ...setupStatus.tasks.flatMap((task) => task.warnings),
      ...(operational?.warnings ?? []),
    ]);

    const evidenceItems: string[] = [];
    if (webhook) {
      if (webhook.lastVerifiedAt && webhook.verifiedWithinWindow > 0) {
        evidenceItems.push(t('dashboard.setup.evidence.webhookVerifiedAt', { time: formatStamp(webhook.lastVerifiedAt) }));
      } else if (webhook.lastVerifiedAt) {
        evidenceItems.push(t('dashboard.setup.evidence.webhookStale', { days: windowDays }));
      } else {
        evidenceItems.push(t('dashboard.setup.evidence.webhookNever'));
      }
    }
    if (assistant) {
      if (assistant.providerAcceptedEver > 0) {
        evidenceItems.push(t('dashboard.setup.evidence.providerAccepted', { count: assistant.providerAcceptedEver }));
      } else {
        evidenceItems.push(t('dashboard.setup.evidence.providerNone'));
      }
      if (assistant.approvedSendFailures > 0 || assistant.outboxNeedsReconciliation > 0) {
        evidenceItems.push(t('dashboard.setup.evidence.deliveryFailures', {
          count: assistant.approvedSendFailures + assistant.outboxNeedsReconciliation,
        }));
      }
    }

    return (
      <div className={shell}>
        <div className={inner}>
          <PageHeader
            title={t('dashboard.setup.completeTitle')}
            breadcrumb={breadcrumb}
            signal={headerSignal}
            whyHere={t('dashboard.setup.completeSubtitle')}
            primaryAction={primary}
            secondaryActions={[secondary]}
          />
          <ResultBanner
            status={bannerByState[state]}
            title={t(`dashboard.setup.states.${state}.title`)}
            description={t(`dashboard.setup.states.${state}.description`, { windowDays })}
            evidenceId={setupEvidence}
            className="mb-4"
          />
          {warnings.length > 0 && (
            <section
              role="status"
              className="mb-4 rounded-xl border border-em-warning-700/20 bg-em-warning-100 p-4"
              aria-labelledby="setup-complete-warnings"
            >
              <h2 id="setup-complete-warnings" className="text-sm font-semibold text-em-warning-700">
                {t('dashboard.setup.warningsTitle')}
              </h2>
              <ul className="mt-2 space-y-1">
                {warnings.map((warning) => (
                  <li key={warning.code} className="flex gap-2 text-sm font-medium text-em-warning-700">
                    <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>
                      {t(`dashboard.setup.warnings.${warning.code}`, { defaultValue: warning.message })}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section
            className="mb-4 rounded-xl border border-em-border bg-em-bg-surface p-4"
            aria-labelledby="setup-operational-evidence"
          >
            <h2 id="setup-operational-evidence" className="text-sm font-semibold text-em-text-primary">
              {t('dashboard.setup.evidence.title')}
            </h2>
            {evidenceItems.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {evidenceItems.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-em-text-secondary">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-em-text-secondary" aria-hidden="true" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-em-text-secondary">{t('dashboard.setup.evidence.none')}</p>
            )}
          </section>
          {verified && (
            <section className="mb-4 rounded-xl border border-em-border bg-em-bg-surface p-4" aria-labelledby="setup-complete-list">
              <h2 id="setup-complete-list" className="text-sm font-semibold text-em-text-primary">
                {t('dashboard.setup.eyebrow')}
              </h2>
              <ul className="mt-3 grid gap-2 md:grid-cols-2">
                {completeBullets.map((item) => (
                  <li key={item} className="flex items-start gap-2 rounded-lg bg-em-success-100 p-3">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-em-success-700" aria-hidden="true" />
                    <span className="text-sm font-medium text-em-success-700">{item}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <EvidenceFooter
            provenResult={narrative.provenResult}
            whereNext={narrative.whereNext}
            isStale={false}
            coverageComplete={verified}
            onRefresh={() => void onRefresh?.()}
          />
        </div>
      </div>
    );
  }

  const nextTask = setupStatus.tasks.find((task) => task.status !== 'complete');
  const narrative = setupNarrative(setupEvidence);
  const refreshAction: Action = { label: t('dashboard.setup.refresh'), onClick: () => void onRefresh?.() };

  return (
    <div className={shell}>
      <div className={inner}>
        <PageHeader
          title={t('dashboard.setup.title')}
          breadcrumb={breadcrumb}
          signal={attentionSignal}
          whyHere={t('dashboard.setup.subtitle')}
          secondaryActions={[refreshAction]}
        />

        <section className="mb-4 rounded-xl border border-em-border bg-em-bg-surface p-4" aria-labelledby="setup-progress-heading">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="setup-progress-heading" className="text-sm font-semibold text-em-text-primary">
                {t('dashboard.setup.progressTitle')}
              </h2>
              <p className="text-sm text-em-text-secondary">{readinessLabel}</p>
            </div>
            <span className="em-tabular text-2xl font-semibold text-em-violet-700">{setupStatus.progressPercent}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.max(0, Math.min(100, setupStatus.progressPercent))}
            aria-label={t('dashboard.setup.progressTitle')}
            className="h-3 overflow-hidden rounded-full bg-em-bg-muted"
          >
            <div
              className="h-full rounded-full bg-em-violet-600 transition-all"
              style={{ width: `${Math.max(0, Math.min(100, setupStatus.progressPercent))}%` }}
            />
          </div>
          <p className="em-tabular mt-2 text-xs font-medium text-em-text-secondary">{progressLabel}</p>
        </section>

        <section className="grid gap-3" aria-labelledby="setup-tasks-heading">
          <h2 id="setup-tasks-heading" className="sr-only">{t('dashboard.setup.eyebrow')}</h2>
          {setupStatus.tasks.map((task) => {
            const Icon = iconByTask[task.key];
            const isComplete = task.status === 'complete';
            const isNext = nextTask?.key === task.key;
            const taskSignal: Signal = isComplete ? resolvedSignal : attentionSignal;
            return (
              <article
                key={task.key}
                className={`rounded-xl border p-4 ${isNext ? 'border-em-violet-300 bg-em-violet-50' : 'border-em-border bg-em-bg-surface'}`}
              >
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="flex min-w-0 gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-em-bg-surface shadow-sm">
                      <Icon className={`h-5 w-5 ${isComplete ? 'text-em-success-700' : 'text-em-violet-700'}`} aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <div className="mb-1 flex flex-wrap items-center gap-2">
                        <h3 className="text-base font-semibold text-em-text-primary">
                          {t(`dashboard.setup.tasks.${task.key}.title`, { defaultValue: task.title })}
                        </h3>
                        <SignalBadge signal={taskSignal} />
                        {isNext && (
                          <span className="rounded-full bg-em-sunlight-100 px-2 py-0.5 text-xs font-semibold text-em-sunlight-700">
                            {t('dashboard.setup.nextStep')}
                          </span>
                        )}
                      </div>
                      <p className="text-sm leading-6 text-em-text-secondary">
                        {t(`dashboard.setup.tasks.${task.key}.description`, { defaultValue: task.description })}
                      </p>
                      {!isComplete && task.missing.length > 0 && (
                        <p className="mt-2 text-sm font-medium text-em-warning-700">
                          {t('dashboard.setup.missingPrefix')}{' '}
                          {task.missing
                            .map((key) => t(`dashboard.setup.missing.${key}`, { defaultValue: key.replace(/_/g, ' ') }))
                            .join(', ')}
                        </p>
                      )}
                      {task.warnings.length > 0 && (
                        <div className="mt-2 space-y-1">
                          {task.warnings.map((warning) => (
                            <p key={warning.code} className="flex gap-2 text-sm font-medium text-em-warning-700">
                              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                              <span>
                                {t(`dashboard.setup.warnings.${warning.code}`, { defaultValue: warning.message })}
                              </span>
                            </p>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {!isComplete && (
                    <EmButton
                      variant={isNext ? 'primary' : 'secondary'}
                      className="shrink-0"
                      action={{
                        label: t(`dashboard.setup.tasks.${task.key}.cta`, { defaultValue: task.ctaLabel }),
                        to: task.href,
                      }}
                      data-testid={isNext ? 'dashboard-primary-action' : undefined}
                    >
                      {t(`dashboard.setup.tasks.${task.key}.cta`, { defaultValue: task.ctaLabel })}
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </EmButton>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        <section className="mt-4 rounded-xl border border-em-sunlight-600/30 bg-em-sunlight-50 p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-em-sunlight-700">
            <TriangleAlert className="h-4 w-4" aria-hidden="true" />
            {t('dashboard.setup.noteTitle')}
          </h2>
          <p className="mt-1 text-sm leading-6 text-em-text-primary">{t('dashboard.setup.noteBody')}</p>
        </section>

        <EvidenceFooter
          provenResult={narrative.provenResult}
          whereNext={narrative.whereNext}
          isStale={false}
          coverageComplete={false}
          onRefresh={() => void onRefresh?.()}
        />
      </div>
    </div>
  );
}
