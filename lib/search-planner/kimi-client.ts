import "server-only";

import {
  KIMI_SEMANTIC_INTENT_TRANSPORT_SCHEMA,
  KimiSchemaValidationError,
  parseKimiSemanticIntentWire,
} from "./schema";
import type {
  KimiEncodeRequest,
  KimiEncodeResult,
  KimiUsage,
} from "./types";

export const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai/v1";
export const DEFAULT_KIMI_MODEL = "kimi-k3";
export const DEFAULT_KIMI_TIMEOUT_MS = 30_000;
export const KIMI_MODEL_POLICY_VERSION =
  "kimi-model-policy/2026-08-20.6";
export const KIMI_TRANSPORT_SCHEMA_VERSION =
  "mfjs-semantic-intent/2026-08-20.5";

const ALLOWED_KIMI_HOSTS = new Set(["api.moonshot.ai", "api.moonshot.cn"]);
const MAX_KIMI_CONTENT_CHARS = 30_000;
const MAX_KIMI_STREAM_BYTES = 256_000;

export type KimiReasoningEffort = "low" | "high" | "max";
export type KimiModelMode = "k3-reasoning" | "k2.6-thinking-disabled";

export type KimiClientConfig = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: KimiReasoningEffort;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type KimiModelsCanaryResult = {
  ok: true;
  modelIds: string[];
  configuredModelId: string;
  configuredModelAvailable: boolean;
  latencyMs: number;
};

export const KIMI_INVALID_RESPONSE_REASONS = Object.freeze([
  "models_json_invalid",
  "models_shape_invalid",
  "response_model_mismatch",
  "semantic_schema_invalid",
  "sse_after_done",
  "sse_choice_index_invalid",
  "sse_chunk_json_invalid",
  "sse_content_delta_invalid",
  "sse_content_type_invalid",
  "sse_finish_reason_invalid",
  "sse_incomplete",
  "sse_missing_choices",
  "sse_missing_done",
  "sse_model_changed",
  "sse_no_progress",
  "sse_content_size_limit",
  "sse_size_limit",
  "sse_wire_size_limit",
  "structured_json_fence",
  "structured_json_invalid",
  "structured_json_invalid_token",
  "structured_json_shape_invalid",
  "structured_json_unexpected_end",
] as const);
export type KimiInvalidResponseReason =
  (typeof KIMI_INVALID_RESPONSE_REASONS)[number];
export const KIMI_SEMANTIC_VALIDATION_ISSUE_CODES = Object.freeze([
  "additional_property",
  "ambiguity_invariant",
  "array_duplicate",
  "array_max_adjacent_business_types",
  "array_max_core_business_types",
  "array_max_exclude_signals",
  "array_max_excluded_business_types",
  "array_max_include_signals",
  "array_max_industries",
  "array_max_products_and_services",
  "array_max_provider_neutral_category_heads",
  "array_max_retrieval_exclude",
  "array_max_retrieval_precision",
  "array_max_retrieval_recall",
  "array_max_size",
  "array_min_size",
  "array_size",
  "category_head_invalid",
  "english_retrieval_term_missing",
  "enum_or_const",
  "executable_heads_missing",
  "executable_terms_missing",
  "executable_value_forbidden",
  "non_physical_location_invariant",
  "nonready_heads_present",
  "nonready_terms_present",
  "payload_size",
  "required_field_missing",
  "serialization",
  "string_size",
  "type_mismatch",
  "unclear_intent_invariant",
  "validation_other",
] as const);
export type KimiSemanticValidationIssueCode =
  (typeof KIMI_SEMANTIC_VALIDATION_ISSUE_CODES)[number];

export type KimiClient = {
  readonly modelId: string;
  readonly baseUrl: string;
  /** Stable, non-secret identity used to isolate behaviorally distinct caches. */
  readonly cacheIdentity: string;
  encode(request: KimiEncodeRequest): Promise<KimiEncodeResult>;
  listModels(signal?: AbortSignal): Promise<KimiModelsCanaryResult>;
};

