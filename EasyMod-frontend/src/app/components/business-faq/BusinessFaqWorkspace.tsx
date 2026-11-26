/**
 * Business & FAQ Settings workspace — three-tab configuration/editor page
 * (Business Profile / FAQs / Business Policies), founder mission 2026-11-26.
 *
 * Shell ownership (mirrors the Delivery Settings tabbed shell): tablist +
 * panel container ONLY. The per-tab PageHeader signal bands are retired
 * (header-removal C1): each tab body keeps exactly one sr-only h1 for the
 * accessibility landmark, and the visible tablist provides the orientation.
 * URL compatibility: both /manage-shop/business-info and /manage-shop/faqs
 * render this workspace with the matching initial tab; nav/SettingsHub links
 * are untouched.
 */
import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ProfileTab from './ProfileTab';
import FaqTab from './FaqTab';
import PoliciesTab from './PoliciesTab';

type WorkspaceTab = 'profile' | 'faqs' | 'policies';

const TABS: { id: WorkspaceTab; labelKey: string }[] = [
  { id: 'profile', labelKey: 'manageShop.businessFaq.tabs.profile' },
  { id: 'faqs', labelKey: 'manageShop.businessFaq.tabs.faqs' },
  { id: 'policies', labelKey: 'manageShop.businessFaq.tabs.policies' },
];

const FOCUS_RING =
  'focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-em-focus-light focus-visible:transition-none';

export default function BusinessFaqWorkspace() {
  const { t } = useTranslation();
  const location = useLocation();
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(() =>
    location.pathname.endsWith('/faqs') ? 'faqs' : 'profile',
  );
  // A8 minor #3: switching tabs must NOT discard in-progress edits. Visited
  // panels stay mounted (hidden), so drafts survive round-trips; new panels
  // still lazy-mount on first visit (S7 fetch discipline).
  const [visited, setVisited] = useState<WorkspaceTab[]>([activeTab]);

  useEffect(() => {
    // Route-driven tab switches without remount keep the two URLs honest.
    setActiveTab(location.pathname.endsWith('/faqs') ? 'faqs' : 'profile');
  }, [location.pathname]);

  const moveTabFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    document.getElementById(`business-faq-tab-${TABS[nextIndex].id}`)?.focus();
    setActiveTab(TABS[nextIndex].id);
    setVisited((current) => (current.includes(TABS[nextIndex].id) ? current : [...current, TABS[nextIndex].id]));
  };

  const selectTab = (tab: WorkspaceTab) => {
    setActiveTab(tab);
    setVisited((current) => (current.includes(tab) ? current : [...current, tab]));
  };

  return (
    <div className="em-business min-h-full p-4 md:p-6">
      <div className="mx-auto w-full max-w-[1440px] space-y-4">
        <div
          role="tablist"
          aria-label={t('manageShop.businessFaq.tabs.label', {
            defaultValue: 'Business and FAQ settings sections',
          })}
          className="flex flex-wrap items-center gap-1"
        >
          {TABS.map((tab, index) => (
            <button
              key={tab.id}
              id={`business-faq-tab-${tab.id}`}
              type="button"
              role="tab"
              data-testid={`business-faq-tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`business-faq-panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => moveTabFocus(event, index)}
              className={`shrink-0 rounded-lg px-3 py-2 text-sm font-semibold ${FOCUS_RING} ${
                activeTab === tab.id
                  ? 'bg-em-violet-600 text-white'
                  : 'bg-em-bg-surface text-em-text-secondary hover:bg-em-violet-50'
              }`}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        {visited.includes('profile') && (
          <div role="tabpanel" id="business-faq-panel-profile" aria-labelledby="business-faq-tab-profile" tabIndex={-1} hidden={activeTab !== 'profile'} className={activeTab === 'profile' ? '' : 'hidden'}>
            <ProfileTab />
          </div>
        )}

        {visited.includes('faqs') && (
          <div role="tabpanel" id="business-faq-panel-faqs" aria-labelledby="business-faq-tab-faqs" tabIndex={-1} hidden={activeTab !== 'faqs'} className={activeTab === 'faqs' ? '' : 'hidden'}>
            <FaqTab />
          </div>
        )}

        {visited.includes('policies') && (
          <div role="tabpanel" id="business-faq-panel-policies" aria-labelledby="business-faq-tab-policies" tabIndex={-1} hidden={activeTab !== 'policies'} className={activeTab === 'policies' ? '' : 'hidden'}>
            <PoliciesTab />
          </div>
        )}
      </div>
    </div>
  );
}
