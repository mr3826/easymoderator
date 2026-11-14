/**
 * Commercial contract + claim decisions API domain (ADR-0011).
 *
 * Fail-closed validation:
 *   - the public contract payload must match the frontend mirror exactly
 *     (same version, same unit price, zero subscription fees, no entitlement)
 *   - a claim decision payload must be complete and self-consistent
 * There is NO price fallback: an incomplete or drifted payload throws instead
 * of rendering a number the backend did not publish.
 */

import { useQuery } from "@tanstack/react-query";
import type { AxiosResponse } from "axios";
import { httpClient } from "@/shared/lib/http/client";
import { publicApiGet } from "@/shared/lib/http/public-client";
import {
  COMMERCIAL_CONTRACT,
  COMMERCIAL_CONTRACT_VERSION,
} from "@/shared/contracts/commercial-contract";
import type { ApiResponse } from "../types/common";
import {
  CLAIM_MODES,
  CLAIM_RENDERS,
  CLAIM_SURFACES,
  type ClaimDecision,
  type ClaimDecisionPayload,
  type ClaimLocale,
  type ClaimSurface,
  type PublicClaimDescriptor,
  type PublicCommercialContractPayload,
} from "../types/commercial";

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === "object" && !Array.isArray(value)
);

function fail(message: string): never {
  throw new Error(`Commercial contract payload rejected: ${message}`);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") fail(`${label}.${key} must be a boolean`);
  return value;
}

