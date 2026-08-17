import type {
  SearchPayload,
  SearchProgressEvent,
  SearchProviderId,
  SearchResponse,
} from "../types";
import type { SupportedCountryCode } from "../search-planner/types";
import type {
  RelevanceClassifier,
} from "../search-planner/relevance";
import type { SemanticIntentV2 } from "../search-planner/types";

export type CompiledGeoapifyPlan = {
  provider: "geoapify";
  providerCatalogVersion: string;
  categoryIds: string[];
  registryChecksum: string;
  batches: Array<{
    id: string;
    type: "precision" | "recall" | "adjacent" | "fallback" | "legacy";
    mode: "precision" | "broad";
    role: "primary" | "adjacent" | "fallback";
    priority: number;
    resultBudget: number;
    categoryIds: string[];
    nameQuery: string | null;
    provenance: Array<{
      semanticField: "precision" | "recall" | "adjacent" | "fallback" | "legacy";
      semanticTerm: string;
      origin:
        | "normalizedGoal"
        | "coreBusinessTypes"
        | "productsAndServices"
        | "industries"
        | "adjacentBusinessTypes"
        | "retrievalTerms.precision"
        | "retrievalTerms.recall"
        | "legacy";
      match:
        | "exact_leaf"
        | "exact_path"
        | "parent"
        | "name_fallback"
        | "legacy_binding";
      categoryId: string;
    }>;
  }>;
  limits: {
    maxArms: number;
    maxUpstreamRequests: number;
    maxCards: number;
    maxDetails: number;
  };
  exclusionTerms: string[];
  countryCode: SupportedCountryCode;
  language: "ru" | "be" | "kk";
  conceptIds: string[];
};

export type SearchProgressCallback = (
  event: SearchProgressEvent,
) => void | Promise<void>;

export type SearchProviderOptions = {
  onProgress?: SearchProgressCallback;
  signal?: AbortSignal;
  /** Server-compiled selectors. They must never be accepted directly from a client. */
  compiledPlan?: CompiledGeoapifyPlan;
  /** Accepted intent used only by the local relevance layer, never as a URL. */
  semanticIntent?: SemanticIntentV2;
  /** Optional post-search adapter. Production keeps it absent and disabled. */
  relevanceClassifier?: RelevanceClassifier;
};

/**
 * Deliberately small provider boundary. Future failover/aggregation can depend
 * on this contract without leaking an upstream response into API routes.
 */
export interface SearchProvider {
  readonly id: SearchProviderId;
  search(
    payload: SearchPayload,
    options?: SearchProviderOptions,
  ): Promise<SearchResponse>;
}

export class SearchProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}
