import { resolveKimiModelPolicy } from "../../lib/search-planner/kimi-client.ts";
import {
  SEARCH_CANARY_ATTAINABLE_POLICY,
  SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS,
} from "./search-live-canary.mjs";

export const DEFAULT_SEARCH_CANARY_KIMI_PROFILE = "k3-low";

const SEARCH_CANARY_PROFILE_DEFINITIONS = Object.freeze({
  "k3-low": Object.freeze({
    model: "kimi-k3",
    reasoningEffort: "low",
    pricingUsdPerMillion: Object.freeze({
      cachedInput: 0.3,
      input: 3,
      output: 15,
    }),
  }),
  "k2.6-thinking-disabled": Object.freeze({
    model: "kimi-k2.6",
    reasoningEffort: undefined,
    pricingUsdPerMillion: Object.freeze({
      cachedInput: 0.16,
      input: 0.95,
      output: 4,
    }),
  }),
});

export function resolveSearchCanaryKimiProfile(value) {
  const profileId =
    typeof value === "string"
      ? value.trim() || DEFAULT_SEARCH_CANARY_KIMI_PROFILE
      : value === undefined
        ? DEFAULT_SEARCH_CANARY_KIMI_PROFILE
        : null;
  if (
    profileId === null ||
    !Object.hasOwn(SEARCH_CANARY_PROFILE_DEFINITIONS, profileId)
  ) {
    throw new Error(
      "SEARCH_CANARY_KIMI_PROFILE must select a server-owned Kimi profile: k3-low or k2.6-thinking-disabled",
    );
  }
  const definition = SEARCH_CANARY_PROFILE_DEFINITIONS[profileId];
  const policy = resolveKimiModelPolicy(
    definition.model,
    definition.reasoningEffort,
  );
  return Object.freeze({
    id: profileId,
    model: policy.modelId,
    modelMode: policy.mode,
    reasoningEffort: policy.reasoningEffort,
    cacheIdentity: policy.cacheIdentity,
    pricingUsdPerMillion: definition.pricingUsdPerMillion,
  });
}

export function applySearchCanaryKimiProfileToEnv(profile, env) {
  const resolved = resolveSearchCanaryKimiProfile(profile?.id);
  env.KIMI_PLANNER_MODEL = resolved.model;
  if (resolved.reasoningEffort === null) {
    delete env.KIMI_PLANNER_REASONING_EFFORT;
  } else {
    env.KIMI_PLANNER_REASONING_EFFORT = resolved.reasoningEffort;
  }
}

export function searchCanaryRuntimeProfile(profile) {
  const resolved = resolveSearchCanaryKimiProfile(profile?.id);
  return Object.freeze({
    profileId: resolved.id,
    baseHost: "api.moonshot.ai",
    model: resolved.model,
    modelMode: resolved.modelMode,
    reasoningEffort: resolved.reasoningEffort,
    cacheIdentity: resolved.cacheIdentity,
    kimiTimeoutMs: 45_000,
    kimiMinStartIntervalMs: 20_000,
    kimiAdmissionTimeoutMs: 20_000,
    kimiCircuitFailureThreshold: 3,
    searchRequestDeadlineMs: 60_000,
    placesLimit: 20,
    detailsLimit: 3,
    maxRetrievalArms:
      SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS.plannedRetrievalArms,
    maxUpstreamRequests:
      SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS.retrievalRequests,
    maxCardsAccepted: SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS.cardsAccepted,
    maxCategoryResolutionRequests:
      SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS.categoryResolutionRequests,
    maxProviderRequestsPerAttempt:
      SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS.totalProviderRequests,
    geoapifyRequestIntervalMs: 225,
    categoryHintTimeoutMs: 1_500,
    categoryHintsEnabled: true,
    maxAttemptsPerCase: 2,
    retryBackoffMs: 2_000,
    literalBaselineLimit: SEARCH_CANARY_ATTAINABLE_POLICY.literalBaselineLimit,
    literalBaselineTimeoutMs: 10_000,
    manualReviewTimeoutMs: SEARCH_CANARY_ATTAINABLE_POLICY.manualReviewTimeoutMs,
  });
}