function requireFiniteNumber(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label}.${key} must be a finite number`);
  }
  return value;
}

function requireInteger(record: Record<string, unknown>, key: string, label: string): number {
  const value = requireFiniteNumber(record, key, label);
  if (!Number.isInteger(value)) fail(`${label}.${key} must be an integer`);
  return value;
}

function requireStringArray(record: Record<string, unknown>, key: string, label: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    fail(`${label}.${key} must be an array of strings`);
  }
  return value as string[];
}

function requireClaimSurface(value: unknown, label: string): ClaimSurface {
  if (typeof value !== "string" || !(CLAIM_SURFACES as readonly string[]).includes(value)) {
    fail(`${label} must be a known claim surface`);
  }
  return value as ClaimSurface;
}

function requireClaimLocale(value: unknown, label: string): ClaimLocale {
  if (value !== "en" && value !== "bn") fail(`${label} must be 'en' or 'bn'`);
  return value;
}

function validateI18nKey(value: unknown, label: string): { en: string; bn: string } {
  const record = requireRecord(value, label);
  return {
    en: requireString(record, "en", label),
    bn: requireString(record, "bn", label),
  };
}

function parsePublicClaimDescriptors(value: unknown): PublicClaimDescriptor[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("claims must be a non-empty array");
  }
  return value.map((raw, index) => {
    const label = `claims[${index}]`;
    const record = requireRecord(raw, label);
    const surfaces = record.surfaces;
    if (!Array.isArray(surfaces) || surfaces.length === 0) fail(`${label}.surfaces must not be empty`);
    return {
      id: requireString(record, "id", label),
      verified_scope: record.verified_scope === null
        ? null
        : requireString(record, "verified_scope", label),
      surfaces: surfaces.map((surface) => requireClaimSurface(surface, `${label}.surfaces[]`)),
      i18n_key: validateI18nKey(record.i18n_key, `${label}.i18n_key`),
      fallback_i18n_key: record.fallback_i18n_key === null || record.fallback_i18n_key === undefined
        ? null
        : validateI18nKey(record.fallback_i18n_key, `${label}.fallback_i18n_key`),
    };
  });
}

/**
 * Public decisions are the same frozen ClaimDecision shape as the authenticated
 * endpoint, evaluated with no shop context. Every decision must agree with the
 * payload's contract version and registry hash.
 */
function parsePublicClaimDecisions(
  value: unknown,
  contractVersion: string,
  registryHash: string,
): ClaimDecision[] {
  if (!Array.isArray(value)) fail("decisions must be an array");
  return value.map((raw, index) => {
    const parsed = parseClaimDecision(raw, index);
    if (parsed.contractVersion !== contractVersion) {
      fail(`decisions[${index}].contractVersion does not match the payload`);
    }
    if (parsed.registryHash !== registryHash) {
      fail(`decisions[${index}].registryHash does not match the payload`);
    }
    return parsed;
  });
}

/**
 * Validate the public contract payload against the hand-mirrored frontend
 * contract. Any drift throws; no value is ever substituted.
 */
export function parsePublicCommercialContract(payload: unknown): PublicCommercialContractPayload {
  const data = requireRecord(payload, "payload");

  if (requireString(data, "contract_version", "payload") !== COMMERCIAL_CONTRACT_VERSION) {
    fail("contract_version does not match the frontend contract mirror");
  }
  const contractHash = requireString(data, "contract_hash", "payload");
  if (!SHA256_RE.test(contractHash)) fail("contract_hash is not a sha256 digest");
  const registryHash = requireString(data, "registry_hash", "payload");
  if (!SHA256_RE.test(registryHash)) fail("registry_hash is not a sha256 digest");

  if (requireString(data, "model", "payload") !== COMMERCIAL_CONTRACT.model) {
    fail("model does not match the frozen delivered-order model");
  }
  if (requireString(data, "currency", "payload") !== COMMERCIAL_CONTRACT.currency) {
    fail("currency does not match the frozen BDT contract");
  }
  if (requireString(data, "trigger", "payload") !== COMMERCIAL_CONTRACT.trigger) {
    fail("trigger does not match the frozen delivered-order trigger");
  }

  const unitPriceMinor = requireInteger(data, "unit_price_minor", "payload");
  if (unitPriceMinor !== COMMERCIAL_CONTRACT.unitPriceMinor) {
    fail("unit_price_minor does not match the frontend contract mirror");
  }
  const unitPriceBdt = requireFiniteNumber(data, "unit_price_bdt", "payload");
  if (unitPriceBdt !== unitPriceMinor / 100) {
    fail("unit_price_bdt is inconsistent with unit_price_minor");
  }

  const zeroRated = requireStringArray(data, "zero_rated_outcomes", "payload");
  for (const outcome of ["RETURNED", "CANCELLED"] as const) {
    if (!zeroRated.includes(outcome)) fail(`zero_rated_outcomes must include ${outcome}`);
  }

  if (requireFiniteNumber(data, "subscription_fee_bdt", "payload") !== 0) {
    fail("subscription_fee_bdt must be 0");
  }
  if (requireFiniteNumber(data, "setup_fee_bdt", "payload") !== 0) fail("setup_fee_bdt must be 0");
  if (requireFiniteNumber(data, "monthly_minimum_bdt", "payload") !== 0) {
    fail("monthly_minimum_bdt must be 0");
  }
  if (data.conversation_entitlement !== null) fail("conversation_entitlement must be null");
  if (requireInteger(data, "due_days", "payload") !== COMMERCIAL_CONTRACT.dueDays) {
    fail("due_days does not match the frozen contract");
  }

  const onOverdue = requireRecord(data.on_overdue, "payload.on_overdue");
  const expectedOverdue = COMMERCIAL_CONTRACT.onOverdue;
  if (requireBoolean(onOverdue, "blockCourierBooking", "payload.on_overdue") !== expectedOverdue.blockCourierBooking
    || requireBoolean(onOverdue, "pauseAutomatedAi", "payload.on_overdue") !== expectedOverdue.pauseAutomatedAi
    || requireBoolean(onOverdue, "keepInboxReadable", "payload.on_overdue") !== expectedOverdue.keepInboxReadable
    || requireBoolean(onOverdue, "keepHistoryReadable", "payload.on_overdue") !== expectedOverdue.keepHistoryReadable
    || requireBoolean(onOverdue, "deleteData", "payload.on_overdue") !== expectedOverdue.deleteData) {
    fail("on_overdue does not match the founder-approved policy");
  }

  const description = requireRecord(data.description, "payload.description");
  requireString(description, "en", "payload.description");
  requireString(description, "bn", "payload.description");

  return {
    ...(data as unknown as PublicCommercialContractPayload),
    registry_hash: registryHash,
    claims: parsePublicClaimDescriptors(data.claims),
    decisions: parsePublicClaimDecisions(
      data.decisions,
      COMMERCIAL_CONTRACT_VERSION,
      registryHash,
    ),
  };
}

function parseClaimPredicate(value: unknown, label: string): ClaimDecision["predicate"] {
  const record = requireRecord(value, label);
  return {
    code_present: requireBoolean(record, "code_present", label),
    merchant_enabled: requireBoolean(record, "merchant_enabled", label),
    production_verified: requireBoolean(record, "production_verified", label),
    deprecated: requireBoolean(record, "deprecated", label),
    internal_only: requireBoolean(record, "internal_only", label),
    scope_match: requireBoolean(record, "scope_match", label),
  };
}

function parseClaimScope(value: unknown, label: string): ClaimDecision["scope"] {
  const record = requireRecord(value, label);
  const optionalStringArray = (key: string): string[] | null => {
    const raw = record[key];
    if (raw === null || raw === undefined) return null;
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
      fail(`${label}.${key} must be an array of strings or null`);
    }
    return raw as string[];
  };
  return {
    claimedProviders: optionalStringArray("claimedProviders"),
    verifiedProviders: optionalStringArray("verifiedProviders"),
    match: requireBoolean(record, "match", label),
    text: record.text === null || record.text === undefined
      ? null
      : requireString(record, "text", label),
  };
}

function parseClaimDecision(value: unknown, index: number): ClaimDecision {
  const label = `decisions[${index}]`;
  const record = requireRecord(value, label);
  const render = record.render;
  if (typeof render !== "string" || !(CLAIM_RENDERS as readonly string[]).includes(render)) {
    fail(`${label}.render must be claim, fallback or none`);
  }
  const mode = record.mode;
  if (typeof mode !== "string" || !(CLAIM_MODES as readonly string[]).includes(mode)) {
    fail(`${label}.mode must be off, shadow or enforce`);
  }
  const textKey = record.textKey;
  if (textKey !== null && (typeof textKey !== "string" || textKey.trim().length === 0)) {
    fail(`${label}.textKey must be a non-empty string or null`);
  }
  const interpolation = requireRecord(record.interpolation ?? {}, `${label}.interpolation`);
  for (const [key, val] of Object.entries(interpolation)) {
    if (typeof val !== "string") fail(`${label}.interpolation.${key} must be a string`);
  }

  return {
    claimId: requireString(record, "claimId", label),
    available: requireBoolean(record, "available", label),
    render: render as ClaimDecision["render"],
    textKey: textKey as string | null,
    locale: requireClaimLocale(record.locale, `${label}.locale`),
    surface: requireClaimSurface(record.surface, `${label}.surface`),
    scope: parseClaimScope(record.scope, `${label}.scope`),
    interpolation: interpolation as Record<string, string>,
    mode: mode as ClaimDecision["mode"],
    predicate: parseClaimPredicate(record.predicate, `${label}.predicate`),
    wouldBlock: requireBoolean(record, "wouldBlock", label),
    contractVersion: requireString(record, "contractVersion", label),
    registryHash: requireString(record, "registryHash", label),
  };
}

/** Validate a claims response. A malformed decision set throws; nothing renders. */
export function parseClaimDecisionPayload(payload: unknown): ClaimDecisionPayload {
  const data = requireRecord(payload, "payload");
  const surface = requireClaimSurface(data.surface, "payload.surface");
  const locale = requireClaimLocale(data.locale, "payload.locale");
  const contractVersion = requireString(data, "contractVersion", "payload");
  if (contractVersion !== COMMERCIAL_CONTRACT_VERSION) {
    fail("decisions were evaluated against a different contract version");
  }
  const registryHash = requireString(data, "registryHash", "payload");
  if (!SHA256_RE.test(registryHash)) fail("registryHash is not a sha256 digest");
  if (!Array.isArray(data.decisions)) fail("decisions must be an array");

  const decisions = data.decisions.map((decision, index) => {
    const parsed = parseClaimDecision(decision, index);
    if (parsed.contractVersion !== contractVersion) {
      fail(`decisions[${index}].contractVersion does not match the payload`);
    }
    if (parsed.registryHash !== registryHash) {
      fail(`decisions[${index}].registryHash does not match the payload`);
    }
    if (parsed.surface !== surface) {
      fail(`decisions[${index}].surface does not match the requested surface`);
    }
    return parsed;
  });

  return { surface, locale, contractVersion, registryHash, decisions };
}

/** Public contract + claim allowlist. Unauthenticated (marketing origin). */
export async function getPublicCommercialContract(): Promise<PublicCommercialContractPayload> {
  const response = await publicApiGet<ApiResponse<unknown>>("/api/public/commercial-contract");
  if (!response.success) fail("public contract endpoint did not succeed");
  return parsePublicCommercialContract(response.data);
}

/** Server-evaluated claim decisions for one surface of the authenticated shop. */
export async function getClaimDecisions(
  surface: ClaimSurface,
  locale: ClaimLocale = "bn",
): Promise<ClaimDecisionPayload> {
  const response: AxiosResponse<ApiResponse<unknown>> = await httpClient.get(
    "/api/commercial/claims",
    { params: { surface, locale } },
  );
  return parseClaimDecisionPayload(response.data.data);
}

/**
 * Anonymous claim decisions. The public contract endpoint evaluates claims
 * with no shop context: contract/platform claims are truthful, merchant-
 * dependent claims fail closed to their fallback. Returns the same payload
 * shape as the authenticated endpoint so ClaimProvider is source-agnostic.
 */
export async function getPublicClaimDecisions(
  surface: ClaimSurface,
  locale: ClaimLocale = "bn",
): Promise<ClaimDecisionPayload> {
  const params = new URLSearchParams({ surface, locale }).toString();
  const response = await publicApiGet<ApiResponse<unknown>>(
    `/api/public/commercial-contract?${params}`,
  );
  if (!response.success) fail("public contract endpoint did not succeed");
  const payload = parsePublicCommercialContract(response.data);
  const decisions = payload.decisions.filter((decision) => decision.surface === surface);
  return {
    surface,
    locale,
    contractVersion: payload.contract_version,
    registryHash: payload.registry_hash,
    decisions,
  };
}

export const commercialContractQueryKey = ["commercial-contract"] as const;

export function claimDecisionsQueryKey(surface: ClaimSurface, locale: ClaimLocale) {
  return ["claim-decisions", surface, locale] as const;
}

export function publicClaimDecisionsQueryKey(surface: ClaimSurface, locale: ClaimLocale) {
  return ["public-claim-decisions", surface, locale] as const;
}

/** Frozen public contract, validated against the frontend mirror. */
export function useCommercialContract() {
  return useQuery({
    queryKey: commercialContractQueryKey,
    queryFn: getPublicCommercialContract,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
}

/**
 * One server-evaluated decision set per surface (ClaimProvider uses this).
 *
 * The source follows the session: an authenticated merchant reads
 * /api/commercial/claims (shop-scoped evidence); an anonymous visitor reads the
 * public contract endpoint's evaluated decisions, so marketing pages render
 * truthful capability claims instead of nothing. Defaults to authenticated to
 * preserve existing callers.
 */
export function useClaimDecisions(
  surface: ClaimSurface,
  locale: ClaimLocale = "bn",
  options: { authenticated?: boolean } = {},
) {
  const authenticated = options.authenticated !== false;
  return useQuery({
    queryKey: authenticated
      ? claimDecisionsQueryKey(surface, locale)
      : publicClaimDecisionsQueryKey(surface, locale),
    queryFn: () => (authenticated
      ? getClaimDecisions(surface, locale)
      : getPublicClaimDecisions(surface, locale)),
    staleTime: 60 * 1000,
    retry: 1,
  });
}