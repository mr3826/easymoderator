/**
 * ChannelOAuthFlowCard — picker gating. Pins the two behaviors that the
 * multi-Page fix depends on: (a) NEW connect still disables a healthy Page that
 * is already connected (dedupe), and (b) RECONNECT keeps the target Page
 * selectable even when healthy (founder re-consent decision), while a
 * non-connectable target stays disabled (the server enforces eligibility).
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ChannelOAuthFlowCard from '@/app/components/channels/ChannelOAuthFlowCard';
import type { MetaChannel, MetaOAuthAsset } from '@/api/domains/meta-channels';
import type { ActiveOAuth } from '@/app/components/channels/useMetaChannelConnection';

const channel = (over: Partial<MetaChannel>): MetaChannel => ({
  id: 'mc-1',
  shopId: 'shop-1',
  platform: 'facebook',
  metaAssetId: 'p-healthy',
  displayName: 'Healthy Page',
  pictureUrl: null,
  status: 'CONNECTED',
  isHealthy: true,
  needsReconnect: false,
  lastError: null,
  tokenExpiresAt: null,
  tokenLastRefreshedAt: null,
  webhookSubscribedFields: ['messages'],
  webhookLastVerifiedAt: null,
  connectedAt: null,
  disconnectedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  purposeLabel: null,
  ...over,
});

const page = (over: Partial<MetaOAuthAsset>): MetaOAuthAsset => ({
  id: 'p-healthy',
  name: 'Healthy Page',
  category: null,
  pictureUrl: null,
  tasks: ['MESSAGING', 'MANAGE'],
  connectable: true,
  reason: null,
  ...over,
});

function checkboxFor(name: string): HTMLInputElement {
  return screen.getByText(name).closest('label')!.querySelector('input') as HTMLInputElement;
}

const renderCard = (props: {
  activeOAuth: ActiveOAuth;
  availablePages: MetaOAuthAsset[];
  selectedPageIds?: Set<string>;
  channels?: MetaChannel[];
}) =>
  render(
    <ChannelOAuthFlowCard
      activeOAuth={props.activeOAuth}
      availablePages={props.availablePages}
      selectedPageIds={props.selectedPageIds ?? new Set()}
      isConnectingPage={false}
      channels={props.channels ?? [channel({})]}
      onCancel={vi.fn()}
      onRetryAssetLookup={vi.fn()}
      onTogglePage={vi.fn()}
      onConnectPages={vi.fn()}
    />,
  );

describe('ChannelOAuthFlowCard', () => {
  it('new connect: disables an already-connected healthy Page but allows a different one', () => {
    renderCard({
      activeOAuth: { step: 'page-select' },
      availablePages: [page({}), page({ id: 'p-new', name: 'New Page' })],
    });

    expect(checkboxFor('Healthy Page')).toBeDisabled();
    expect(checkboxFor('New Page')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Connect \(0\)/i })).toBeDisabled();
  });

  it('reconnect: keeps a HEALTHY target selectable (re-consent) while locking other Pages', () => {
    renderCard({
      activeOAuth: { step: 'page-select', reconnectChannelId: 'mc-1', reconnectAssetId: 'p-healthy' },
      availablePages: [page({}), page({ id: 'p-new', name: 'New Page' })],
      selectedPageIds: new Set(['p-healthy']),
    });

    const target = checkboxFor('Healthy Page');
    expect(target).not.toBeDisabled();
    expect(target).toBeChecked();
    expect(checkboxFor('New Page')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Connect \(1\)/i })).not.toBeDisabled();
  });

  it('reconnect: a non-connectable target stays disabled (server enforces eligibility)', () => {
    renderCard({
      activeOAuth: { step: 'page-select', reconnectChannelId: 'mc-1', reconnectAssetId: 'p-blocked' },
      availablePages: [page({ id: 'p-blocked', name: 'Blocked Page', connectable: false, reason: 'META_PAGE_TASKS_REQUIRED' })],
      selectedPageIds: new Set(['p-blocked']),
    });

    expect(checkboxFor('Blocked Page')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Connect \(0\)/i })).toBeDisabled();
  });
});
