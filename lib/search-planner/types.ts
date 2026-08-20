export const SEARCH_PLAN_SCHEMA_VERSION = "2.2" as const;
export const SEMANTIC_INTENT_SCHEMA_VERSION = "2.1" as const;

export const SUPPORTED_COUNTRY_CODES = ["RU", "BY", "KZ"] as const;
export type SupportedCountryCode = (typeof SUPPORTED_COUNTRY_CODES)[number];

export const SUPPORTED_LOCALES = [
  "ru-RU",
  "ru-BY",
  "be-BY",
  "ru-KZ",
  "kk-KZ",
] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export type PlannerMode = "deterministic" | "kimi";
export type PlanStatus =
  | "ready"
  | "needs_confirmation"
  | "unsupported"
  | "degraded";

export type CanonicalConceptStatus =
  | "supported"
  | "experimental"
  | "unsupported";

export type PhysicalPlaceRequirement =
  | "required"
  | "optional"
  | "not_applicable";

export type CanonicalConcept = {
  id: string;
  version: number;
  parentId: string | null;
  labels: Record<SupportedLocale, string>;
  aliases: Record<SupportedLocale, readonly string[]>;
  negativeAliases: Record<SupportedLocale, readonly string[]>;
  physicalPlace: PhysicalPlaceRequirement;
  status: CanonicalConceptStatus;
};

/** Category-related subset of the current public SearchPayload. */
export type PlannerInput = {
  description?: string;
  primaryQuery: string;
  relatedQueries?: readonly string[];
  excludeQueries?: readonly string[];
  locale?: SupportedLocale;
  countryCodes?: readonly SupportedCountryCode[];
};

export type NormalizedSearchIntent = {
  description: string;
  primaryQuery: string;
  relatedQueries: string[];
  excludeQueries: string[];
  locale: SupportedLocale;
  countryCodes: [SupportedCountryCode];
};

export type ResolutionReasonCode =
  | "EXACT_ALIAS"
  | "FUZZY_MATCH"
  | "SEMANTIC_MATCH"
  | "AMBIGUOUS_SCOPE"
  | "NEGATIVE_CONFLICT"
  | "NO_SUPPORTED_CONCEPT"
  | "PROVIDER_COVERAGE_GAP"
  | "PHYSICAL_PLACE_UNCLEAR"
  | "LOCALE_UNCERTAIN"
  | "KIMI_UNAVAILABLE"
  | "KIMI_INVALID_RESPONSE"
  | "KIMI_ADMISSION_TIMEOUT"
  | "USER_CONFIRMED";

export type ConceptCandidate = {
  conceptId: string;
  label: string;
  score: number;
  reasonCodes: ResolutionReasonCode[];
  negativeConflict: boolean;
};

export type DeterministicResolution = {
  decision: "ready" | "semantic_required";
  method: "exact" | "fuzzy" | "full_catalog";
  selectedConceptId: string | null;
  candidates: ConceptCandidate[];
  /** True when lexical retrieval was too weak and Kimi must see the full catalog. */
  fullCatalog: boolean;
};

export type ConfidenceBand = "high" | "medium" | "low";

export type SemanticEntityKind =
  | "physical_business"
  | "service_location"
  | "mixed"
  | "non_physical"
  | "unclear";

export type SemanticIntentV2 = {
  schemaVersion: typeof SEMANTIC_INTENT_SCHEMA_VERSION;
  normalizedGoal: string;
  entityKind: SemanticEntityKind;
  physicalLocationRequirement: PhysicalPlaceRequirement;
  industries: string[];
  coreBusinessTypes: string[];
  adjacentBusinessTypes: string[];
  excludedBusinessTypes: string[];
  productsAndServices: string[];
  includeSignals: string[];
  excludeSignals: string[];
  retrievalTerms: {
    precision: string[];
    recall: string[];
    exclude: string[];
  };
  brandSearch: "include" | "exclude" | "only";
  confidence: ConfidenceBand;
  ambiguity: {
    isAmbiguous: boolean;
    reason: string | null;
    clarificationQuestion: string | null;
  };
};

export type SearchPlanExecutionPreview = {
  provider: "geoapify";
  categoryLabels: string[];
  batches: number;
  retrievalArms: Array<{
    id: string;
    type: "precision" | "recall" | "adjacent" | "fallback" | "legacy";
    role: "primary" | "adjacent" | "fallback";
    priority: number;
    resultBudget: number;
    categoryLabels: string[];
    usesNameFallback: boolean;
    provenance: Array<{
      semanticField: "precision" | "recall" | "adjacent" | "fallback" | "legacy";
      semanticTerm: string;
      origin: string;
      match:
        | "exact_leaf"
        | "exact_path"
        | "parent"
        | "name_fallback"
        | "legacy_binding";
      categoryId: string;
    }>;
  }>;
};

export type SearchPlanAlternative = {
  alternativeId: string;
  alternativeHash: string;
  label: string;
  explanation: string;
  semanticIntent: SemanticIntentV2;
  executionPreview: SearchPlanExecutionPreview;
  reasonCodes: ResolutionReasonCode[];
};

export type ConfirmedSemanticAlternative = Pick<
  SearchPlanAlternative,
  "alternativeId" | "alternativeHash" | "semanticIntent"
>;

export type SearchPlanAiMetadata = {
  used: boolean;
  modelId: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: string | null;
  validation: "passed" | "failed" | "not_used";
  cacheHit: boolean;
};

export type SearchPlan = {
  schemaVersion: typeof SEARCH_PLAN_SCHEMA_VERSION;
  taxonomyVersion: string;
  providerCatalogVersion: string;
  decisionPolicyVersion: string;
  promptVersion: string;
  requestCacheKey: string;
  planHash: string;
  parentPlanHash: string | null;
  status: PlanStatus;
  intent: NormalizedSearchIntent;
  semanticIntent: SemanticIntentV2;
  confidence: {
    intent: ConfidenceBand | "unknown";
    providerCoverage: ConfidenceBand | "unknown";
  };
  resolution: {
    method: "exact" | "semantic" | "kimi" | "user_confirmed" | "fallback";
    selectedConceptIds: string[];
    alternatives: SearchPlanAlternative[];
    confidenceBand: ConfidenceBand | "unknown";
    reasonCodes: ResolutionReasonCode[];
    clarificationQuestion: string | null;
  };
  executionPreview: SearchPlanExecutionPreview | null;
  ai: SearchPlanAiMetadata;
  confirmation: {
    token: string | null;
    expiresAt: string | null;
  };
};

export type KimiUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type KimiEncodeRequest = {
  intent: NormalizedSearchIntent;
  signal?: AbortSignal;
};

export type KimiEncodeResult = {
  semanticIntent: SemanticIntentV2;
  modelId: string;
  finishReason: "stop";
  firstSseEventLatencyMs: number;
  latencyMs: number;
  usage: KimiUsage;
};

export type ConfirmationTokenClaims = {
  v: 2;
  requestCacheKey: string;
  sourcePlanHash: string;
  allowedAlternativeHashes: string[];
  searchPlanSchemaVersion: typeof SEARCH_PLAN_SCHEMA_VERSION;
  semanticIntentSchemaVersion: typeof SEMANTIC_INTENT_SCHEMA_VERSION;
  providerCatalogVersion: string;
  decisionPolicyVersion: string;
  promptVersion: string;
  iat: number;
  exp: number;
};
