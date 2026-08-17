import "server-only";

import {
  KIMI_SEMANTIC_INTENT_SCHEMA,
  validateKimiSemanticIntent,
} from "./schema";
import type {
  KimiEncodeRequest,
  KimiEncodeResult,
  KimiUsage,
} from "./types";

export const DEFAULT_KIMI_BASE_URL = "https://api.moonshot.ai/v1";
export const DEFAULT_KIMI_MODEL = "kimi-k3";
export const DEFAULT_KIMI_TIMEOUT_MS = 30_000;

const ALLOWED_KIMI_HOSTS = new Set(["api.moonshot.ai", "api.moonshot.cn"]);
const MAX_KIMI_STREAM_BYTES = 256_000;

export type KimiReasoningEffort = "low" | "medium" | "high";

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

export type KimiClient = {
  readonly modelId: string;
  readonly baseUrl: string;
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

  constructor(
    code: KimiClientError["code"],
    message: string,
    options: { retryable?: boolean; status?: number | null; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "KimiClientError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
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
      completion_tokens?: unknown;
      total_tokens?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
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

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function usageFromResponse(value: KimiStreamChunk["usage"]): KimiUsage {
  return {
    inputTokens: numberOrNull(value?.prompt_tokens),
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

function plannerPrompt(request: KimiEncodeRequest): {
  system: string;
  user: string;
} {
  return {
    system: [
      "You are the LeadRadar semantic encoder for business-place discovery in CIS countries.",
      "Interpret the user's ordinary language into open-vocabulary business semantics.",
      "Use concise natural-language business types, industries, services, synonyms, and retrieval terms.",
      "Preserve include and exclude intent. Separate the core business from adjacent businesses.",
      "Do not output category IDs, provider names, URLs, coordinates, HTTP parameters, map filters, or API instructions.",
      "Locale and country are trusted context only; never repeat or modify geography in the output.",
      "Mark ambiguity only when materially different physical-business interpretations remain.",
      "Output only the required JSON object.",
    ].join(" "),
    user: JSON.stringify({
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
  usage: KimiUsage;
};

function invalidStream(message: string, cause?: unknown): KimiClientError {
  return new KimiClientError("KIMI_INVALID_RESPONSE", message, {
    cause,
    retryable: true,
  });
}

async function readKimiSse(response: Response): Promise<ParsedKimiStream> {
  if (!response.ok) throw errorForStatus(response.status);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    throw invalidStream("Kimi did not return an SSE stream");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let modelId: string | null = null;
  let finishReason: string | null = null;
  let usage: KimiUsage = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  };
  let sawDone = false;
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
    if (sawDone) throw invalidStream("Kimi sent data after the terminal marker");

    let chunk: KimiStreamChunk;
    try {
      chunk = JSON.parse(data) as KimiStreamChunk;
    } catch (error) {
      throw invalidStream("Kimi SSE chunk is not valid JSON", error);
    }
    if (typeof chunk.model === "string") modelId = chunk.model;
    if (chunk.usage) usage = usageFromResponse(chunk.usage);
    if (!Array.isArray(chunk.choices)) {
      throw invalidStream("Kimi SSE chunk has no choices array");
    }
    for (const choice of chunk.choices) {
      if (choice.index !== undefined && choice.index !== 0) {
        throw invalidStream("Kimi SSE returned an unexpected choice index");
      }
      const deltaContent = choice.delta?.content;
      if (deltaContent !== undefined && deltaContent !== null) {
        if (typeof deltaContent !== "string") {
          throw invalidStream("Kimi SSE content delta is invalid");
        }
        content += deltaContent;
        if (content.length > MAX_KIMI_STREAM_BYTES) {
          throw invalidStream("Kimi structured response is too large");
        }
      }
      if (choice.usage) usage = usageFromResponse(choice.usage);
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (
          typeof choice.finish_reason !== "string" ||
          (finishReason !== null && finishReason !== choice.finish_reason)
        ) {
          throw invalidStream("Kimi SSE finish reason is invalid");
        }
        finishReason = choice.finish_reason;
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (value) {
      bytesRead += value.byteLength;
      if (bytesRead > MAX_KIMI_STREAM_BYTES) {
        throw invalidStream("Kimi SSE stream exceeded the size limit");
      }
      buffer += decoder.decode(value, { stream: !done });
    } else if (done) {
      buffer += decoder.decode();
    }
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const event of events) acceptEvent(event);
    if (done) break;
  }
  if (buffer.trim()) acceptEvent(buffer.trim());

  if (!sawDone) throw invalidStream("Kimi SSE stream ended before [DONE]");
  if (finishReason !== "stop" || !content) {
    throw invalidStream("Kimi did not return a complete structured response");
  }
  return { content, modelId, finishReason: "stop", usage };
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
  const timeoutMs = positiveInteger(
    config.timeoutMs,
    DEFAULT_KIMI_TIMEOUT_MS,
    "Kimi timeout",
  );
  const reasoningEffort = config.reasoningEffort ?? "low";
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  return Object.freeze({
    modelId,
    baseUrl,
    async encode(request: KimiEncodeRequest): Promise<KimiEncodeResult> {
      const prompt = plannerPrompt(request);
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
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "lead_radar_semantic_intent_v2",
                strict: true,
                schema: KIMI_SEMANTIC_INTENT_SCHEMA,
              },
            },
            reasoning_effort: reasoningEffort,
            max_completion_tokens: 1_200,
            stream: true,
          }),
        },
        timeoutMs,
        request.signal,
        readKimiSse,
      );
      const latencyMs = Date.now() - startedAt;
      let parsed: unknown;
      try {
        parsed = JSON.parse(streamed.content);
      } catch (error) {
        throw new KimiClientError(
          "KIMI_INVALID_RESPONSE",
          "Kimi structured response is not valid JSON",
          { cause: error, retryable: true },
        );
      }
      let semanticIntent;
      try {
        semanticIntent = validateKimiSemanticIntent(parsed);
      } catch (error) {
        throw new KimiClientError(
          "KIMI_INVALID_RESPONSE",
          "Kimi structured response failed local validation",
          { cause: error, retryable: true },
        );
      }
      return {
        semanticIntent,
        modelId: streamed.modelId ?? modelId,
        finishReason: streamed.finishReason,
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
          if (!response.ok) throw errorForStatus(response.status);
          try {
            return {
              payload: await response.json() as unknown,
              latencyMs: Date.now() - startedAt,
            };
          } catch (error) {
            throw new KimiClientError(
              "KIMI_INVALID_RESPONSE",
              "Kimi model canary returned invalid JSON",
              { cause: error },
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
  const effort = env.KIMI_PLANNER_REASONING_EFFORT?.trim();
  if (effort && effort !== "low" && effort !== "medium" && effort !== "high") {
    throw new KimiClientError(
      "KIMI_CONFIGURATION_ERROR",
      "KIMI_PLANNER_REASONING_EFFORT must be low, medium, or high",
    );
  }
  return {
    apiKey,
    baseUrl: env.KIMI_BASE_URL,
    model: env.KIMI_PLANNER_MODEL,
    reasoningEffort: effort as KimiReasoningEffort | undefined,
    timeoutMs,
  };
}

export function createKimiClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KimiClient | null {
  const config = kimiClientConfigFromEnv(env);
  return config ? createKimiClient(config) : null;
}
