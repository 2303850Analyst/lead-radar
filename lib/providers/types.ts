import type {
  SearchPayload,
  SearchProgressEvent,
  SearchProviderId,
  SearchResponse,
} from "../types";
import type { SupportedCountryCode } from "../search-planner/types";

export type CompiledGeoapifyPlan = {
  provider: "geoapify";
  providerCatalogVersion: string;
  categoryIds: string[];
  registryChecksum: string;
  batches: Array<{
    id: "precision" | "broad" | "legacy";
    mode: "precision" | "broad";
    categoryIds: string[];
    provenance: Array<{
      semanticField: "precision" | "recall" | "legacy";
      semanticTerm: string;
      match: "exact_leaf" | "exact_path" | "parent" | "legacy_binding";
      categoryId: string;
    }>;
  }>;
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
