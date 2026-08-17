import type { SearchPlan } from "./types";

const PLAN_STATUSES = new Set(["ready", "needs_confirmation", "unsupported", "degraded"]);
const SEMANTIC_CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);
const CONFIDENCE_VALUES = new Set(["high", "medium", "low", "unknown"]);
const RESOLUTION_METHODS = new Set([
  "exact",
  "semantic",
  "kimi",
  "user_confirmed",
  "fallback",
]);
const ENTITY_KINDS = new Set([
  "physical_business",
  "service_location",
  "mixed",
  "non_physical",
  "unclear",
]);
const PHYSICAL_REQUIREMENTS = new Set(["required", "optional", "not_applicable"]);
const BRAND_SEARCH_VALUES = new Set(["include", "exclude", "only"]);
const AI_VALIDATION_VALUES = new Set(["passed", "failed", "not_used"]);
const SUPPORTED_LOCALES = new Set(["ru-RU", "ru-BY", "be-BY", "ru-KZ", "kk-KZ"]);
const SUPPORTED_COUNTRIES = new Set(["RU", "BY", "KZ"]);
const RESOLUTION_REASONS = new Set([
  "EXACT_ALIAS",
  "FUZZY_MATCH",
  "SEMANTIC_MATCH",
  "AMBIGUOUS_SCOPE",
  "NEGATIVE_CONFLICT",
  "NO_SUPPORTED_CONCEPT",
  "PROVIDER_COVERAGE_GAP",
  "PHYSICAL_PLACE_UNCLEAR",
  "LOCALE_UNCERTAIN",
  "KIMI_UNAVAILABLE",
  "KIMI_INVALID_RESPONSE",
  "KIMI_ADMISSION_TIMEOUT",
  "USER_CONFIRMED",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isReasonArray(value: unknown): boolean {
  return isStringArray(value) && value.every((item) => RESOLUTION_REASONS.has(item));
}

function isNormalizedIntent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.description === "string" &&
    typeof value.primaryQuery === "string" &&
    isStringArray(value.relatedQueries) &&
    isStringArray(value.excludeQueries) &&
    typeof value.locale === "string" &&
    SUPPORTED_LOCALES.has(value.locale) &&
    Array.isArray(value.countryCodes) &&
    value.countryCodes.length === 1 &&
    typeof value.countryCodes[0] === "string" &&
    SUPPORTED_COUNTRIES.has(value.countryCodes[0])
  );
}

function isSemanticIntent(value: unknown): boolean {
  if (!isRecord(value) || value.schemaVersion !== "2.0") return false;
  const retrieval = value.retrievalTerms;
  const ambiguity = value.ambiguity;
  return (
    typeof value.normalizedGoal === "string" &&
    typeof value.entityKind === "string" &&
    ENTITY_KINDS.has(value.entityKind) &&
    typeof value.physicalLocationRequirement === "string" &&
    PHYSICAL_REQUIREMENTS.has(value.physicalLocationRequirement) &&
    typeof value.brandSearch === "string" &&
    BRAND_SEARCH_VALUES.has(value.brandSearch) &&
    typeof value.confidence === "string" &&
    SEMANTIC_CONFIDENCE_VALUES.has(value.confidence) &&
    [
      value.industries,
      value.coreBusinessTypes,
      value.adjacentBusinessTypes,
      value.excludedBusinessTypes,
      value.productsAndServices,
      value.includeSignals,
      value.excludeSignals,
    ].every(isStringArray) &&
    isRecord(retrieval) &&
    isStringArray(retrieval.precision) &&
    isStringArray(retrieval.recall) &&
    isStringArray(retrieval.exclude) &&
    isRecord(ambiguity) &&
    typeof ambiguity.isAmbiguous === "boolean" &&
    isNullableString(ambiguity.reason) &&
    isNullableString(ambiguity.clarificationQuestion)
  );
}

function isResolution(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.method === "string" &&
    RESOLUTION_METHODS.has(value.method) &&
    isStringArray(value.selectedConceptIds) &&
    Array.isArray(value.alternatives) &&
    value.alternatives.every(
      (alternative) =>
        isRecord(alternative) &&
        typeof alternative.conceptId === "string" &&
        typeof alternative.label === "string" &&
        isReasonArray(alternative.reasonCodes),
    ) &&
    typeof value.confidenceBand === "string" &&
    CONFIDENCE_VALUES.has(value.confidenceBand) &&
    isReasonArray(value.reasonCodes) &&
    isNullableString(value.clarificationQuestion)
  );
}

function isAiMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.used === "boolean" &&
    isNullableString(value.modelId) &&
    isFiniteNumberOrNull(value.latencyMs) &&
    isFiniteNumberOrNull(value.inputTokens) &&
    isFiniteNumberOrNull(value.outputTokens) &&
    isNullableString(value.finishReason) &&
    typeof value.validation === "string" &&
    AI_VALIDATION_VALUES.has(value.validation) &&
    typeof value.cacheHit === "boolean"
  );
}

function isExecutionPreview(value: unknown): boolean {
  if (value === null) return true;
  return (
    isRecord(value) &&
    value.provider === "geoapify" &&
    isStringArray(value.categoryLabels) &&
    typeof value.batches === "number" &&
    Number.isFinite(value.batches)
  );
}

/** Rejects partial or malformed network payloads before the UI dereferences them. */
export function isSearchPlan(value: unknown): value is SearchPlan {
  if (!isRecord(value) || value.schemaVersion !== "2.0") return false;
  if (typeof value.status !== "string" || !PLAN_STATUSES.has(value.status)) return false;
  const confidence = value.confidence;
  const confirmation = value.confirmation;
  return (
    typeof value.taxonomyVersion === "string" &&
    typeof value.providerCatalogVersion === "string" &&
    typeof value.decisionPolicyVersion === "string" &&
    typeof value.promptVersion === "string" &&
    typeof value.requestCacheKey === "string" &&
    typeof value.planHash === "string" &&
    isNullableString(value.parentPlanHash) &&
    isNormalizedIntent(value.intent) &&
    isSemanticIntent(value.semanticIntent) &&
    isResolution(value.resolution) &&
    isRecord(confidence) &&
    typeof confidence.intent === "string" &&
    CONFIDENCE_VALUES.has(confidence.intent) &&
    typeof confidence.providerCoverage === "string" &&
    CONFIDENCE_VALUES.has(confidence.providerCoverage) &&
    isExecutionPreview(value.executionPreview) &&
    isAiMetadata(value.ai) &&
    isRecord(confirmation) &&
    isNullableString(confirmation.token) &&
    isNullableString(confirmation.expiresAt)
  );
}
