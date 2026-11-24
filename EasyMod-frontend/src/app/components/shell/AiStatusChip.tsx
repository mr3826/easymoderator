/**
 * Read-only AI reply-status chip in the desktop top bar (Phase 1 mission D6;
 * guardrails §16 honesty + §18 never-color-alone).
 *
 * Authority: `listMetaChannels()` ONLY (doc 05 §7) — the same effective-mode
 * payload the channels page uses. The chip never mutates anything: there is
 * NO toggle control anywhere (mission §10 — a founder decision at every
 * destination, not in the shell). The whole chip links to
 * /manage-shop/channels. Hidden below `md`; mobile merchants see AI status
 * through the dashboard ConnectionHealth module (D7), not here.
 *
 * State machine (fail-closed, exact order):
 *   fetch failed          → unavailable        (never guessed, never green)
 *   zero channels         → notConnected
 *   any emergency_stop    → emergencyStop      (safety overrides modes)
 *   no CONNECTED channel
 *   or any needsReconnect → reconnectRequired  (doc 05: a channel the shop
 *                              owns but cannot receive with is an attention
 *                              state even when other channels look fine)
 *   else over CONNECTED channels' effective_mode:
 *     all AUTO  AND billing_ai_active on every one → auto
 *     all AUTO  but billing AI NOT active          → mixed (billing
 *                                                    fail-closed: a false
 *                                                    billing flag must never
 *                                                    display AUTO confidently)
 *     all MANUAL → manual · all DRAFT → draft · otherwise mixed
 * The resolver output is trusted; `mode_source` is not re-derived client-side.
 *
 * Motion: the icon + label carry the state; no pulse, no enter animation
 * (design-motion-principles frequency gate — passive status, never animated).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Bot, CircleStop, CloudOff, Hand, Layers, Link2Off, PenLine, Unplug,
  type LucideIcon,
} from 'lucide-react';
import { listMetaChannels, type MetaChannel } from '@/api/domains/meta-channels';
import { cn } from '../ui/utils';
import { SHELL_POLL_MS, useShellPolling } from './useNavBadges';

export type AiChipState =
  | 'unavailable'
  | 'notConnected'
  | 'emergencyStop'
  | 'reconnectRequired'
  | 'auto'
  | 'draft'
  | 'manual'
  | 'mixed';

const META_CHANNELS_PATH = '/manage-shop/channels';

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';

/**
 * Every state ships icon + label + aria (never color alone). Tones reuse the
 * established -100/-700 semantic pairs (SignalBadge precedent).
 */
const CHIP_PRESENCE: Record<AiChipState, { icon: LucideIcon; tone: string; labelKey: string; ariaKey: string }> = {
  unavailable: {
    icon: CloudOff,
    tone: 'border-em-border bg-em-bg-muted text-em-text-secondary',
    labelKey: 'nav.aiStatus.unavailable.label',
    ariaKey: 'nav.aiStatus.unavailable.aria',
  },
  notConnected: {
    icon: Unplug,
    tone: 'border-em-border bg-em-bg-muted text-em-text-secondary',
    labelKey: 'nav.aiStatus.notConnected.label',
    ariaKey: 'nav.aiStatus.notConnected.aria',
  },
  emergencyStop: {
    icon: CircleStop,
    tone: 'border-em-danger-700/20 bg-em-danger-100 text-em-danger-700',
    labelKey: 'nav.aiStatus.emergencyStop.label',
    ariaKey: 'nav.aiStatus.emergencyStop.aria',
  },
  reconnectRequired: {
    icon: Link2Off,
    tone: 'border-em-sunlight-600/30 bg-em-sunlight-100 text-em-sunlight-700',
    labelKey: 'nav.aiStatus.reconnectRequired.label',
    ariaKey: 'nav.aiStatus.reconnectRequired.aria',
  },
  auto: {
    icon: Bot,
    tone: 'border-em-violet-600/20 bg-em-violet-100 text-em-violet-700',
    labelKey: 'nav.aiStatus.auto.label',
    ariaKey: 'nav.aiStatus.auto.aria',
  },
  draft: {
    icon: PenLine,
    tone: 'border-em-violet-600/20 bg-em-violet-100 text-em-violet-700',
    labelKey: 'nav.aiStatus.draft.label',
    ariaKey: 'nav.aiStatus.draft.aria',
  },
  manual: {
    icon: Hand,
    tone: 'border-em-border bg-em-bg-muted text-em-text-secondary',
    labelKey: 'nav.aiStatus.manual.label',
    ariaKey: 'nav.aiStatus.manual.aria',
  },
  mixed: {
    icon: Layers,
    tone: 'border-em-info-700/20 bg-em-info-100 text-em-info-700',
    labelKey: 'nav.aiStatus.mixed.label',
    ariaKey: 'nav.aiStatus.mixed.aria',
  },
};

export function resolveAiChipState(channels: MetaChannel[] | null): AiChipState {
  if (channels === null) return 'unavailable';
  if (channels.length === 0) return 'notConnected';
  if (channels.some((channel) => channel.emergency_stop?.active === true)) return 'emergencyStop';

  const connected = channels.filter((channel) => channel.status === 'CONNECTED');
  if (connected.length === 0 || channels.some((channel) => channel.needsReconnect)) {
    return 'reconnectRequired';
  }

  const modes = new Set(connected.map((channel) => channel.effective_mode));
  if (modes.size === 1) {
    const [mode] = Array.from(modes);
    if (mode === 'AUTO') {
      // Billing fail-closed: the resolver should never hand AUTO without a
      // live AI entitlement, and if the payload ever says otherwise the chip
      // refuses to claim AUTO (A9 attack item).
      return connected.every((channel) => channel.billing_ai_active === true) ? 'auto' : 'mixed';
    }
    if (mode === 'MANUAL') return 'manual';
    if (mode === 'DRAFT') return 'draft';
  }
  return 'mixed';
}

export default function AiStatusChip() {
  const { t } = useTranslation();
  // null = first read not settled yet: render NOTHING rather than a
  // provisional claim (absence is never a false statement).
  const [state, setState] = useState<AiChipState | null>(null);
  const generationRef = useRef(0);

  const refresh = useCallback(() => {
    const generation = ++generationRef.current;
    void listMetaChannels()
      .then((channels) => {
        if (generation !== generationRef.current) return;
        setState(resolveAiChipState(Array.isArray(channels) ? channels : []));
      })
      .catch(() => {
        if (generation !== generationRef.current) return;
        setState('unavailable');
      });
  }, []);

  // Same cadence as the nav badges: 60s while the tab is visible.
  // listMetaChannels() exposes no signal parameter (existing published
  // contract), so staleness is guarded by the generation counter alone.
  useShellPolling(refresh, SHELL_POLL_MS);

  useEffect(() => () => {
    generationRef.current += 1;
  }, []);

  if (state === null) return null;
  const presence = CHIP_PRESENCE[state];
  const Icon = presence.icon;

  return (
    <Link
      to={META_CHANNELS_PATH}
      data-testid="ai-status-chip"
      data-state={state}
      aria-label={t(presence.ariaKey)}
      title={t(presence.labelKey)}
      className={cn(
        // No hover restyle: the tone pairing must survive hover (a bg/border
        // override here would fight the semantic tone in cascade order).
        'hidden md:inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold',
        FOCUS_RING,
        presence.tone,
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{t(presence.labelKey)}</span>
    </Link>
  );
}
