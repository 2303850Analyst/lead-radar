import {
  RESOLUTION_REASON_CODES,
  SEMANTIC_INTENT_SCHEMA_VERSION,
  type SearchPlan,
  type SemanticIntentV2,
} from "./types";

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
const RETRIEVAL_ARM_TYPES = new Set([
  "precision",
  "recall",
  "adjacent",
  "fallback",
  "legacy",
]);
const RETRIEVAL_ARM_ROLES = new Set(["primary", "adjacent", "fallback"]);
const RETRIEVAL_MATCHES = new Set([
  "exact_leaf",
  "exact_path",
  "parent",
  "name_fallback",
  "legacy_binding",
]);
const SUPPORTED_LOCALES = new Set(["ru-RU", "ru-BY", "be-BY", "ru-KZ", "kk-KZ"]);
const SUPPORTED_COUNTRIES = new Set(["RU", "BY", "KZ"]);
const RESOLUTION_REASONS: ReadonlySet<string> = new Set(
  RESOLUTION_REASON_CODES,
);
const SEMANTIC_INTENT_KEYS = new Set([
  "schemaVersion",
  "normalizedGoal",
  "entityKind",
  "physicalLocationRequirement",
  "industries",
  "coreBusinessTypes",
  "adjacentBusinessTypes",
  "excludedBusinessTypes",
  "productsAndServices",
  "includeSignals",
  "excludeSignals",
  "retrievalTerms",
  "brandSearch",
  "confidence",
  "ambiguity",
]);
const RETRIEVAL_TERM_KEYS = new Set(["precision", "recall", "exclude"]);
const AMBIGUITY_KEYS = new Set([
  "isAmbiguous",
  "reason",
  "clarificationQuestion",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
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

function isSemanticIntent(value: unknown): value is SemanticIntentV2 {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SEMANTIC_INTENT_SCHEMA_VERSION ||
    !hasExactKeys(value, SEMANTIC_INTENT_KEYS)
  ) return false;
  const retrieval = value.retrievalTerms;
  const ambiguity = value.ambiguity;
  if (
    typeof value.normalizedGoal !== "string" ||
    typeof value.entityKind !== "string" ||
    !ENTITY_KINDS.has(value.entityKind) ||
    typeof value.physicalLocationRequirement !== "string" ||
    !PHYSICAL_REQUIREMENTS.has(value.physicalLocationRequirement) ||
    typeof value.brandSearch !== "string" ||
    !BRAND_SEARCH_VALUES.has(value.brandSearch) ||
    typeof value.confidence !== "string" ||
    !SEMANTIC_CONFIDENCE_VALUES.has(value.confidence)
  ) return false;
  if (
    !isStringArray(value.industries) ||
    !isStringArray(value.coreBusinessTypes) ||
    !isStringArray(value.adjacentBusinessTypes) ||
    !isStringArray(value.excludedBusinessTypes) ||
    !isStringArray(value.productsAndServices) ||
    !isStringArray(value.includeSignals) ||
    !isStringArray(value.excludeSignals) ||
    !isRecord(retrieval) ||
    !hasExactKeys(retrieval, RETRIEVAL_TERM_KEYS) ||
    !isStringArray(retrieval.precision) ||
    !isStringArray(retrieval.recall) ||
    !isStringArray(retrieval.exclude) ||
    !isRecord(ambiguity) ||
    !hasExactKeys(ambiguity, AMBIGUITY_KEYS) ||
    typeof ambiguity.isAmbiguous !== "boolean" ||
    !isNullableString(ambiguity.reason) ||
    !isNullableString(ambiguity.clarificationQuestion)
  ) return false;
  const ambiguityIsCoherent = ambiguity.isAmbiguous
    ? Boolean(ambiguity.reason && ambiguity.clarificationQuestion)
    : ambiguity.reason === null && ambiguity.clarificationQuestion === null;
  const nonPhysicalLocationIsCoherent =
    value.entityKind !== "non_physical" ||
    value.physicalLocationRequirement === "not_applicable";
  const unclearIntentIsCoherent =
    value.entityKind !== "unclear" || ambiguity.isAmbiguous;
  const permitsEmptyPositiveTerms =
    ambiguity.isAmbiguous ||
    value.entityKind === "unclear" ||
    (value.entityKind === "non_physical" &&
      value.physicalLocationRequirement === "not_applicable");
  const executableTermsArePresent =
    permitsEmptyPositiveTerms ||
    (value.coreBusinessTypes.length > 0 && retrieval.precision.length > 0);
  const providerNeutralTermIsPresent =
    permitsEmptyPositiveTerms ||
    [...retrieval.precision, ...retrieval.recall].some((term) =>
      /[a-z]/i.test(term),
    );
  return (
    ambiguityIsCoherent &&
    nonPhysicalLocationIsCoherent &&
    unclearIntentIsCoherent &&
    executableTermsArePresent &&
    providerNeutralTermIsPresent
  );
}

function isResolution(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const alternatives = Array.isArray(value.alternatives)
    ? value.alternatives
    : null;
  if (!alternatives || alternatives.length > 3) return false;
  const alternativeIds = new Set<string>();
  const alternativeHashes = new Set<string>();
  const validAlternatives = alternatives.every((alternative) => {
    if (!isRecord(alternative)) return false;
    const semanticIntent = alternative.semanticIntent;
    const executionPreview = alternative.executionPreview;
    if (
      typeof alternative.alternativeId !== "string" ||
      !/^alt-[a-f0-9]{16}$/.test(alternative.alternativeId) ||
      alternativeIds.has(alternative.alternativeId) ||
      typeof alternative.alternativeHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(alternative.alternativeHash) ||
      alternativeHashes.has(alternative.alternativeHash) ||
      typeof alternative.label !== "string" ||
      alternative.label.length < 1 ||
      alternative.label.length > 160 ||
      typeof alternative.explanation !== "string" ||
      alternative.explanation.length < 1 ||
      alternative.explanation.length > 500 ||
      !isSemanticIntent(semanticIntent) ||
      semanticIntent.ambiguity.isAmbiguous ||
      !isExecutionPreview(executionPreview) ||
      executionPreview === null ||
      !isReasonArray(alternative.reasonCodes)
    ) {
      return false;
    }
    alternativeIds.add(alternative.alternativeId);
    alternativeHashes.add(alternative.alternativeHash);
    return true;
  });
  return (
    typeof value.method === "string" &&
    RESOLUTION_METHODS.has(value.method) &&
    isStringArray(value.selectedConceptIds) &&
    validAlternatives &&
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
  if (
    !isRecord(value) ||
    value.provider !== "geoapify" ||
    !isStringArray(value.categoryLabels) ||
    value.categoryLabels.length < 1 ||
    value.categoryLabels.length > 32 ||
    new Set(value.categoryLabels).size !== value.categoryLabels.length ||
    typeof value.batches !== "number" ||
    !Number.isInteger(value.batches) ||
    value.batches < 1 ||
    value.batches > 4 ||
    !Array.isArray(value.retrievalArms) ||
    value.retrievalArms.length !== value.batches
  ) {
    return false;
  }
  const ids = new Set<string>();
  const priorities = new Set<number>();
  let totalBudget = 0;
  for (const arm of value.retrievalArms) {
    if (!isRecord(arm)) return false;
    if (!isStringArray(arm.categoryLabels) || !Array.isArray(arm.provenance)) {
      return false;
    }
    const armCategoryLabels = arm.categoryLabels;
    const provenance = arm.provenance;
    if (
      typeof arm.id !== "string" ||
      !/^arm-[a-z]+-[a-f0-9]{8}$/.test(arm.id) ||
      ids.has(arm.id) ||
      typeof arm.type !== "string" ||
      !RETRIEVAL_ARM_TYPES.has(arm.type) ||
      typeof arm.role !== "string" ||
      !RETRIEVAL_ARM_ROLES.has(arm.role) ||
      (arm.type === "adjacent"
        ? arm.role !== "adjacent"
        : arm.type === "fallback"
          ? arm.role !== "fallback"
          : arm.role !== "primary") ||
      typeof arm.priority !== "number" ||
      !Number.isInteger(arm.priority) ||
      arm.priority < 1 ||
      arm.priority > 4 ||
      priorities.has(arm.priority) ||
      typeof arm.resultBudget !== "number" ||
      !Number.isInteger(arm.resultBudget) ||
      arm.resultBudget < 1 ||
      arm.resultBudget > 200 ||
      armCategoryLabels.length < 1 ||
      armCategoryLabels.length > 8 ||
      new Set(armCategoryLabels).size !== armCategoryLabels.length ||
      typeof arm.usesNameFallback !== "boolean" ||
      arm.usesNameFallback !== (arm.type === "fallback") ||
      provenance.length < 1 ||
      provenance.length > 8 ||
      provenance.some(
        (item) =>
          !isRecord(item) ||
          typeof item.semanticField !== "string" ||
          typeof item.semanticTerm !== "string" ||
          item.semanticTerm.length < 1 ||
          item.semanticTerm.length > 120 ||
          typeof item.origin !== "string" ||
          item.origin.length < 1 ||
          item.origin.length > 60 ||
          typeof item.match !== "string" ||
          !RETRIEVAL_MATCHES.has(item.match) ||
          typeof item.categoryId !== "string" ||
          !armCategoryLabels.includes(item.categoryId) ||
          item.semanticField !== arm.type ||
          (arm.type === "fallback"
            ? item.match !== "name_fallback" ||
              ![
                "normalizedGoal",
                "coreBusinessTypes",
                "retrievalTerms.precision",
                "source.primaryQuery",
                "source.relatedQueries",
              ].includes(item.origin)
            : arm.type === "legacy"
              ? item.match !== "legacy_binding" || item.origin !== "legacy"
          : !["exact_leaf", "exact_path", "parent"].includes(item.match) ||
                (arm.type === "precision"
                  ? ![
                      "coreBusinessTypes",
                      "productsAndServices",
                      "retrievalTerms.precision",
                    ].includes(item.origin)
                  : arm.type === "recall"
                    ? !["industries", "retrievalTerms.recall"].includes(
                        item.origin,
                      )
                    : item.origin !== "adjacentBusinessTypes")),
      ) ||
      new Set(
        provenance
          .filter(isRecord)
          .map((item) => item.categoryId),
      ).size !== armCategoryLabels.length
    ) {
      return false;
    }
    ids.add(arm.id);
    priorities.add(arm.priority);
    totalBudget += arm.resultBudget;
  }
  return totalBudget <= 200;
}

/** Rejects partial or malformed network payloads before the UI dereferences them. */
export function isSearchPlan(value: unknown): value is SearchPlan {
  if (!isRecord(value) || value.schemaVersion !== "2.2") return false;
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
