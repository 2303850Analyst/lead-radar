export const SEARCH_PLAN_SCHEMA_VERSION = "1.0" as const;

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

export type KimiResolutionStatus = "selected" | "ambiguous" | "unsupported";
export type ConfidenceBand = "high" | "medium" | "low";

export type KimiResolution = {
  status: KimiResolutionStatus;
  selectedConceptIds: string[];
  alternatives: Array<{
    conceptId: string;
    reasonCodes: ResolutionReasonCode[];
  }>;
  confidenceBand: ConfidenceBand;
  clarificationReasonCode: ResolutionReasonCode | null;
};

export type SearchPlanAlternative = {
  conceptId: string;
  label: string;
  reasonCodes: ResolutionReasonCode[];
};

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
  resolution: {
    method: "exact" | "semantic" | "kimi" | "user_confirmed" | "fallback";
    selectedConceptIds: string[];
    alternatives: SearchPlanAlternative[];
    confidenceBand: ConfidenceBand | "unknown";
    reasonCodes: ResolutionReasonCode[];
    clarificationQuestion: string | null;
  };
  executionPreview: {
    provider: "geoapify";
    categoryLabels: string[];
    batches: number;
  } | null;
  ai: SearchPlanAiMetadata;
  confirmation: {
    token: string | null;
    expiresAt: string | null;
  };
};

export type KimiCandidate = {
  conceptId: string;
  label: string;
  aliases: string[];
  negativeAliases: string[];
  physicalPlace: PhysicalPlaceRequirement;
};

export type KimiResolveRequest = {
  intent: NormalizedSearchIntent;
  candidates: readonly KimiCandidate[];
  candidateMode: "shortlist" | "full_catalog";
  signal?: AbortSignal;
};

export type KimiUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type KimiResolveResult = {
  resolution: KimiResolution;
  modelId: string;
  finishReason: "stop";
  latencyMs: number;
  usage: KimiUsage;
};

export type ConfirmationTokenClaims = {
  v: 1;
  requestCacheKey: string;
  sourcePlanHash: string;
  allowedConceptIds: string[];
  taxonomyVersion: string;
  providerCatalogVersion: string;
  decisionPolicyVersion: string;
  iat: number;
  exp: number;
};
