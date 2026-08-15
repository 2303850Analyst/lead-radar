export type LeadStatus =
  | "Новый"
  | "Проверить"
  | "В работе"
  | "Связались"
  | "Не подходит";

export type WebsiteSourceStatus = "listed" | "not_listed";
export type WebsiteVerifiedStatus =
  | "found"
  | "not_found_after_checks"
  | "unavailable"
  | "not_checked";

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
    source: "demo" | "yandex";
    primaryFound: boolean;
  };
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
  mode: "demo" | "yandex";
  query: SearchPayload;
  summary: SearchSummary;
  leads: Lead[];
  notice: string;
  generatedAt: string;
};