export class KimiClientError extends Error {
  readonly code:
    | "KIMI_CONFIGURATION_ERROR"
    | "KIMI_AUTH_ERROR"
    | "KIMI_RATE_LIMITED"
    | "KIMI_TIMEOUT"
    | "KIMI_ABORTED"
    | "KIMI_HTTP_ERROR"
    | "KIMI_INVALID_RESPONSE";
  readonly retryable: boolean;
  readonly status: number | null;
  readonly reason: KimiInvalidResponseReason | null;
  readonly semanticValidationIssueCodes:
    readonly KimiSemanticValidationIssueCode[];

  constructor(
    code: KimiClientError["code"],
    message: string,
    options: {
      retryable?: boolean;
      status?: number | null;
      reason?: KimiInvalidResponseReason;
      semanticValidationIssueCodes?: readonly KimiSemanticValidationIssueCode[];
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "KimiClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
    this.reason = options.reason ?? null;
    this.semanticValidationIssueCodes = Object.freeze([
      ...new Set(options.semanticValidationIssueCodes ?? []),
    ]);
  }
}

type KimiStreamChunk = {
  model?: unknown;
  choices?: Array<{
    index?: unknown;
    finish_reason?: unknown;
    delta?: { content?: unknown };
    usage?: {
      prompt_tokens?: unknown;
      cached_tokens?: unknown;
      completion_tokens?: unknown;
      total_tokens?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    cached_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  };
};

function normalizedBaseUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value?.trim() || DEFAULT_KIMI_BASE_URL);
  } catch {
    throw new KimiClientError(
      "KIMI_CONFIGURATION_ERROR",
      "Kimi base URL is invalid",
    );
  }
  if (url.protocol !== "https:" || !ALLOWED_KIMI_HOSTS.has(url.hostname)) {
    throw new KimiClientError(
      "KIMI_CONFIGURATION_ERROR",
      "Kimi base URL must use an official Moonshot HTTPS host",
    );
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (normalizedPath !== "/v1") {
    throw new KimiClientError(
      "KIMI_CONFIGURATION_ERROR",
      "Kimi base URL must end with /v1",
    );
  }
  url.pathname = normalizedPath;
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > 120_000) {
    throw new KimiClientError(
      "KIMI_CONFIGURATION_ERROR",
      `${field} must be an integer between 1 and 120000`,
    );
  }
  return result;
}

function cleanModel(value: string | undefined): string {
  const model = value?.trim() || DEFAULT_KIMI_MODEL;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(model)) {
    throw new KimiClientError(
      "KIMI_CONFIGURATION_ERROR",
      "Kimi model ID has an invalid format",
    );
  }
  return model;
}

export type ResolvedKimiModelPolicy = {
  modelId: "kimi-k3" | "kimi-k2.6";
  mode: KimiModelMode;
  reasoningEffort: KimiReasoningEffort | null;
  requestControl:
    | { reasoning_effort: KimiReasoningEffort }
    | { thinking: { type: "disabled" } };
  cacheIdentity: string;
};

function configurationError(message: string): KimiClientError {
  return new KimiClientError("KIMI_CONFIGURATION_ERROR", message);
}

