export type GrowthRole = 'SUPER_ADMIN' | 'GROWTH_USER';

export type LegacyGrowthRole =
  | 'FOUNDER'
  | 'GROWTH_MANAGER'
  | 'BUSINESS_EXECUTIVE'
  | 'MARKETER'
  | 'CUSTOMER_SUCCESS'
  | 'READ_ONLY_ANALYST';

export interface GrowthSession {
  internalUserId: string;
  displayName: string;
  role: GrowthRole;
  legacyRole: LegacyGrowthRole | null;
  permissions: string[];
}

export interface SigninPayload {
  email: string;
  password: string;
}

export interface SigninResult {
  requires2fa?: boolean;
  tempToken?: string;
  authenticated?: boolean;
  requiresPasswordChange?: boolean;
  temporaryPasswordExpiresAt?: string;
}

export const PROSPECT_STATUSES = [
  'new',
  'contacted',
  'qualifying',
  'qualified',
  'onboarding',
  'disqualified',
  'unreachable',
  'converted',
  'merged',
] as const;

export type ProspectStatus = typeof PROSPECT_STATUSES[number];

export const PROSPECT_ALLOWED_TRANSITIONS: Record<ProspectStatus, readonly ProspectStatus[]> = {
  new: ['contacted', 'disqualified', 'unreachable'],
  contacted: ['qualifying', 'disqualified', 'unreachable'],
  qualifying: ['qualified', 'disqualified', 'unreachable'],
  qualified: ['onboarding', 'disqualified', 'unreachable'],
  onboarding: ['qualified', 'disqualified', 'unreachable'],
  disqualified: ['qualifying'],
  unreachable: ['contacted'],
  converted: [],
  merged: [],
};

export const PROSPECT_SOURCES = [
  'self_signup',
  'partner_form',
  'manual_entry',
  'referral_mention',
  'inbound_message',
  'event',
  'browser_extension',
  'facebook',
  'facebook_group',
  'website',
  'linkedin',
  'partner',
  'paid',
  'other',
] as const;

export type ProspectSource = typeof PROSPECT_SOURCES[number];

export type ProspectMetadata = Record<string, unknown>;

export interface ProspectListItem {
  id: string;
  businessName: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  pageUrl: string | null;
  niche: string | null;
  notes: string | null;
  source: ProspectSource;
  sourceDetail: string | null;
  sourceReference: string | null;
  sourceRecordedAt: string | null;
  status: ProspectStatus;
  statusChangedAt: string | null;
  disqualifiedReason: string | null;
  ownerUserId: string | null;
  ownerDisplayName?: string | null;
  ownerEmail?: string | null;
  assignedAt: string | null;
  assignedBy: string | null;
  linkedShopId: string | null;
  linkedUserId: string | null;
  linkedAt: string | null;
  mergedIntoId: string | null;
  mergedAt: string | null;
  createdBy: string | null;
  metadata: ProspectMetadata | null;
  createdAt: string;
  updatedAt: string;
  redacted?: true;
}

export interface ProspectTimelineEvent {
  id: string;
  eventType: string;
  actorUserId: string | null;
  actorDisplayName: string | null;
  actorRedacted?: boolean;
  fromValue: string | null;
  toValue: string | null;
  reason: string | null;
  changedFields: string[];
  metadata: ProspectMetadata | null;
  createdAt: string;
}

