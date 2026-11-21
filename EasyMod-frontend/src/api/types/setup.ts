export type SetupTaskKey =
  | 'connect_channel'
  | 'shop_profile'
  | 'first_product'
  | 'ai_settings';

export type SetupTaskStatus = 'complete' | 'incomplete';

export interface SetupTaskWarning {
  code: string;
  message: string;
}

export interface SetupTask {
  key: SetupTaskKey;
  title: string;
  description: string;
  status: SetupTaskStatus;
  required: boolean;
  ctaLabel: string;
  href: string;
  missing: string[];
  warnings: SetupTaskWarning[];
  meta: Record<string, unknown>;
}

/**
 * P04 — the backend distinguishes configuration from operation. These states
 * describe the live evidence ladder only; `isComplete` still means
 * "configuration complete" and must never be rendered as operational proof.
 */
export type SetupOperationalState =
  | 'configured'
  | 'waiting_for_test'
  | 'action_required'
  | 'verified_operational';

export interface SetupOperationalEvidence {
  webhook: {
    connectedFacebookPages: number;
    verifiedEver: number;
    verifiedWithinWindow: number;
    lastVerifiedAt: string | null;
  };
  assistant: {
    draftsGenerated: number;
    draftsApproved: number;
    providerAcceptedEver: number;
    providerAcceptedWithinWindow: number;
    /** Creation time of the newest approved+accepted reply — the message
     *  model carries no acceptance timestamp, so the name says what it is. */
    lastAcceptedReplyCreatedAt: string | null;
    approvedSendFailures: number;
    outboxNeedsReconciliation: number;
  };
}

export interface SetupOperational {
  state: SetupOperationalState;
  operationalVerified: boolean;
  evidenceWindowDays: number;
  warnings: SetupTaskWarning[];
  evidence: SetupOperationalEvidence;
}

export interface SetupStatus {
  isComplete: boolean;
  completedCount: number;
  totalCount: number;
  progressPercent: number;
  tasks: SetupTask[];
  counts: {
    connectedFacebookPages: number;
    webhookVerifiedFacebookPages: number;
    activeProducts: number;
    activeFaqs?: number;
    knowledgeDocuments?: number;
    aiMessagesSent?: number;
  };
  /** Absent on older responses — treat as "configured", never as verified. */
  operational?: SetupOperational;
  generatedAt: string;
}
