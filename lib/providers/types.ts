import type {
  SearchPayload,
  SearchProgressEvent,
  SearchProviderId,
  SearchResponse,
} from "../types";

export type SearchProgressCallback = (
  event: SearchProgressEvent,
) => void | Promise<void>;

export type SearchProviderOptions = {
  onProgress?: SearchProgressCallback;
  signal?: AbortSignal;
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
