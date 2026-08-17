import type {
  ConfirmedSemanticAlternative,
  SearchPlan,
  SupportedCountryCode,
  SupportedLocale,
} from "./search-planner/types";
import type { RussianMetroSystemId } from "./metro";

export type LeadStatus =
  | "Новый"
  | "Проверить"
  | "В работе"
  | "Связались"
  | "Не подходит";

export type WebsiteSourceStatus = "listed" | "not_listed" | "not_checked";
export type WebsiteVerifiedStatus =
  | "found"
  | "not_found_after_checks"
  | "unavailable"
  | "not_checked";

export type SearchProviderId = "demo" | "yandex" | "geoapify";

export type ProviderPersistencePolicy =
  | "synthetic"
  | "allowed_with_attribution"
  | "contract_required";

export type SearchProviderMetadata = {
  id: SearchProviderId;
  label: string;
  queriedAt: string;
  policy: {
    persistence: ProviderPersistencePolicy;
    attributionRequired: boolean;
    attribution: string[];
    /** LeadRadar never persists complete upstream responses. */
    rawResponsesStored: false;
  };
  coverage?: {
    categories: string[];
    retrievalArms?: number;
    upstreamRequests?: number;
    cardsAccepted?: number;
    detailsRequested: number;
    detailsSucceeded: number;
    relevance?: {
      classifier: "disabled" | "completed" | "degraded";
      matched: number;
      maybe: number;
      rejected: number;
      notChecked: number;
    };
  };
};

export type LeadSourceObservation = {
  provider: SearchProviderId;
  externalId: string;
  observedAt: string;
};

export type LeadRetrievalArm = {
  id: string;
  type: "precision" | "recall" | "adjacent" | "fallback" | "legacy";
  role: "primary" | "adjacent" | "fallback";
  priority: number;
  categoryIds: string[];
  provenance: Array<{
    semanticField: "precision" | "recall" | "adjacent" | "fallback" | "legacy";
    semanticTerm: string;
    origin: string;
    match: "exact_leaf" | "exact_path" | "parent" | "name_fallback" | "legacy_binding";
    categoryId: string;
  }>;
};

export type SearchProgressStage =
  | "validation"
  | "intent_resolution"
  | "geocoding"
  | "provider_compilation"
  | "places"
  | "details"
  | "relevance_classification"
  | "normalizing"
  | "complete";

export type SearchProgressEvent = {
  type: "progress";
  stage: SearchProgressStage;
  status: "started" | "running" | "completed";
  message: string;
  timestamp: string;
  completed?: number;
  total?: number;
};

export type SearchLocationMode =
  | "city"
  | "district"
  | "radius"
  | "metro"
  | "region";

export type SearchMetroSelection = {
  systemId: RussianMetroSystemId;
  stationId?: string;
  stationName?: string;
};

export type SearchPayload = {
  description: string;
  primaryQuery: string;
  relatedQueries: string[];
  excludeQueries: string[];
  location: string;
  /** UI geography mode. Legacy clients may omit it and use radius mode. */
  locationMode?: SearchLocationMode;
  /** Selected metro system/station; the server revalidates it against the provider. */
  metro?: SearchMetroSelection;
  /** Optional map-selected center in GeoJSON order: [longitude, latitude]. */
  center?: [number, number];
  radiusKm: number;
  offer?: string;
  services: string[];
  locale?: SupportedLocale;
  countryCodes?: SupportedCountryCode[];
  /** V2 semantic confirmation. Server re-hashes and validates the full intent. */
  confirmedAlternative?: ConfirmedSemanticAlternative;
  /** Deprecated V1 field; accepted only to return a safe re-planning response. */
  confirmedConceptIds?: string[];
  confirmationToken?: string;
};

export type Lead = {
  id: string;
  name: string;
  category: string;
  tags: string[];
  location: {
    address: string;
    coordinates: [number, number];
  };
  phone: string | null;
  email?: string | null;
  website: {
    sourceStatus: WebsiteSourceStatus;
    verifiedStatus: WebsiteVerifiedStatus;
    url: string | null;
  };
  socials: {
    telegram?: string;
    vk?: string;
  };
  digitalProblems: string[];
  discovery: {
    matchedQueries: string[];
    hiddenReason: string;
    observedAt: string;
    source: SearchProviderId;
    primaryFound: boolean;
    /** Every bounded retrieval strategy that independently found this card. */
    retrievalArms?: LeadRetrievalArm[];
  };
  sources: LeadSourceObservation[];
  scores: {
    opportunity: number;
    hiddenness: number;
    confidence: number;
  };
  status: LeadStatus;
  summary: string;
  recommendedOffer: string;
  possibleBranches: string[];
  relevance?: LeadRelevance;
};

export type RelevanceStatus =
  | "matched"
  | "maybe"
  | "rejected"
  | "not_checked";

export type RelevanceEvidenceField =
  | "name"
  | "providerCategoryIds"
  | "locality"
  | "sourceDescription";

export type RelevanceEvidenceFact = {
  field: RelevanceEvidenceField;
  value: string;
};

export type LeadRelevance = {
  candidateId: string;
  status: RelevanceStatus;
  confidence: number | null;
  evidence: RelevanceEvidenceFact[];
  reasonCodes: string[];
  source: "deterministic" | "kimi" | "not_checked";
};

export type SearchSummary = {
  cardsFound: number;
  uniqueLocations: number;
  assumedBusinesses: number;
  foundByPrimary: number;
  foundOnlyExpanded: number;
  digitalGapCandidates: number;
  manualReviewCandidates: number;
  relevance?: {
    matched: number;
    maybe: number;
    rejected: number;
    notChecked: number;
  };
};

export type SearchResponse = {
  mode: SearchProviderId;
  provider: SearchProviderMetadata;
  query: SearchPayload;
  summary: SearchSummary;
  leads: Lead[];
  notice: string;
  generatedAt: string;
  plan?: SearchPlan;
};