export function resolveKimiModelPolicy(
  modelId: string,
  configuredEffort: KimiReasoningEffort | undefined,
): ResolvedKimiModelPolicy {
  if (modelId === "kimi-k3") {
    const reasoningEffort = configuredEffort ?? "low";
    if (
      reasoningEffort !== "low" &&
      reasoningEffort !== "high" &&
      reasoningEffort !== "max"
    ) {
      throw configurationError(
        "KIMI_PLANNER_REASONING_EFFORT must be low, high, or max for kimi-k3",
      );
    }
    return {
      modelId,
      mode: "k3-reasoning",
      reasoningEffort,
      requestControl: { reasoning_effort: reasoningEffort },
      cacheIdentity: [
        KIMI_MODEL_POLICY_VERSION,
        modelId,
        "k3-reasoning",
        reasoningEffort,
      ].join(":"),
    };
  }
  if (modelId === "kimi-k2.6") {
    if (configuredEffort !== undefined) {
      throw configurationError(
        "KIMI_PLANNER_REASONING_EFFORT is incompatible with kimi-k2.6",
      );
    }
    return {
      modelId,
      mode: "k2.6-thinking-disabled",
      reasoningEffort: null,
      requestControl: { thinking: { type: "disabled" } },
      cacheIdentity: [
        KIMI_MODEL_POLICY_VERSION,
        modelId,
        "k2.6-thinking-disabled",
        "none",
      ].join(":"),
    };
  }
  throw configurationError(
    "KIMI_PLANNER_MODEL is not approved by the server model policy",
  );
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function usageFromResponse(value: KimiStreamChunk["usage"]): KimiUsage {
  return {
    inputTokens: numberOrNull(value?.prompt_tokens),
    cachedInputTokens: numberOrNull(value?.cached_tokens),
    outputTokens: numberOrNull(value?.completion_tokens),
    totalTokens: numberOrNull(value?.total_tokens),
  };
}

function errorForStatus(status: number): KimiClientError {
  if (status === 401 || status === 403) {
    return new KimiClientError("KIMI_AUTH_ERROR", "Kimi rejected the API credentials", {
      status,
    });
  }
  if (status === 429) {
    return new KimiClientError("KIMI_RATE_LIMITED", "Kimi rate limit was reached", {
      status,
      retryable: true,
    });
  }
  return new KimiClientError("KIMI_HTTP_ERROR", `Kimi returned HTTP ${status}`, {
    status,
    retryable: status >= 500,
  });
}

async function timedFetch<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
  consume?: (response: Response) => Promise<T>,
): Promise<T> {
  if (externalSignal?.aborted) {
    throw new KimiClientError("KIMI_ABORTED", "Kimi request was aborted");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = () => controller.abort();
  externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!consume) return response as T;
    return await consume(response);
  } catch (error) {
    if (timedOut) {
      throw new KimiClientError("KIMI_TIMEOUT", "Kimi request timed out", {
        retryable: true,
        cause: error,
      });
    }
    if (externalSignal?.aborted) {
      throw new KimiClientError("KIMI_ABORTED", "Kimi request was aborted", {
        cause: error,
      });
    }
    if (error instanceof KimiClientError) throw error;
    throw new KimiClientError("KIMI_HTTP_ERROR", "Kimi request failed", {
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function plannerPrompt(
  request: KimiEncodeRequest,
  mode: KimiModelMode,
): {
  system: string;
  user: string;
} {
  const systemInstructions = [
    "You are the LeadRadar semantic encoder for business-place discovery in CIS countries.",
    "Interpret the user's ordinary language into open-vocabulary business semantics.",
    "Use concise natural-language business types, industries, services, synonyms, and retrieval terms.",
    "Return providerNeutralCategoryHeads as a separate open-vocabulary array; it is not a provider category list and you are not given any registry or provider category list.",
    "For every unambiguous physical intent, providerNeutralCategoryHeads must contain 1 to 4 of the shortest unambiguous English head phrases that preserve the distinguishing business type; use 1 to 5 natural words per head and keep modifiers whenever a shorter head would change the meaning.",
    "Do not use generic wrappers such as business, venue, centre, center, studio, club, shop, or service as a head unless that wrapper is itself the complete distinguishing business type.",
    "In retrievalTerms.precision, include concise source-language and English retrieval phrases alongside the separate heads; put richer paraphrases in precision or recall, not in providerNeutralCategoryHeads.",
    "Write category phrases as natural words such as 'music school', not dotted or underscored classification labels.",
    "Preserve include and exclude intent. Separate the core business from adjacent businesses.",
    "Recall and adjacent lists may be empty; do not add generic sibling services merely to fill them.",
    "The primaryQuery is already a place-search phrase. First decide whether its subject is a physical business or service location; only then evaluate business-type ambiguity.",
    "A bare business or place-form noun is an implicit request to find such places; never classify it as non_physical merely because it has no verb. If it names only a generic place form with several materially different business purposes, mark it ambiguous instead of inventing a modifier or selecting one purpose.",
    "Each provider-neutral head must be the minimal lexical business-type head, not a venue description. Remove setting adjectives and container nouns when the remaining words still preserve the distinguishing type; keep them when removal would change the business type.",
    "For non-physical intent, keep providerNeutralCategoryHeads and all positive business and retrieval arrays empty and use non_physical with not_applicable location requirement.",
    "For materially ambiguous intent, do not enumerate interpretations in positive arrays: keep providerNeutralCategoryHeads, industries, coreBusinessTypes, adjacentBusinessTypes, productsAndServices, includeSignals, retrievalTerms.precision, and retrievalTerms.recall empty; express the uncertainty only in ambiguity.reason and ambiguity.clarificationQuestion.",
    "For every other intent, providerNeutralCategoryHeads, coreBusinessTypes, and retrievalTerms.precision must contain the strongest physical-business interpretation.",
    "Keep every array concise and unique: at most 4 providerNeutralCategoryHeads, at most 8 coreBusinessTypes, at most 8 retrievalTerms.precision, and at most 16 items in every other array.",
    "A request for advice, information, or a personal decision without an explicit physical business or service location is non_physical with not_applicable location requirement.",
    "Do not output category IDs, provider names, URLs, coordinates, HTTP parameters, map filters, or API instructions.",
    "Locale and country are trusted context only; never repeat or modify geography in the output.",
    "Mark ambiguity only when materially different physical-business interpretations remain.",
    "Output only the required JSON object.",
  ];
  if (mode === "k2.6-thinking-disabled") {
    systemInstructions.push(
      `The JSON object must conform to this exact field structure: ${JSON.stringify(KIMI_SEMANTIC_INTENT_TRANSPORT_SCHEMA)}`,
      "K2.6 cardinality contract: for an unambiguous physical intent, providerNeutralCategoryHeads MUST contain 1 to 4 items and retrievalTerms.precision MUST contain 1 to 8 items. For an ambiguous or non-physical intent, both arrays MUST contain exactly 0 items. Use only the distinct highest-signal source-language and English phrases; never compensate by enumerating synonyms. Put any additional semantic breadth in retrievalTerms.recall within its 16-item limit, and count every array before emitting JSON.",
      "K2.6 semantic state contract and decision precedence: taskContext means the user is searching for real-world business or service locations. Decide the real-world location goal independently from whether the business purpose is resolved. A bare place-form noun with an unresolved or materially plural business purpose is ambiguous, not non-physical: use entityKind unclear, physicalLocationRequirement required, ambiguity.isAmbiguous true, and keep positive arrays and providerNeutralCategoryHeads empty. A missing valid category head for a real-world location goal means ambiguity, never non_physical. Use entityKind non_physical with physicalLocationRequirement not_applicable only when the requested outcome is information, advice, calculation, writing, or another action rather than finding locations.",
    );
  }
  return {
    system: systemInstructions.join(" "),
    user: JSON.stringify({
      taskContext: "business_place_search",
      locale: request.intent.locale,
      countryCodes: request.intent.countryCodes,
      primaryQuery: request.intent.primaryQuery,
      relatedQueries: request.intent.relatedQueries,
      excludeQueries: request.intent.excludeQueries,
      description: request.intent.description,
    }),
  };
}

type ParsedKimiStream = {
  content: string;
  modelId: string | null;
  finishReason: "stop";
  firstSseEventLatencyMs: number;
  usage: KimiUsage;
};

function invalidStream(
  message: string,
  cause?: unknown,
  reason?: KimiInvalidResponseReason,
): KimiClientError {
  return new KimiClientError("KIMI_INVALID_RESPONSE", message, {
    cause,
    reason,
    retryable: true,
  });
}

function invalidStructuredJsonReason(
  content: string,
  error: unknown,
): KimiInvalidResponseReason {
  const trimmed = content.trim();
  if (trimmed.startsWith("```") || trimmed.endsWith("```")) {
    return "structured_json_fence";
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return "structured_json_shape_invalid";
  }
  if (
    error instanceof SyntaxError &&
    /unexpected end|unterminated/i.test(error.message)
  ) {
    return "structured_json_unexpected_end";
  }
  return "structured_json_invalid_token";
}

function semanticValidationIssueCodes(
  error: unknown,
): readonly KimiSemanticValidationIssueCode[] {
  if (!(error instanceof KimiSchemaValidationError)) {
    return ["validation_other"];
  }
  const codes = error.issues.map((issue): KimiSemanticValidationIssueCode => {
    const normalized = issue.toLowerCase();
    if (normalized.includes("providerneutralcategoryheads is required")) {
      return "required_field_missing";
    }
    if (
      normalized.includes("providerneutralcategoryheads must contain at most 4")
    ) {
      return "array_max_provider_neutral_category_heads";
    }
    if (
      normalized.includes(
        "providerneutralcategoryheads must contain bounded english",
      )
    ) {
      return "category_head_invalid";
    }
    if (normalized.includes("non-executable kimi intent must not contain")) {
      return normalized.includes("positive semantic terms")
        ? "nonready_terms_present"
        : "nonready_heads_present";
    }
    if (normalized.includes("executable kimi intent requires")) {
      return "executable_heads_missing";
    }
    if (
      normalized.includes(
        "kimi wire retrievalterms.precision must contain at most 8",
      )
    ) {
      return "array_max_retrieval_precision";
    }
    if (normalized.includes("must have required property")) {
      return "required_field_missing";
    }
    if (normalized.includes("must not have additional properties")) {
      return "additional_property";
    }
    if (normalized.includes("must not have duplicate items")) {
      return "array_duplicate";
    }
    if (normalized.includes("fewer than") && normalized.includes("items")) {
      return "array_min_size";
    }
    if (normalized.includes("more than") && normalized.includes("items")) {
      const boundedArrayFields = [
        ["/adjacentbusinesstypes ", "array_max_adjacent_business_types"],
        ["/corebusinesstypes ", "array_max_core_business_types"],
        ["/excludesignals ", "array_max_exclude_signals"],
        ["/excludedbusinesstypes ", "array_max_excluded_business_types"],
        ["/includesignals ", "array_max_include_signals"],
        ["/industries ", "array_max_industries"],
        ["/productsandservices ", "array_max_products_and_services"],
        ["/retrievalterms/exclude ", "array_max_retrieval_exclude"],
        ["/retrievalterms/precision ", "array_max_retrieval_precision"],
        ["/retrievalterms/recall ", "array_max_retrieval_recall"],
      ] as const;
      const fieldIssue = boundedArrayFields.find(([path]) =>
        normalized.includes(path),
      );
      if (fieldIssue) return fieldIssue[1];
      return "array_max_size";
    }
    if (normalized.includes("non-ambiguous physical intent requires")) {
      return "executable_terms_missing";
    }
    if (
      normalized.includes("shorter than") ||
      normalized.includes("longer than")
    ) {
      return "string_size";
    }
    if (
      normalized.includes("must be equal to constant") ||
      normalized.includes("must be equal to one of the allowed values")
    ) {
      return "enum_or_const";
    }
    if (normalized.includes("unclear intent must")) {
      return "unclear_intent_invariant";
    }
    if (normalized.includes("must be ")) return "type_mismatch";
    if (normalized.includes("ambiguity requires")) return "ambiguity_invariant";
    if (normalized.includes("non_physical intent")) {
      return "non_physical_location_invariant";
    }
    if (normalized.includes("provider-neutral english equivalent")) {
      return "english_retrieval_term_missing";
    }
    if (normalized.includes("must not contain urls")) {
      return "executable_value_forbidden";
    }
    if (normalized.includes("size limit")) return "payload_size";
    if (normalized.includes("cannot be serialized")) return "serialization";
    return "validation_other";
  });
  return Object.freeze([...new Set(codes)]);
}

async function readKimiSse(
  response: Response,
  requestStartedAt: number,
): Promise<ParsedKimiStream> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw errorForStatus(response.status);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw invalidStream(
      "Kimi did not return an SSE stream",
      undefined,
      "sse_content_type_invalid",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let modelId: string | null = null;
  let finishReason: string | null = null;
  let usage: KimiUsage = {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    totalTokens: null,
  };
  let sawDone = false;
  let firstSseEventLatencyMs: number | null = null;
  let bytesRead = 0;

  const acceptEvent = (eventBlock: string) => {
    const dataLines = eventBlock
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (!dataLines.length) return;
    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }
    if (sawDone) {
      throw invalidStream(
        "Kimi sent data after the terminal marker",
        undefined,
        "sse_after_done",
      );
    }

    let chunk: KimiStreamChunk;
    try {
      chunk = JSON.parse(data) as KimiStreamChunk;
    } catch (error) {
      throw invalidStream(
        "Kimi SSE chunk is not valid JSON",
        error,
        "sse_chunk_json_invalid",
      );
    }
    firstSseEventLatencyMs ??= Date.now() - requestStartedAt;
    if (typeof chunk.model === "string") {
      if (modelId !== null && modelId !== chunk.model) {
        throw invalidStream(
          "Kimi SSE model identity changed within the stream",
          undefined,
          "sse_model_changed",
        );
      }
      modelId = chunk.model;
    }
    if (chunk.usage) usage = usageFromResponse(chunk.usage);
    if (chunk.choices === undefined && chunk.usage !== undefined) return;
    if (!Array.isArray(chunk.choices)) {
      throw invalidStream(
        "Kimi SSE chunk has no choices array",
        undefined,
        "sse_missing_choices",
      );
    }
    for (const choice of chunk.choices) {
      if (choice.index !== undefined && choice.index !== 0) {
        throw invalidStream(
          "Kimi SSE returned an unexpected choice index",
          undefined,
          "sse_choice_index_invalid",
        );
      }
      const deltaContent = choice.delta?.content;
      if (deltaContent !== undefined && deltaContent !== null) {
        if (typeof deltaContent !== "string") {
          throw invalidStream(
            "Kimi SSE content delta is invalid",
            undefined,
            "sse_content_delta_invalid",
          );
        }
        content += deltaContent;
        if (content.length > MAX_KIMI_CONTENT_CHARS) {
          throw invalidStream(
            "Kimi structured response is too large",
            undefined,
            "sse_content_size_limit",
          );
        }
      }
      if (choice.usage) usage = usageFromResponse(choice.usage);
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (
          typeof choice.finish_reason !== "string" ||
          (finishReason !== null && finishReason !== choice.finish_reason)
        ) {
          throw invalidStream(
            "Kimi SSE finish reason is invalid",
            undefined,
            "sse_finish_reason_invalid",
          );
        }
        finishReason = choice.finish_reason;
      }
    }
  };

  try {
    while (!sawDone) {
      const { value, done } = await reader.read();
      if (value) {
        bytesRead += value.byteLength;
        if (bytesRead > MAX_KIMI_STREAM_BYTES) {
          throw invalidStream(
            "Kimi SSE stream exceeded the size limit",
            undefined,
            "sse_wire_size_limit",
          );
        }
        buffer += decoder.decode(value, { stream: !done });
      } else if (done) {
        buffer += decoder.decode();
      }
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) acceptEvent(event);
      if (sawDone) {
        if (buffer.trim()) {
          throw invalidStream(
            "Kimi sent data after the terminal marker",
            undefined,
            "sse_after_done",
          );
        }
        break;
      }
      if (done) break;
    }
    if (buffer.trim()) acceptEvent(buffer.trim());
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (!sawDone) {
    throw invalidStream(
      "Kimi SSE stream ended before [DONE]",
      undefined,
      "sse_missing_done",
    );
  }
  if (finishReason !== "stop" || !content) {
    throw invalidStream(
      "Kimi did not return a complete structured response",
      undefined,
      "sse_incomplete",
    );
  }
  if (firstSseEventLatencyMs === null) {
    throw invalidStream(
      "Kimi SSE stream contained no progress event",
      undefined,
      "sse_no_progress",
    );
  }
  return {
    content,
    modelId,
    finishReason: "stop",
    firstSseEventLatencyMs,
    usage,
  };
}

export function createKimiClient(config: KimiClientConfig): KimiClient {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    throw new KimiClientError(
      "KIMI_CONFIGURATION_ERROR",
      "MOONSHOT_API_KEY or KIMI_API_KEY is required",
    );
  }
  const baseUrl = normalizedBaseUrl(config.baseUrl);
  const modelId = cleanModel(config.model);
  const modelPolicy = resolveKimiModelPolicy(modelId, config.reasoningEffort);
  const timeoutMs = positiveInteger(
    config.timeoutMs,
    DEFAULT_KIMI_TIMEOUT_MS,
    "Kimi timeout",
  );
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  return Object.freeze({
    modelId,
    baseUrl,
    cacheIdentity: modelPolicy.cacheIdentity,
    async encode(request: KimiEncodeRequest): Promise<KimiEncodeResult> {
      const prompt = plannerPrompt(request, modelPolicy.mode);
      const responseFormat =
        modelPolicy.mode === "k2.6-thinking-disabled"
          ? { type: "json_object" as const }
          : {
              type: "json_schema" as const,
              json_schema: {
                name: "lead_radar_semantic_intent_v2",
                strict: true,
                schema: KIMI_SEMANTIC_INTENT_TRANSPORT_SCHEMA,
              },
            };
      const startedAt = Date.now();
      const streamed = await timedFetch(
        fetchImpl,
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: modelId,
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
            response_format: responseFormat,
            ...modelPolicy.requestControl,
            max_completion_tokens: 1_200,
            stream: true,
            stream_options: { include_usage: true },
          }),
        },
        timeoutMs,
        request.signal,
        (response) => readKimiSse(response, startedAt),
      );
      const latencyMs = Date.now() - startedAt;
      if (streamed.modelId !== null && streamed.modelId !== modelId) {
        throw invalidStream(
          "Kimi response model does not match the configured model policy",
          undefined,
          "response_model_mismatch",
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(streamed.content);
      } catch (error) {
        throw new KimiClientError(
          "KIMI_INVALID_RESPONSE",
          "Kimi structured response is not valid JSON",
          {
            cause: error,
            reason: invalidStructuredJsonReason(streamed.content, error),
            retryable: true,
          },
        );
      }
      let parsedSemanticIntent;
      try {
        parsedSemanticIntent = parseKimiSemanticIntentWire(parsed);
      } catch (error) {
        throw new KimiClientError(
          "KIMI_INVALID_RESPONSE",
          "Kimi structured response failed local validation",
          {
            cause: error,
            reason: "semantic_schema_invalid",
            semanticValidationIssueCodes: semanticValidationIssueCodes(error),
            retryable: true,
          },
        );
      }
      return {
        semanticIntent: parsedSemanticIntent.semanticIntent,
        providerNeutralCategoryHeads:
          parsedSemanticIntent.providerNeutralCategoryHeads,
        modelId: streamed.modelId ?? modelId,
        finishReason: streamed.finishReason,
        firstSseEventLatencyMs: streamed.firstSseEventLatencyMs,
        latencyMs,
        usage: streamed.usage,
      };
    },
    async listModels(signal?: AbortSignal): Promise<KimiModelsCanaryResult> {
      const startedAt = Date.now();
      const { payload, latencyMs } = await timedFetch(
        fetchImpl,
        `${baseUrl}/models`,
        { method: "GET", headers },
        timeoutMs,
        signal,
        async (response) => {
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw errorForStatus(response.status);
          }
          try {
            return {
              payload: await response.json() as unknown,
              latencyMs: Date.now() - startedAt,
            };
          } catch (error) {
            throw new KimiClientError(
              "KIMI_INVALID_RESPONSE",
              "Kimi model canary returned invalid JSON",
              { cause: error, reason: "models_json_invalid" },
            );
          }
        },
      );
      const data =
        payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
          ? (payload as { data: unknown[] }).data
          : null;
      if (!data) {
        throw new KimiClientError(
          "KIMI_INVALID_RESPONSE",
          "Kimi model canary response has an invalid shape",
          { reason: "models_shape_invalid" },
        );
      }
      const modelIds = [
        ...new Set(
          data
            .map((item) =>
              item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
                ? (item as { id: string }).id
                : null,
            )
            .filter((item): item is string => Boolean(item)),
        ),
      ].sort();
      return {
        ok: true,
        modelIds,
        configuredModelId: modelId,
        configuredModelAvailable: modelIds.includes(modelId),
        latencyMs,
      };
    },
  });
}

export function kimiClientConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KimiClientConfig | null {
  const apiKey = env.MOONSHOT_API_KEY?.trim() || env.KIMI_API_KEY?.trim();
  if (!apiKey) return null;
  const timeoutValue = env.KIMI_REQUEST_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutValue ? Number(timeoutValue) : undefined;
  const model = cleanModel(env.KIMI_PLANNER_MODEL);
  const effort = env.KIMI_PLANNER_REASONING_EFFORT?.trim();
  const reasoningEffort = effort
    ? effort as KimiReasoningEffort
    : undefined;
  resolveKimiModelPolicy(model, reasoningEffort);
  return {
    apiKey,
    baseUrl: env.KIMI_BASE_URL,
    model,
    reasoningEffort,
    timeoutMs,
  };
}

export function createKimiClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KimiClient | null {
  const config = kimiClientConfigFromEnv(env);
  return config ? createKimiClient(config) : null;
}
