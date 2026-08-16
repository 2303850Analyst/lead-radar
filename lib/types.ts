import type {
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
    detailsRequested: number;
    detailsSucceeded: number;
  };
};

export type LeadSourceObservation = {
  provider: SearchProviderId;
  externalId: string;
  observedAt: string;
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
  relevance?: {
    status: "matched" | "not_matched" | "ambiguous" | "not_checked";
    confidence: number | null;
    evidence: string[];
    source: "deterministic" | "kimi" | "not_checked";
  };
};

export type SearchSummary = {
  cardsFound: number;
  uniqueLocations: number;
  assumedBusinesses: number;
  foundByPrimary: number;
  foundOnlyExpanded: number;
  digitalGapCandidates: number;
  manualReviewCandidates: number;
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