export interface Prospect extends ProspectListItem {
  timeline: ProspectTimelineEvent[];
  timelinePagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export interface ProspectLinkageSuggestion {
  userId: string | null;
  shopId: string;
  shopName: string;
  matchedFields: string[];
}

export interface ProspectListResponse {
  items: ProspectListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ProspectListFilters {
  status?: ProspectStatus | '';
  source?: ProspectSource | '';
  ownerUserId?: string;
  owner?: string;
  q?: string;
  linked?: boolean | '' | 'true' | 'false';
  stage?: 'qualified';
  stalled?: boolean | 'true';
  activated?: boolean | 'true';
  stalledBefore?: string;
  createdAfter?: string;
  createdBefore?: string;
  statusChangedAfter?: string;
  statusChangedBefore?: string;
  sourceRecordedAfter?: string;
  sourceRecordedBefore?: string;
  page?: number;
  pageSize?: number;
}

export interface ProspectFormPayload {
  businessName: string;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  pageUrl?: string | null;
  niche?: string | null;
  notes?: string | null;
  source: ProspectSource;
  sourceDetail?: string | null;
}

export type ProspectUpdatePayload = Partial<ProspectFormPayload>;

export interface ProspectDuplicateCheckPayload {
  contactPhone?: string;
  contactEmail?: string;
  pageUrl?: string;
  excludeId?: string;
  exclude_id?: string;
}

export interface ProspectDuplicateMatch {
  prospectId: string;
  businessName: string;
  status: ProspectStatus;
  matchedFields: string[];
}

export interface ProspectDuplicateCheckResponse {
  matches: ProspectDuplicateMatch[];
}

export interface ProspectAssignmentPayload {
  ownerUserId: string | null;
  reason: string;
}

export interface GrowthAssignee {
  userId: string;
  displayName: string;
  email: string | null;
  role: GrowthRole;
}

export interface ProspectStatusPayload {
  status: ProspectStatus;
  reason?: string;
}

export interface ProspectLinkPayload {
  shopId?: string | null;
  userId?: string | null;
  reason: string;
}

export interface ProspectMergePayload {
  targetProspectId: string;
  reason: string;
}

export interface ProspectMergeResult {
  mergedProspect: ProspectListItem;
  targetProspect: ProspectListItem;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '';
const REQUEST_TIMEOUT_MS = 10000;
let csrfToken: string | null = null;
const CSRF_EXEMPT_PATHS = new Set([
  '/api/auth/signup',
  '/api/auth/signin',
  '/api/auth/refresh',
  '/api/auth/forgot-password',
  '/api/auth/reset-password',
  '/api/auth/2fa/verify',
]);

async function initCsrfToken(): Promise<void> {
  if (csrfToken) return;
  const response = await fetch(`${apiBaseUrl}/api/csrf`, {
    credentials: 'include',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || typeof payload?.csrfToken !== 'string') {
    throw new ApiError('Unable to initialize secure session.', response.status || 503);
  }
  csrfToken = payload.csrfToken;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const needsCsrf = isMutation && !CSRF_EXEMPT_PATHS.has(path);
  if (needsCsrf) await initCsrfToken();

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      credentials: 'include',
      signal: controller.signal,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(csrfToken && needsCsrf ? { 'X-CSRF-Token': csrfToken } : {}),
        ...options.headers,
      },
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const details = payload?.details
        ?? payload?.error?.details
        ?? (typeof payload?.conflictingProspectId === 'string'
          ? { conflictingProspectId: payload.conflictingProspectId }
          : undefined)
        ?? (typeof payload?.error?.conflictingProspectId === 'string'
          ? { conflictingProspectId: payload.error.conflictingProspectId }
          : undefined);
      throw new ApiError(
        payload?.message || payload?.error?.message || 'Request failed',
        response.status,
        payload?.code || payload?.error?.code,
        details,
      );
    }

    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('The request timed out. Please try again.', 408, 'REQUEST_TIMEOUT');
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function addQueryValue(params: URLSearchParams, key: string, value: string | undefined) {
  const trimmed = value?.trim();
  if (trimmed) params.set(key, trimmed);
}

function boundedPageSize(value: number | undefined) {
  if (!value || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(1, Math.floor(value)));
}

function conflictingProspectId(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const value = (details as { conflictingProspectId?: unknown }).conflictingProspectId;
  return typeof value === 'string' ? value : undefined;
}

export function getConflictingProspectId(error: unknown): string | undefined {
  return error instanceof ApiError ? conflictingProspectId(error.details) : undefined;
}

export const growthApi = {
  async getSession(): Promise<GrowthSession> {
    const payload = await request<{ success: true; data: GrowthSession }>('/api/internal/growth-os/session');
    return payload.data;
  },

  async signin(credentials: SigninPayload): Promise<SigninResult> {
    const payload = await request<{ data: SigninResult }>('/api/auth/signin', {
      method: 'POST',
      body: JSON.stringify(credentials),
    });
    if (!payload?.data?.requires2fa) {
      csrfToken = null;
      await initCsrfToken().catch(() => undefined);
    }
    return payload.data;
  },

  async verifyTwoFactor(tempToken: string, token: string): Promise<SigninResult> {
    const payload = await request<{ data: SigninResult }>('/api/auth/2fa/verify', {
      method: 'POST',
      body: JSON.stringify({ tempToken, token }),
    });
    csrfToken = null;
    await initCsrfToken().catch(() => undefined);
    return payload.data;
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await request('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    csrfToken = null;
  },

  async refresh(): Promise<void> {
    await request('/api/auth/refresh', { method: 'POST' });
  },

  async logout(): Promise<void> {
    await request('/api/auth/logout', { method: 'POST' });
  },

  async getProspects(filters: ProspectListFilters = {}): Promise<ProspectListResponse> {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.source) params.set('source', filters.source);
    addQueryValue(params, 'ownerUserId', filters.ownerUserId);
    addQueryValue(params, 'owner', filters.owner);
    addQueryValue(params, 'q', filters.q);
    if (filters.linked !== undefined && filters.linked !== '') params.set('linked', String(filters.linked));
    addQueryValue(params, 'stage', filters.stage);
    if (filters.stalled) params.set('stalled', String(filters.stalled));
    if (filters.activated) params.set('activated', String(filters.activated));
    addQueryValue(params, 'stalledBefore', filters.stalledBefore);
    addQueryValue(params, 'createdAfter', filters.createdAfter);
    addQueryValue(params, 'createdBefore', filters.createdBefore);
    addQueryValue(params, 'statusChangedAfter', filters.statusChangedAfter);
    addQueryValue(params, 'statusChangedBefore', filters.statusChangedBefore);
    addQueryValue(params, 'sourceRecordedAfter', filters.sourceRecordedAfter);
    addQueryValue(params, 'sourceRecordedBefore', filters.sourceRecordedBefore);
    if (filters.page) params.set('page', String(Math.max(1, Math.floor(filters.page))));
    const pageSize = boundedPageSize(filters.pageSize);
    if (pageSize) params.set('pageSize', String(pageSize));
    const query = params.toString();
    const payload = await request<{ success: true; data: ProspectListResponse }>(
      `/api/internal/growth-os/prospects${query ? `?${query}` : ''}`,
    );
    return payload.data;
  },

  async getEligibleAssignees(search = ''): Promise<GrowthAssignee[]> {
    const params = new URLSearchParams();
    if (search.trim()) params.set('search', search.trim());
    const query = params.toString();
    const payload = await request<{ success: true; data: GrowthAssignee[] }>(
      `/api/internal/growth-os/prospect-owners${query ? `?${query}` : ''}`,
    );
    return payload.data;
  },

  async getProspect(id: string, pagination: { timelinePage?: number; timelinePageSize?: number } = {}): Promise<Prospect> {
    const params = new URLSearchParams();
    if (pagination.timelinePage) params.set('timelinePage', String(Math.max(1, Math.floor(pagination.timelinePage))));
    if (pagination.timelinePageSize) {
      params.set('timelinePageSize', String(boundedPageSize(pagination.timelinePageSize)));
    }
    const query = params.toString();
    const payload = await request<{ success: true; data: Prospect }>(
      `/api/internal/growth-os/prospects/${encodeURIComponent(id)}${query ? `?${query}` : ''}`,
    );
    return payload.data;
  },

  async createProspect(data: ProspectFormPayload): Promise<ProspectListItem> {
    const payload = await request<{ success: true; data: ProspectListItem }>(
      '/api/internal/growth-os/prospects',
      { method: 'POST', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async updateProspect(id: string, data: ProspectUpdatePayload): Promise<ProspectListItem> {
    const payload = await request<{ success: true; data: ProspectListItem }>(
      `/api/internal/growth-os/prospects/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async checkProspectDuplicates(
    data: ProspectDuplicateCheckPayload,
  ): Promise<ProspectDuplicateCheckResponse> {
    const payload = await request<{ success: true; data: ProspectDuplicateCheckResponse }>(
      '/api/internal/growth-os/prospects/duplicate-check',
      { method: 'POST', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async assignProspect(id: string, data: ProspectAssignmentPayload): Promise<ProspectListItem> {
    const payload = await request<{ success: true; data: ProspectListItem }>(
      `/api/internal/growth-os/prospects/${encodeURIComponent(id)}/assign`,
      { method: 'POST', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async transitionProspectStatus(id: string, data: ProspectStatusPayload): Promise<ProspectListItem> {
    const payload = await request<{ success: true; data: ProspectListItem }>(
      `/api/internal/growth-os/prospects/${encodeURIComponent(id)}/status`,
      { method: 'POST', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async linkProspect(id: string, data: ProspectLinkPayload): Promise<ProspectListItem> {
    const payload = await request<{ success: true; data: ProspectListItem }>(
      `/api/internal/growth-os/prospects/${encodeURIComponent(id)}/link`,
      { method: 'POST', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async getProspectLinkageSuggestions(id: string): Promise<ProspectLinkageSuggestion[]> {
    const payload = await request<{ success: true; data: ProspectLinkageSuggestion[] }>(
      `/api/internal/growth-os/prospects/${encodeURIComponent(id)}/linkage-suggestions`,
    );
    return payload.data;
  },

  async mergeProspect(id: string, data: ProspectMergePayload): Promise<ProspectMergeResult> {
    const payload = await request<{ success: true; data: ProspectMergeResult }>(
      `/api/internal/growth-os/prospects/${encodeURIComponent(id)}/merge`,
      { method: 'POST', body: JSON.stringify(data) },
    );
    return payload.data;
  },
};

// ── Workspace: home, analytics, search, follow-ups, notes ───────────────────

export interface HomeResponse {
  generatedAt: string;
  windows: {
    attentionSince: string;
    attentionUntil: string;
    stalledBefore: string;
    businessTimeZone: string;
  };
  myWork: {
    followupsOverdueMine: number;
    followupsOpenMine: number;
    prospectsAssignedToMe: number;
  };
  growthAttention: {
    newLeadsLast7d: number;
  qualifiedOpen: number;
  unassignedQualified: number;
    onboardingOpen: number;
    onboardingStalledOver15d: number;
    qualifiedStalledOver15d: number;
    convertedLast7d: number;
    followupsOverdueInScope: number;
    followupsDueTodayInScope: number;
  };
  merchantAttention?: { merchantsTotal: number };
  platformAttention?: {
    metaChannelsUnhealthy: number;
    paymentTransactionsStuckOver24h: number;
    subscriptionsSuspended: number;
  };
  recentPrivilegedActions?: Array<{
    id: string;
    actor: { userId: string; name: string | null } | null;
    action: string;
    resourceType: string;
    createdAt: string;
    reason: string | null;
  }>;
}

export interface GrowthAnalyticsResponse {
  windowDays: number;
  generatedAt: string;
  funnel: {
    created: number;
    contactedOrBeyond: number;
    qualified: number;
    onboarding: number;
    activated: number;
    lost: number;
  };
  conversion: { createdToActivated: number | null };
  byStatus: Partial<Record<ProspectStatus, number>>;
  bySource: Partial<Record<ProspectSource, number>>;
  activatedBySource: Partial<Record<ProspectSource, number>>;
  sourceToActivation: Partial<Record<ProspectSource, number | null>>;
  lostReasons: Record<string, number>;
  timing: {
    medianHoursToFirstContact: number | null;
    medianHoursToQualification: number | null;
    medianHoursToFirstFollowup: number | null;
    medianHoursCreatedToActivated: number | null;
  };
  leadToActivation: number | null;
  followupDiscipline: {
    total: number;
    open: number;
    completed: number;
    cancelled: number;
    completedOnTime: number;
    completedLate: number;
    overdueOpen: number;
    onTimeRatePct: number | null;
  };
  byOwner: Array<{
    ownerUserId: string | null;
    displayName: string;
    created: number;
    qualified: number;
    converted: number;
    qualificationRatePct: number | null;
    activationRatePct: number | null;
  }>;
  unassigned: {
    openCount: number;
    oldestSourceRecordedAt: string | null;
    oldestAgeDays: number | null;
  };
  cohort: {
    basis: 'source_recorded_at';
    importedAt: 'created_at';
    eventAt: 'prospect_events.created_at';
    sourceRecordedFrom?: string;
    sourceRecordedTo?: string;
  };
  notAvailable: string[];
}

export interface SearchResults {
  prospects: Array<SearchProspectResult>;
  merchants: Array<SearchMerchantResult>;
  users: Array<SearchUserResult>;
}

export interface SearchProspectResult {
  prospectId: string;
  businessName: string;
  status: ProspectStatus;
  source: ProspectSource;
  ownerUserId: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
}

export interface SearchMerchantResult {
  shopId: string;
  merchantName: string;
  uniqueCode?: string;
  planName?: string | null;
  subscriptionStatus?: string | null;
  owner?: { name: string | null; email: string | null } | null;
  signupDate?: string;
  activated?: boolean;
}

export interface SearchUserResult {
  userId: string;
  email: string;
  displayName: string | null;
}

export type FollowupState = 'open' | 'completed' | 'cancelled' | 'overdue' | 'due_today' | 'all';

export interface Followup {
  id: string;
  prospectId: string;
  prospectName: string | null;
  ownerUserId: string | null;
  createdByUserId: string | null;
  dueAt: string;
  action: string;
  note: string | null;
  status: 'open' | 'completed' | 'cancelled';
  completedAt: string | null;
  overdue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FollowupListResponse {
  items: Followup[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FollowupCreatePayload {
  prospectId: string;
  ownerUserId?: string | null;
  dueAt: string;
  action: string;
  note?: string | null;
}

export interface FollowupUpdatePayload {
  ownerUserId?: string;
  dueAt?: string;
  action?: string;
  note?: string | null;
}

export interface InternalNote {
  id: string;
  targetType: 'prospect' | 'user' | 'shop';
  targetId: string;
  authorUserId: string | null;
  authorDisplayName: string | null;
  authorRedacted?: boolean;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface InternalNoteListResponse {
  items: InternalNote[];
  total: number;
  page: number;
  pageSize: number;
}

export const workspaceApi = {
  async home(): Promise<HomeResponse> {
    const payload = await request<{ success: true; data: HomeResponse }>('/api/internal/growth-os/home');
    return payload.data;
  },

  async growthAnalytics(windowDays = 90): Promise<GrowthAnalyticsResponse> {
    const payload = await request<{ success: true; data: GrowthAnalyticsResponse }>(
      `/api/internal/growth-os/analytics/growth?window=${Math.min(365, Math.max(7, Math.floor(windowDays)))}`,
    );
    return payload.data;
  },

  async search(q: string): Promise<SearchResults> {
    const payload = await request<{ success: true; data: SearchResults }>(
      '/api/internal/growth-os/search',
      { method: 'POST', body: JSON.stringify({ q: q.trim() }) },
    );
    return payload.data;
  },

  async listFollowups(filters: { prospectId?: string; state?: FollowupState; owner?: 'me'; page?: number; pageSize?: number } = {}): Promise<FollowupListResponse> {
    const params = new URLSearchParams();
    addQueryValue(params, 'prospectId', filters.prospectId);
    addQueryValue(params, 'state', filters.state);
    addQueryValue(params, 'owner', filters.owner);
    if (filters.page) params.set('page', String(Math.max(1, Math.floor(filters.page))));
    const pageSize = boundedPageSize(filters.pageSize);
    if (pageSize) params.set('pageSize', String(pageSize));
    const query = params.toString();
    const payload = await request<{ success: true; data: FollowupListResponse }>(
      `/api/internal/growth-os/followups${query ? `?${query}` : ''}`,
    );
    return payload.data;
  },

  async createFollowup(data: FollowupCreatePayload): Promise<Followup> {
    const payload = await request<{ success: true; data: Followup }>(
      '/api/internal/growth-os/followups',
      { method: 'POST', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async updateFollowup(id: string, data: FollowupUpdatePayload): Promise<Followup> {
    const payload = await request<{ success: true; data: Followup }>(
      `/api/internal/growth-os/followups/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async transitionFollowup(id: string, status: 'completed' | 'cancelled'): Promise<Followup> {
    const payload = await request<{ success: true; data: Followup }>(
      `/api/internal/growth-os/followups/${encodeURIComponent(id)}/status`,
      { method: 'POST', body: JSON.stringify({ status }) },
    );
    return payload.data;
  },

  async listNotes(
    targetType: InternalNote['targetType'],
    targetId: string,
    pagination: { page?: number; pageSize?: number } = {},
  ): Promise<InternalNoteListResponse> {
    const params = new URLSearchParams({ targetType, targetId });
    if (pagination.page) params.set('page', String(Math.max(1, Math.floor(pagination.page))));
    const pageSize = boundedPageSize(pagination.pageSize);
    if (pageSize) params.set('pageSize', String(pageSize));
    const payload = await request<{ success: true; data: InternalNoteListResponse }>(
      `/api/internal/growth-os/notes?${params.toString()}`,
    );
    return payload.data;
  },

  async createNote(data: { targetType: InternalNote['targetType']; targetId: string; body: string }): Promise<InternalNote> {
    const payload = await request<{ success: true; data: InternalNote }>(
      '/api/internal/growth-os/notes',
      { method: 'POST', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async deleteNote(id: string): Promise<{ deleted: boolean }> {
    const payload = await request<{ success: true; data: { deleted: boolean } }>(
      `/api/internal/growth-os/notes/${encodeURIComponent(id)}/delete`,
      { method: 'POST' },
    );
    return payload.data;
  },
};

// ── Merchants (role-shaped: SUPER_ADMIN 360, GROWTH_USER masked insight) ────

export interface MerchantAdminRow {
  id: string;
  shopName: string | null;
  owner: { name: string | null; email: string | null; phone: string | null } | null;
  plan: string | null;
  status: string | null;
  channelCount: number;
  conversationsUsed: number | null;
  conversationsLimit: number | null;
  createdAt: string;
}

export interface MerchantInsightRow {
  shopId: string;
  merchantName: string | null;
  signupDate: string;
  planName: string | null;
  activatedAt: string | null;
  facebookConnected: boolean;
  linkedProspects: string[];
}

export interface Merchant360 {
  overview: {
    shop: { id: string; shopName: string | null; uniqueCode: string; isActive: boolean; timezone: string; createdAt: string };
    owner: { id: string; name: string | null; email: string; phone: string | null } | null;
    subscription: { planName: string | null; status: string | null; currentPeriodEnd: string | null };
    usage: {
      conversationsUsed: number | null;
      conversationsLimit: number | null;
      effectiveConversationLimit: number | null;
      topupBalance: number | null;
    };
    onboarding: { completed: boolean };
    activation: { activatedAt: string | null; firstConversationId: string | null };
    ai: { configured: boolean; automationMode: string | null; draftModeEnabled: unknown };
    lastActivityAt: string | null;
  };
  growth: {
    linkedProspects: Array<{
      prospectId: string;
      businessName: string;
      status: ProspectStatus;
      source: ProspectSource;
      ownerUserId: string | null;
      linkedAt: string | null;
    }>;
  };
  subscription: {
    plan: { code: string; name: string; cycle: string; model: string };
    status: string;
    period: { start: string; end: string; nextBillingDate: string | null };
    usage: {
      conversationsUsed: number | null;
      conversationsLimit: number | null;
      effectiveLimit: number | null;
      topupBalance: number | null;
    };
    invoices: Array<{
      id: string;
      invoiceNumber: string;
      type: string | null;
      amount: number;
      status: string;
      dueDate: string | null;
      paidAt: string | null;
      createdAt: string;
    }>;
    outstandingAmount: number;
  } | null;
  facebook: {
    channels: Array<{
      id: string;
      displayName: string | null;
      platform: string;
      status: 'CONNECTED' | 'TOKEN_EXPIRED' | 'REVOKED' | 'DISCONNECTED' | 'ERROR';
      tokenExpiresAt: string | null;
      webhookLastVerifiedAt: string | null;
      webhookSubscribedFields: string[] | null;
      lastError: string | null;
      connectedAt: string | null;
    }>;
  };
  notes: Merchant360Note[];
}

export interface Merchant360Note {
  id: string;
  targetType: 'prospect' | 'user' | 'shop';
  targetId: string;
  author: { userId: string; name: string | null } | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface MerchantInsight {
  shopId: string;
  merchantName: string | null;
  signupDate: string;
  planName: string | null;
  subscriptionStatus: string | null;
  activation: { activatedAt: string | null; state: 'activated' | 'not_activated' };
  facebook: { connected: boolean };
  linkedProspects: Array<{
    prospectId: string;
    businessName: string;
    status: ProspectStatus;
    source: ProspectSource;
    createdAt: string;
  }>;
}

export interface OperationsResponse {
  windowDays: number;
  generatedAt: string;
  merchants: { total: number; newInWindow: number };
  subscriptions: Record<string, number>;
  payments: { stuckOver24h: number; failedInWindow: number };
  meta: { channelsNeedingAttention: number };
  ai: { messagesInWindow: number | null; conversationsInWindow: number };
}

export interface PrivilegedAuditEntry {
  id: string;
  actor: { userId: string; name: string | null } | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  shopId: string | null;
  ipAddress: string | null;
  createdAt: string;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  reason: string | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize?: number;
  limit?: number;
}

function paginatedData<T>(path: string): Promise<Paginated<T>> {
  return request<{ success: true; data: Paginated<T> }>(path).then((payload) => payload.data);
}

export const merchantsApi = {
  async list(params: { search?: string; page?: number; pageSize?: number } = {}): Promise<Paginated<MerchantAdminRow | MerchantInsightRow>> {
    const query = new URLSearchParams();
    addQueryValue(query, 'search', params.search);
    if (params.page) query.set('page', String(params.page));
    if (params.pageSize) query.set('pageSize', String(params.pageSize));
    const qs = query.toString();
    return paginatedData(`/api/internal/growth-os/merchants${qs ? `?${qs}` : ''}`);
  },

  async detail(shopId: string): Promise<Merchant360 | MerchantInsight> {
    const payload = await request<{ success: true; data: Merchant360 | MerchantInsight }>(
      `/api/internal/growth-os/merchants/${encodeURIComponent(shopId)}`,
    );
    return payload.data;
  },
};

export const adminApi = {
  async setMerchantStatus(shopId: string, data: { active: boolean; reason: string }): Promise<unknown> {
    const payload = await request<{ success: true; data: unknown }>(
      `/api/internal/growth-os/admin/merchants/${encodeURIComponent(shopId)}/status`,
      { method: 'POST', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async grantMerchantCredits(shopId: string, data: { amount: number; reason: string }, idempotencyKey: string): Promise<unknown> {
    const payload = await request<{ success: true; data: unknown }>(
      `/api/internal/growth-os/admin/merchants/${encodeURIComponent(shopId)}/grant-credits`,
      {
        method: 'POST',
        body: JSON.stringify(data),
        headers: { 'Idempotency-Key': idempotencyKey },
      },
    );
    return payload.data;
  },

  async requestChannelReconnect(shopId: string, channelId: string, data: { reason: string; confirm: 'RECONNECT' }): Promise<unknown> {
    const payload = await request<{ success: true; data: unknown }>(
      `/api/internal/growth-os/admin/merchants/${encodeURIComponent(shopId)}/channels/${encodeURIComponent(channelId)}/reconnect-request`,
      { method: 'POST', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async operations(windowDays = 7): Promise<OperationsResponse> {
    const payload = await request<{ success: true; data: OperationsResponse }>(
      `/api/internal/growth-os/admin/operations?window=${Math.min(90, Math.max(1, Math.floor(windowDays)))}`,
    );
    return payload.data;
  },

  async auditLogs(params: { search?: string; resourceType?: string; page?: number; pageSize?: number } = {}): Promise<Paginated<PrivilegedAuditEntry>> {
    const query = new URLSearchParams();
    addQueryValue(query, 'search', params.search);
    addQueryValue(query, 'resourceType', params.resourceType);
    if (params.page) query.set('page', String(params.page));
    if (params.pageSize) query.set('pageSize', String(params.pageSize));
    const qs = query.toString();
    return paginatedData(`/api/internal/growth-os/admin/audit${qs ? `?${qs}` : ''}`);
  },
};

// ── Growth OS user management (SUPER_ADMIN) ─────────────────────────────────

export interface GrowthUserRow {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: GrowthRole;
  legacyRole: LegacyGrowthRole | null;
  status: 'active' | 'suspended' | 'revoked';
  mfaEnabled: boolean;
  grantedAt: string;
  revokedAt: string | null;
  lastLoginAt: string | null;
}

export interface GrowthUserCreateResponse {
  user: { userId: string; email: string; displayName: string; role: GrowthRole; status: string };
  initialPassword: string;
  temporaryPasswordExpiresAt: string;
}

export const growthUsersApi = {
  async list(search = ''): Promise<GrowthUserRow[]> {
    const payload = await request<{ success: true; data: GrowthUserRow[] }>(
      '/api/internal/growth-os/admin/users/search',
      { method: 'POST', body: JSON.stringify({ search: search.trim() }) },
    );
    return payload.data;
  },

  async create(data: { email: string; fullName: string; role: GrowthRole; reason: string }): Promise<GrowthUserCreateResponse> {
    const payload = await request<{ success: true; data: GrowthUserCreateResponse }>(
      '/api/internal/growth-os/admin/users',
      { method: 'POST', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async setStatus(userId: string, data: { active: boolean; reason: string }): Promise<unknown> {
    const payload = await request<{ success: true; data: unknown }>(
      `/api/internal/growth-os/admin/users/${encodeURIComponent(userId)}/status`,
      { method: 'POST', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async setRole(userId: string, data: { role: GrowthRole; reason: string }): Promise<unknown> {
    const payload = await request<{ success: true; data: unknown }>(
      `/api/internal/growth-os/admin/users/${encodeURIComponent(userId)}/role`,
      { method: 'POST', body: JSON.stringify(data) },
    );
    return payload.data;
  },

  async revokeAccess(userId: string, reason: string): Promise<unknown> {
    const payload = await request<{ success: true; data: unknown }>(
      `/api/internal/growth-os/admin/users/${encodeURIComponent(userId)}/revoke-access`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
    return payload.data;
  },

  async resetPassword(userId: string, reason: string): Promise<{ userId: string; email: string; initialPassword: string; temporaryPasswordExpiresAt: string }> {
    const payload = await request<{ success: true; data: { userId: string; email: string; initialPassword: string; temporaryPasswordExpiresAt: string } }>(
      `/api/internal/growth-os/admin/users/${encodeURIComponent(userId)}/reset-password`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
    return payload.data;
  },

  async revokeSessions(userId: string, reason: string): Promise<unknown> {
    const payload = await request<{ success: true; data: unknown }>(
      `/api/internal/growth-os/admin/users/${encodeURIComponent(userId)}/revoke-sessions`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    );
    return payload.data;
  },
};
