import type {
  SearchPayload,
  SearchProviderId,
  SearchResponse,
} from "../types";

/**
 * Deliberately small provider boundary. Future failover/aggregation can depend
 * on this contract without leaking an upstream response into API routes.
 */
export interface SearchProvider {
  readonly id: SearchProviderId;
  search(payload: SearchPayload): Promise<SearchResponse>;
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
