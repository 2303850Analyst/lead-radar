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

export type SearchPayload = {
  description: string;
  primaryQuery: string;
  relatedQueries: string[];
  excludeQueries: string[];
  location: string;
  radiusKm: number;
  offer?: string;
  services: string[];
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
};
