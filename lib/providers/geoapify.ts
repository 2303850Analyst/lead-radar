import type {
  Lead,
  LeadRelevance,
  LeadRetrievalArm,
  SearchProviderExecutedRetrievalArm,
  SearchPayload,
  SearchProgressEvent,
  SearchResponse,
} from "../types";
import type {
  MetroStation,
  RussianMetroSystem,
  RussianMetroSystemId,
} from "../metro";
import {
  applyGeoapifyNativeResolution,
  GEOAPIFY_CAPABILITY_REGISTRY,
  GEOAPIFY_PROVIDER_CATALOG_VERSION,
  isGeoapifyCategoryId,
} from "../search-planner/catalogs/geoapify";
import {
  classifyCandidateRelevance,
  notCheckedRelevance,
  validateCandidateRelevance,
  type CandidateEvidence,
  type RelevanceClassifierInput,
} from "../search-planner/relevance";
import type { SemanticIntentV2 } from "../search-planner/types";
import {
  GeoapifyNativeRecoveryError,
  projectGeoapifyNativeRecovery,
  resolveGeoapifyNativeRecovery,
  type GeoapifyAutocompleteFailureCode,
  type GeoapifyCategoryObservation,
} from "../geoapify-native-recovery";
import {
  SearchProviderError,
  type CompiledGeoapifyPlan,
  type SearchProvider,
  type SearchProviderOptions,
} from "./types";
import { selectGeoapifyCategoryHints } from "./geoapify-category-resolver";

const GEOCODE_ENDPOINT = "https://api.geoapify.com/v1/geocode/search";
const AUTOCOMPLETE_ENDPOINT = "https://api.geoapify.com/v1/geocode/autocomplete";
const PLACES_ENDPOINT = "https://api.geoapify.com/v2/places";
const PLACE_DETAILS_ENDPOINT = "https://api.geoapify.com/v2/place-details";
const FETCH_TIMEOUT_MS = 15_000;
const DETAILS_FETCH_TIMEOUT_MS = 8_000;
const DETAILS_STAGE_BUDGET_MS = 15_000;
const PLACES_STAGE_BUDGET_MS = 7_000;
const CATEGORY_HINT_TIMEOUT_MS = 1_500;
const MIN_CATEGORY_HINT_BUDGET_MS = 300;
const MAX_CATEGORY_HINT_RESPONSE_BYTES = 128 * 1024;
const MIN_MATCHED_RESULTS_BEFORE_EXPANSION_STOP = 10;
const MIN_REQUEST_INTERVAL_MS = 225;
const MAX_GEOAPIFY_RESPONSE_BYTES = 8 * 1024 * 1024;

const DEFAULT_PLACES_LIMIT = 100;
const MAX_PLACES_LIMIT = 500;
const DEFAULT_DETAILS_LIMIT = 20;
const MAX_DETAILS_LIMIT = 50;
const MAX_RETRIEVAL_ARMS = 4;
const MAX_RETRIEVAL_REQUESTS = 4;
const MAX_RETRIEVAL_CARDS = 200;
const MAX_CANDIDATE_CATEGORY_IDS = 32;
const MAX_RELEVANCE_CLASSIFIER_CANDIDATES = 20;
const DEFAULT_RELEVANCE_CLASSIFIER_TIMEOUT_MS = 8_000;
const NORMALIZATION_RESERVE_MS = 1_000;
const MIN_OPTIONAL_STAGE_BUDGET_MS = 1_000;
const ORGANIZATION_IDENTITY_MAX_DISTANCE_METERS = 100;
const DETAILS_CONCURRENCY = 3;
const METRO_STATION_CATEGORY = "public_transport.subway";
const METRO_STATION_ENTRANCE_CATEGORY = "public_transport.subway.entrance";
const METRO_STATION_PAGE_LIMIT = 500;
const MAX_METRO_STATION_PAGES = 5;
const VERIFIED_METRO_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_VERIFIED_METRO_CACHE_ENTRIES = 500;
let nextGeoapifyRequestAt = 0;

const verifiedMetroStations = new Map<
  string,
  { station: MetroStation; expiresAtMs: number }
>();

function abortedSearchError(): SearchProviderError {
  return new SearchProviderError("Поиск отменён", "SEARCH_ABORTED");
}

function throwIfSearchAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedSearchError();
}

async function abortableDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (delayMs <= 0) return;
  throwIfSearchAborted(signal);

  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(abortedSearchError());
    };
    const timeout = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

const LOGISTICS_CATEGORIES = [
  "office.logistics",
  "rental.storage",
] as const;

type GeoapifyFeature = {
  id?: string | number;
  properties?: Record<string, unknown>;
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
};

type GeoapifyCollection = {
  features?: GeoapifyFeature[];
};

type GeoapifyObservedFact = {
  externalId: string;
  name: string | null;
  address: string;
  coordinates: [number, number] | null;
  categories: string[];
  categoryLabel: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  telegram: string | null;
  vk: string | null;
  detailsObserved: boolean;
};

function emitGeoapifyCanaryFacts(features: GeoapifyFeature[]): void {
  const channel = process.env.SEARCH_CANARY_FACT_OBSERVER_CHANNEL?.trim();
  if (
    process.env.RUN_SEARCH_LIVE_CANARY !== "1" ||
    !channel ||
    !/^[a-f0-9]{64}$/.test(channel)
  ) {
    return;
  }
  const observerSymbol = Symbol.for(
    `lead-radar.geoapify-canary-fact-observer.v1.${channel}`,
  );
  const observer = (
    globalThis as unknown as Record<symbol, unknown>
  )[observerSymbol];
  if (typeof observer !== "function") return;
  const facts: GeoapifyObservedFact[] = features.map((feature) => {
    const properties = feature.properties ?? {};
    const coordinates = featureCoordinates(feature);
    const categories = boundedProviderCategoryIds(
      properties.categories,
      properties.category,
    );
    const contact = detailContact(properties);
    return {
      externalId: externalId(feature),
      name: placeName(feature),
      address: placeAddress(properties),
      coordinates,
      categories,
      categoryLabel: categoryLabel(categories),
      phone: firstContactValue(properties, "phone"),
      email: firstContactValue(properties, "email"),
      website: safeHttpUrl(firstContactValue(properties, "website")),
      telegram:
        socialUrl(contact.telegram ?? contact["contact:telegram"], "telegram") ??
        null,
      vk: socialUrl(contact.vk ?? contact["contact:vk"], "vk") ?? null,
      detailsObserved: properties.feature_type === "details",
    };
  });
  try {
    (observer as (facts: GeoapifyObservedFact[]) => void)(facts);
  } catch {
    // A diagnostic observer must never alter search behavior or error mapping.
  }
}

export type GeoapifyMetroStationDirectory = {
  systemId: RussianMetroSystemId;
  stations: MetroStation[];
  fetchedAt: string;
};

type CategoryPlan = {
  categories: string[];
  batches: CompiledGeoapifyPlan["batches"];
  limits: CompiledGeoapifyPlan["limits"];
  exclusionTerms: string[];
};

type CategoryResolutionState = {
  status: "disabled" | "not_needed" | "resolved" | "no_match" | "degraded";
  requests: 0 | 1;
};

type PlaceObservation = {
  feature: GeoapifyFeature;
  externalId: string;
  externalIds: string[];
  placeId: string | null;
  /** Union of category facts observed on every provider record merged here. */
  providerCategoryIds: string[];
  retrievalArms: LeadRetrievalArm[];
};

type DetailEnrichment = {
  properties: Record<string, unknown> | null;
  succeeded: boolean;
  temporaryFailure: boolean;
  canonicalExternalId?: string;
};

const CATEGORY_RULES: Array<{ terms: RegExp; categories: string[] }> = [
  {
    terms:
      /фулфил|fulfil|склад|хранени|логист|комплектац|маркировк|упаковк|warehouse|storage|logistic/i,
    categories: [...LOGISTICS_CATEGORIES],
  },
  {
    terms: /стомат|дантист|dentist|dental/i,
    categories: ["healthcare.dentist"],
  },
  {
    terms: /ресторан|restaurant/i,
    categories: ["catering.restaurant"],
  },
  {
    terms: /кафе|coffee|cafe/i,
    categories: ["catering.cafe"],
  },
  {
    terms: /отел|гостиниц|hotel/i,
    categories: ["accommodation.hotel"],
  },
  {
    terms: /автосервис|шиномонтаж|автомастер|car service|vehicle service/i,
    categories: ["service.vehicle.repair"],
  },
  {
    terms: /супермаркет|продуктов.*магазин|supermarket/i,
    categories: ["commercial.supermarket"],
  },
  {
    terms: /салон красот|косметолог|парикмах|beauty salon/i,
    categories: ["service.beauty"],
  },
];

const CATEGORY_LABELS: Record<string, string> = {
  "office.logistics": "Логистика",
  "rental.storage": "Складские услуги",
  "building.industrial": "Промышленный объект",
  "healthcare.dentist": "Стоматология",
  "catering.restaurant": "Ресторан",
  "catering.cafe": "Кафе",
  "accommodation.hotel": "Гостиница",
  "service.vehicle.repair": "Автосервис",
  "commercial.supermarket": "Супермаркет",
  "service.beauty": "Салон красоты",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, maxLength = 2_048): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result && result.length <= maxLength ? result : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringValue(item, 200))
    .filter((item): item is string => Boolean(item));
}

function boundedProviderCategoryIds(
  value: unknown,
  singularValue?: unknown,
): string[] {
  const singular = stringValue(singularValue, 2_048);
  const candidates = [
    ...stringArray(value),
    ...(singular ? singular.split(/[;,]/u) : []),
  ];
  const result: string[] = [];
  for (const item of candidates) {
    const categoryId = stringValue(item, 200);
    if (
      categoryId &&
      isGeoapifyCategoryId(categoryId) &&
      !result.includes(categoryId)
    ) {
      result.push(categoryId);
      if (result.length >= MAX_CANDIDATE_CATEGORY_IDS) break;
    }
  }
  return result;
}

function validCoordinates(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1]) &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function boundedInteger(
  raw: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, parsed))
    : defaultValue;
}

export function geoapifyPlacesLimit(): number {
  return boundedInteger(
    process.env.GEOAPIFY_PLACES_LIMIT,
    DEFAULT_PLACES_LIMIT,
    1,
    MAX_PLACES_LIMIT,
  );
}

export function geoapifyDetailsLimit(): number {
  return boundedInteger(
    process.env.GEOAPIFY_DETAILS_LIMIT,
    DEFAULT_DETAILS_LIMIT,
    0,
    MAX_DETAILS_LIMIT,
  );
}

function relevanceClassifierTimeoutMs(): number {
  return boundedInteger(
    process.env.KIMI_LEAD_CLASSIFIER_TIMEOUT_MS,
    DEFAULT_RELEVANCE_CLASSIFIER_TIMEOUT_MS,
    10,
    DEFAULT_RELEVANCE_CLASSIFIER_TIMEOUT_MS,
  );
}

function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function containsTerm(searchable: string, term: string): boolean {
  const normalizedTerm = normalizeText(term);
  if (!normalizedTerm) return false;
  if (searchable.includes(normalizedTerm)) return true;
  const tokens = normalizedTerm.split(" ").filter((token) => token.length >= 3);
  return tokens.length > 1 && tokens.every((token) => searchable.includes(token));
}

function fallbackGeocodeText(nameQuery: string, location: string): string {
  const normalizedLocation = location.trim();
  return normalizedLocation &&
    !/^точка\s+на\s+карте$/iu.test(normalizedLocation)
    ? `${nameQuery}, ${normalizedLocation}`
    : nameQuery;
}

export function resolveGeoapifyCategories(payload: SearchPayload): CategoryPlan {
  const categoryInput = [
    payload.primaryQuery,
    ...payload.relatedQueries,
    payload.description,
  ].join(" ");
  const categories = new Set<string>();

  for (const rule of CATEGORY_RULES) {
    if (rule.terms.test(categoryInput)) {
      for (const category of rule.categories) categories.add(category);
    }
  }

  if (!categories.size) {
    throw new SearchProviderError(
      "Для этого запроса пока не настроена категория Geoapify. Уточните вид бизнеса или добавьте отраслевой словарь.",
      "GEOAPIFY_UNSUPPORTED_CATEGORY",
    );
  }

  const all = [...categories];
  return {
    categories: all,
    batches: [{
      id: "arm-legacy-00000000",
      type: "legacy",
      mode: "precision",
      role: "primary",
      priority: 1,
      resultBudget: Math.min(DEFAULT_PLACES_LIMIT, MAX_RETRIEVAL_CARDS),
      categoryIds: all,
      nameQuery: null,
      provenance: all.map((categoryId) => ({
        semanticField: "legacy",
        semanticTerm: payload.primaryQuery,
        origin: "legacy",
        match: "legacy_binding",
        categoryId,
      })),
    }],
    limits: {
      maxArms: MAX_RETRIEVAL_ARMS,
      maxUpstreamRequests: MAX_RETRIEVAL_REQUESTS,
      maxCards: MAX_RETRIEVAL_CARDS,
      maxDetails: MAX_DETAILS_LIMIT,
    },
    exclusionTerms: [],
  };
}

function matchesQueryTerm(searchable: string, term: string): boolean {
  return containsTerm(searchable, term);
}

function safeHttpUrl(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function socialUrl(value: unknown, service: "telegram" | "vk"): string | undefined {
  const raw = stringValue(value, 500);
  if (!raw) return undefined;
  if (service === "telegram" && /^@[a-z\d_]{3,}$/i.test(raw)) {
    return `https://t.me/${raw.slice(1)}`;
  }
  const url = safeHttpUrl(raw);
  if (!url) return undefined;
  try {
    const hostname = new URL(url).hostname.toLocaleLowerCase("en-US");
    const allowed =
      service === "telegram"
        ? hostname === "t.me" || hostname.endsWith(".t.me")
        : hostname === "vk.com" || hostname.endsWith(".vk.com");
    return allowed ? url : undefined;
  } catch {
    return undefined;
  }
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SearchProviderError(
      "Geoapify вернул слишком большой ответ",
      "GEOAPIFY_INVALID_RESPONSE",
    );
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new SearchProviderError(
        "Geoapify вернул слишком большой ответ",
        "GEOAPIFY_INVALID_RESPONSE",
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function requestGeoapify(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string,
  timeoutMs = FETCH_TIMEOUT_MS,
  signal?: AbortSignal,
  maxResponseBytes = MAX_GEOAPIFY_RESPONSE_BYTES,
): Promise<GeoapifyCollection> {
  throwIfSearchAborted(signal);
  const query = new URLSearchParams(params);
  query.set("apiKey", apiKey);
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  if (signal?.aborted) abortRequest();
  else signal?.addEventListener("abort", abortRequest, { once: true });
  // Start the deadline before rate pacing so the wait and the upstream fetch
  // consume one shared per-call/stage budget.
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const now = Date.now();
  const requestAt = Math.max(now, nextGeoapifyRequestAt);
  nextGeoapifyRequestAt = requestAt + MIN_REQUEST_INTERVAL_MS;

  try {
    await abortableDelay(requestAt - now, controller.signal);
    const response = await fetch(`${endpoint}?${query.toString()}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 400) {
        throw new SearchProviderError(
          "Geoapify отклонил параметры поискового запроса",
          "GEOAPIFY_BAD_REQUEST",
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new SearchProviderError(
          "Ключ Geoapify недействителен или не имеет доступа к выбранному API",
          "GEOAPIFY_FORBIDDEN",
        );
      }
      if (response.status === 429) {
        throw new SearchProviderError(
          "Превышен лимит запросов Geoapify",
          "GEOAPIFY_RATE_LIMIT",
        );
      }
      throw new SearchProviderError(
        `Geoapify временно недоступен (HTTP ${response.status})`,
        "GEOAPIFY_UPSTREAM_ERROR",
      );
    }

    try {
      const responseText = await readBoundedResponseText(
        response,
        maxResponseBytes,
      );
      const data: unknown = JSON.parse(responseText);
      if (!isRecord(data)) {
        throw new SearchProviderError(
          "Geoapify вернул ответ неизвестного формата",
          "GEOAPIFY_INVALID_RESPONSE",
        );
      }
      const features = data.features;
      if (
        features !== undefined &&
        (!Array.isArray(features) ||
          features.some(
            (feature) =>
              !isRecord(feature) ||
              (feature.properties !== undefined && !isRecord(feature.properties)) ||
              (feature.geometry !== undefined && !isRecord(feature.geometry)),
          ))
      ) {
        throw new SearchProviderError(
          "Geoapify вернул ответ неизвестного формата",
          "GEOAPIFY_INVALID_RESPONSE",
        );
      }
      const collection = {
        features: features as GeoapifyFeature[] | undefined,
      };
      if (collection.features?.length) {
        emitGeoapifyCanaryFacts(collection.features);
      }
      return collection;
    } catch (error) {
      if (error instanceof SearchProviderError) throw error;
      throw new SearchProviderError(
        "Не удалось прочитать ответ Geoapify",
        "GEOAPIFY_INVALID_RESPONSE",
      );
    }
  } catch (error) {
    if (signal?.aborted) throw abortedSearchError();
    if (controller.signal.aborted) {
      throw new SearchProviderError(
        `Geoapify не ответил за ${Math.ceil(timeoutMs / 1_000)} секунд`,
        "GEOAPIFY_TIMEOUT",
      );
    }
    if (error instanceof SearchProviderError) throw error;
    // Native fetch errors may include the full request URL and API key. Never
    // forward their messages to callers or logs.
    throw new SearchProviderError(
      "Не удалось подключиться к Geoapify",
      "GEOAPIFY_NETWORK_ERROR",
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortRequest);
  }
}

export async function geocodeGeoapifyLocation(
  location: string,
  apiKey: string,
  signal?: AbortSignal,
  countryCode = "RU",
  language: "ru" | "be" | "kk" = "ru",
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<[number, number]> {
  const normalizedLocation = location.trim();
  if (!normalizedLocation) {
    throw new SearchProviderError(
      "Укажите город, район или адрес центра поиска",
      "GEOAPIFY_INVALID_LOCATION",
    );
  }
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) {
    throw new SearchProviderError(
      "Серверный ключ Geoapify не настроен",
      "GEOAPIFY_NOT_CONFIGURED",
    );
  }
  const data = await requestGeoapify(
    GEOCODE_ENDPOINT,
    {
      text: normalizedLocation,
      lang: language,
      filter: `countrycode:${countryCode.toLocaleLowerCase("en-US")}`,
      format: "geojson",
      limit: "1",
    },
    normalizedApiKey,
    timeoutMs,
    signal,
  );
  const feature = data.features?.[0];
  const geometryCoordinates = feature?.geometry?.coordinates;
  if (validCoordinates(geometryCoordinates)) {
    return [geometryCoordinates[0], geometryCoordinates[1]];
  }
  const lon = feature?.properties?.lon;
  const lat = feature?.properties?.lat;
  const propertyCoordinates: unknown = [lon, lat];
  if (validCoordinates(propertyCoordinates)) {
    return propertyCoordinates;
  }
  throw new SearchProviderError(
    "Не удалось определить указанную географию в выбранной стране",
    "GEOAPIFY_LOCATION_NOT_FOUND",
  );
}

function placeName(feature: GeoapifyFeature): string | null {
  return stringValue(feature.properties?.name, 300);
}

function isCountryPlace(feature: GeoapifyFeature, expectedCountryCode: string): boolean {
  const countryCode = stringValue(feature.properties?.country_code, 8);
  // Old or community-authored OSM objects may omit the country code. The
  // circle still guarantees geographic proximity, so only reject an explicit
  // non-Russian country marker.
  return (
    !countryCode ||
    countryCode.toLocaleLowerCase("en-US") ===
      expectedCountryCode.toLocaleLowerCase("en-US")
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    right.every((value) => leftSet.has(value))
  );
}

function compiledPlanHasReadableShape(
  value: unknown,
): value is NonNullable<SearchProviderOptions["compiledPlan"]> {
  if (!isRecord(value) || !isRecord(value.limits)) return false;
  if (
    !Array.isArray(value.categoryIds) ||
    !value.categoryIds.every((item) => typeof item === "string") ||
    !Array.isArray(value.exclusionTerms) ||
    !value.exclusionTerms.every((item) => typeof item === "string") ||
    !Array.isArray(value.batches)
  ) {
    return false;
  }
  return value.batches.every(
    (batch) =>
      isRecord(batch) &&
      typeof batch.id === "string" &&
      typeof batch.type === "string" &&
      typeof batch.mode === "string" &&
      typeof batch.role === "string" &&
      typeof batch.priority === "number" &&
      typeof batch.resultBudget === "number" &&
      (batch.nameQuery === null || typeof batch.nameQuery === "string") &&
      Array.isArray(batch.categoryIds) &&
      batch.categoryIds.every((item) => typeof item === "string") &&
      Array.isArray(batch.provenance) &&
      batch.provenance.every(
        (item) =>
          isRecord(item) &&
          typeof item.semanticField === "string" &&
          typeof item.semanticTerm === "string" &&
          typeof item.origin === "string" &&
          typeof item.match === "string" &&
          typeof item.categoryId === "string",
      ),
  );
}

function provenanceMatchesArm(
  batch: NonNullable<SearchProviderOptions["compiledPlan"]>["batches"][number],
  item: NonNullable<SearchProviderOptions["compiledPlan"]>["batches"][number]["provenance"][number],
): boolean {
  if (item.semanticField !== batch.type) return false;
  if (batch.type === "fallback") {
    return (
      item.match === "name_fallback" &&
      [
        "normalizedGoal",
        "coreBusinessTypes",
        "retrievalTerms.precision",
        "source.primaryQuery",
        "source.relatedQueries",
      ].includes(item.origin)
    );
  }
  if (batch.type === "legacy") {
    return item.match === "legacy_binding" && item.origin === "legacy";
  }
  if (!["exact_leaf", "exact_path", "parent"].includes(item.match)) return false;
  if (batch.type === "precision") {
    return [
      "coreBusinessTypes",
      "productsAndServices",
      "retrievalTerms.precision",
    ].includes(item.origin);
  }
  if (batch.type === "recall") {
    return ["industries", "retrievalTerms.recall"].includes(item.origin);
  }
  return batch.type === "adjacent" && item.origin === "adjacentBusinessTypes";
}

function compiledPlanIsCoherent(
  plan: NonNullable<SearchProviderOptions["compiledPlan"]>,
): boolean {
  if (
    !plan.limits ||
    !Array.isArray(plan.batches) ||
    !Array.isArray(plan.categoryIds) ||
    !Array.isArray(plan.exclusionTerms) ||
    (plan.nativeCategoryResolutionRequired !== undefined &&
      typeof plan.nativeCategoryResolutionRequired !== "boolean")
  ) {
    return false;
  }
  const { limits } = plan;
  if (
    !Number.isInteger(limits.maxArms) ||
    limits.maxArms < 1 ||
    limits.maxArms > MAX_RETRIEVAL_ARMS ||
    !Number.isInteger(limits.maxUpstreamRequests) ||
    limits.maxUpstreamRequests < 1 ||
    limits.maxUpstreamRequests > MAX_RETRIEVAL_REQUESTS ||
    !Number.isInteger(limits.maxCards) ||
    limits.maxCards < 1 ||
    limits.maxCards > MAX_RETRIEVAL_CARDS ||
    !Number.isInteger(limits.maxDetails) ||
    limits.maxDetails < 0 ||
    limits.maxDetails > MAX_DETAILS_LIMIT ||
    plan.batches.length < 1 ||
    plan.batches.length > Math.min(limits.maxArms, limits.maxUpstreamRequests)
  ) {
    return false;
  }
  if (
    plan.categoryIds.length < 1 ||
    plan.categoryIds.length > 32 ||
    plan.exclusionTerms.length > 60 ||
    plan.exclusionTerms.some(
      (term) => term.length < 1 || term.length > 120 || term !== term.trim(),
    ) ||
    !["RU", "BY", "KZ"].includes(plan.countryCode) ||
    !["ru", "be", "kk"].includes(plan.language)
  ) {
    return false;
  }
  if (new Set(plan.batches.map((batch) => batch.id)).size !== plan.batches.length) {
    return false;
  }
  if (
    new Set(plan.batches.map((batch) => batch.priority)).size !== plan.batches.length ||
    plan.batches.reduce((sum, batch) => sum + batch.resultBudget, 0) > limits.maxCards
  ) {
    return false;
  }
  const flattened: string[] = [];
  for (const batch of plan.batches) {
    if (
      !["precision", "recall", "adjacent", "fallback", "legacy"].includes(
        batch.type,
      )
    ) {
      return false;
    }
    const expectedMode =
      batch.type === "precision" || batch.type === "legacy" ? "precision" : "broad";
    const expectedRole =
      batch.type === "adjacent"
        ? "adjacent"
        : batch.type === "fallback"
          ? "fallback"
          : "primary";
    const expectedField = batch.type;
    const validNameQuery =
      batch.type === "fallback"
        ? typeof batch.nameQuery === "string" &&
          batch.nameQuery.length >= 2 &&
          batch.nameQuery.length <= 80 &&
          /^[\p{L}\p{N}'’ -]+$/u.test(batch.nameQuery)
        : batch.nameQuery === null;
    if (
      !/^arm-[a-z]+-[a-f0-9]{8}$/.test(batch.id) ||
      batch.mode !== expectedMode ||
      batch.role !== expectedRole ||
      !Number.isInteger(batch.priority) ||
      batch.priority < 1 ||
      !Number.isInteger(batch.resultBudget) ||
      batch.resultBudget < 1 ||
      batch.resultBudget > limits.maxCards ||
      !validNameQuery ||
      batch.categoryIds.length < 1 ||
      batch.categoryIds.length > 8 ||
      !sameStringSet(
        batch.categoryIds,
        batch.provenance.map((item) => item.categoryId),
      ) ||
      batch.provenance.some(
        (item) =>
          item.semanticField !== expectedField ||
          !provenanceMatchesArm(batch, item) ||
          !item.semanticTerm.trim() ||
          item.semanticTerm.length > 120 ||
          !item.origin.trim() ||
          ![
            "normalizedGoal",
            "coreBusinessTypes",
            "productsAndServices",
            "industries",
            "adjacentBusinessTypes",
            "retrievalTerms.precision",
            "retrievalTerms.recall",
            "source.primaryQuery",
            "source.relatedQueries",
            "legacy",
          ].includes(item.origin) ||
          ![
            "exact_leaf",
            "exact_path",
            "parent",
            "name_fallback",
            "legacy_binding",
          ].includes(item.match),
      )
    ) {
      return false;
    }
    flattened.push(...batch.categoryIds);
  }
  if (!sameStringSet(plan.categoryIds, [...new Set(flattened)])) return false;
  if (plan.nativeCategoryResolutionRequired) {
    const authorization = projectGeoapifyNativeRecovery(plan);
    if (
      !authorization ||
      plan.batches.length !== 1 ||
      authorization.planArmId !== plan.batches[0]?.id
    ) {
      return false;
    }
  }
  return true;
}

function categoryPlanFromCompiled(
  plan: Pick<
    NonNullable<SearchProviderOptions["compiledPlan"]>,
    "categoryIds" | "batches" | "limits" | "exclusionTerms"
  >,
): CategoryPlan {
  return {
    categories: [...plan.categoryIds],
    batches: plan.batches.map((batch) => ({
      ...batch,
      categoryIds: [...batch.categoryIds],
      provenance: batch.provenance.map((item) => ({ ...item })),
    })),
    limits: { ...plan.limits },
    exclusionTerms: [...plan.exclusionTerms],
  };
}

function nativeRecoveryFailureCode(
  error: SearchProviderError,
): GeoapifyAutocompleteFailureCode {
  switch (error.code) {
    case "GEOAPIFY_FORBIDDEN":
      return "forbidden";
    case "GEOAPIFY_RATE_LIMIT":
      return "rate_limited";
    case "GEOAPIFY_TIMEOUT":
      return "timeout";
    case "GEOAPIFY_NETWORK_ERROR":
      return "network";
    case "GEOAPIFY_UPSTREAM_ERROR":
      return "upstream";
    default:
      return "invalid_response";
  }
}

function providerErrorForNativeRecovery(
  error: GeoapifyNativeRecoveryError,
): SearchProviderError {
  switch (error.code) {
    case "invalid_authorization":
      return new SearchProviderError(
        "Подписанный recovery-план не прошёл серверную проверку",
        "GEOAPIFY_INVALID_COMPILED_PLAN",
      );
    case "forbidden":
      return new SearchProviderError(
        "Ключ Geoapify недействителен или не имеет доступа к выбранному API",
        "GEOAPIFY_FORBIDDEN",
      );
    case "rate_limited":
      return new SearchProviderError(
        "Превышен лимит запросов Geoapify",
        "GEOAPIFY_RATE_LIMIT",
      );
    case "timeout":
      return new SearchProviderError(
        "Geoapify не успел подтвердить категорию",
        "GEOAPIFY_TIMEOUT",
      );
    case "network":
      return new SearchProviderError(
        "Не удалось подключиться к Geoapify",
        "GEOAPIFY_NETWORK_ERROR",
      );
    case "upstream":
      return new SearchProviderError(
        "Geoapify временно недоступен",
        "GEOAPIFY_UPSTREAM_ERROR",
      );
    case "invalid_response":
      return new SearchProviderError(
        "Geoapify вернул ответ неизвестного формата",
        "GEOAPIFY_INVALID_RESPONSE",
      );
    case "budget":
    case "no_match":
      return new SearchProviderError(
        "Geoapify не подтвердил исполняемую категорию",
        "GEOAPIFY_UNSUPPORTED_CATEGORY",
      );
  }
}

function needsNativeCategoryResolution(
  plan: NonNullable<SearchProviderOptions["compiledPlan"]>,
): boolean {
  const hasFallback = plan.batches.some(
    (batch) => batch.type === "fallback" && Boolean(batch.nameQuery),
  );
  const hasNarrowProviderCategory = plan.batches.some(
    (batch) =>
      (["precision", "recall", "legacy"] as const).includes(
        batch.type as "precision" | "recall" | "legacy",
      ) &&
      batch.provenance.some(
        (item) =>
          ["exact_leaf", "exact_path", "legacy_binding"].includes(item.match) &&
          [
            "coreBusinessTypes",
            "retrievalTerms.precision",
            "retrievalTerms.recall",
            "legacy",
          ].includes(item.origin),
      ),
  );
  return hasFallback && !hasNarrowProviderCategory;
}

type MetroStationObservation = {
  name: string;
  normalizedName: string;
  coordinates: [number, number];
  lineColor: string | null;
  placeId: string | null;
};

type MetroGeocodeCandidate = {
  normalizedName: string;
  coordinates: [number, number];
  placeId: string;
};

type MetroStationGroup = {
  names: Set<string>;
  coordinates: Array<[number, number]>;
  lineColors: Set<string>;
  providerPlaceIds: Set<string>;
};

const metroStationCollator = new Intl.Collator("ru-RU", {
  numeric: true,
  sensitivity: "base",
});

function safeStationName(value: unknown): string | null {
  const raw = stringValue(value, 160);
  if (!raw) return null;
  const normalizedWhitespace = raw
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizedWhitespace || null;
}

function safeMetroLineColor(value: unknown): string | null {
  const color = stringValue(value, 9);
  return color && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(color)
    ? color.toLocaleLowerCase("en-US")
    : null;
}

function featureCoordinates(feature: GeoapifyFeature): [number, number] | null {
  const geometryCoordinates = feature.geometry?.coordinates;
  if (validCoordinates(geometryCoordinates)) {
    return [geometryCoordinates[0], geometryCoordinates[1]];
  }
  const propertyCoordinates: unknown = [
    feature.properties?.lon,
    feature.properties?.lat,
  ];
  return validCoordinates(propertyCoordinates)
    ? [propertyCoordinates[0], propertyCoordinates[1]]
    : null;
}

function normalizeMetroStationObservation(
  feature: GeoapifyFeature,
): MetroStationObservation | null {
  const properties = feature.properties ?? {};
  const categories = boundedProviderCategoryIds(
    properties.categories,
    properties.category,
  );
  if (
    !categories.includes(METRO_STATION_CATEGORY) ||
    categories.includes(METRO_STATION_ENTRANCE_CATEGORY) ||
    !isCountryPlace(feature, "RU")
  ) {
    return null;
  }
  const name = safeStationName(properties.name);
  const coordinates = featureCoordinates(feature);
  if (!name || !coordinates) return null;
  const normalizedName = normalizeText(name);
  if (!normalizedName) return null;
  return {
    name,
    normalizedName,
    coordinates,
    lineColor: safeMetroLineColor(properties.color),
    placeId: stringValue(properties.place_id, 500),
  };
}

function normalizeMetroGeocodeCandidate(
  feature: GeoapifyFeature,
): MetroGeocodeCandidate | null {
  const properties = feature.properties ?? {};
  if (
    stringValue(properties.result_type, 40) !== "amenity" ||
    !isCountryPlace(feature, "RU")
  ) {
    return null;
  }
  const name = safeStationName(properties.name);
  const coordinates = featureCoordinates(feature);
  const placeId = stringValue(properties.place_id, 500);
  if (!name || !coordinates || !placeId) return null;
  const normalizedName = normalizeText(name);
  return normalizedName ? { normalizedName, coordinates, placeId } : null;
}

function averageStationCoordinates(
  coordinates: Array<[number, number]>,
): [number, number] {
  const [lonTotal, latTotal] = coordinates.reduce(
    ([lon, lat], current) => [lon + current[0], lat + current[1]],
    [0, 0],
  );
  return [
    Number((lonTotal / coordinates.length).toFixed(6)),
    Number((latTotal / coordinates.length).toFixed(6)),
  ];
}

function distanceMeters(
  left: readonly [number, number],
  right: readonly [number, number],
): number {
  const earthRadiusMeters = 6_371_000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(right[1] - left[1]);
  const longitudeDelta = toRadians(right[0] - left[0]);
  const leftLatitude = toRadians(left[1]);
  const rightLatitude = toRadians(right[1]);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
}

function metroStationId(
  systemId: RussianMetroSystemId,
  normalizedName: string,
  providerPlaceIds: string[],
): string {
  return providerPlaceIds[0]
    ? `geoapify:${providerPlaceIds[0]}`
    : `${systemId}:${encodeURIComponent(normalizedName)}`;
}

function dedupeMetroStations(
  systemId: RussianMetroSystemId,
  observations: MetroStationObservation[],
): MetroStation[] {
  const groups = new Map<string, MetroStationGroup>();
  for (const observation of observations) {
    const group = groups.get(observation.normalizedName) ?? {
      names: new Set<string>(),
      coordinates: [],
      lineColors: new Set<string>(),
      providerPlaceIds: new Set<string>(),
    };
    group.names.add(observation.name);
    group.coordinates.push(observation.coordinates);
    if (observation.lineColor) group.lineColors.add(observation.lineColor);
    if (observation.placeId) group.providerPlaceIds.add(observation.placeId);
    groups.set(observation.normalizedName, group);
  }

  return [...groups.entries()]
    .map(([normalizedName, group]): MetroStation => {
      const names = [...group.names].sort(metroStationCollator.compare);
      const providerPlaceIds = [...group.providerPlaceIds].sort();
      return {
        id: metroStationId(systemId, normalizedName, providerPlaceIds),
        systemId,
        name: names[0],
        coordinates: averageStationCoordinates(group.coordinates),
        lineColors: [...group.lineColors].sort(),
        providerPlaceIds,
      };
    })
    .sort((left, right) => metroStationCollator.compare(left.name, right.name));
}

export function searchGeoapifyMetroStations(
  stations: readonly MetroStation[],
  query: string,
): MetroStation[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [...stations];
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  return stations
    .filter((station) => {
      const normalizedName = normalizeText(station.name);
      return (
        normalizedName.includes(normalizedQuery) ||
        queryTokens.every((token) => normalizedName.includes(token))
      );
    })
    .sort((left, right) => {
      const leftName = normalizeText(left.name);
      const rightName = normalizeText(right.name);
      const leftPrefix = leftName.startsWith(normalizedQuery) ? 0 : 1;
      const rightPrefix = rightName.startsWith(normalizedQuery) ? 0 : 1;
      return leftPrefix - rightPrefix || metroStationCollator.compare(left.name, right.name);
    });
}

export async function fetchGeoapifyMetroStationDirectory(
  system: RussianMetroSystem,
  apiKey: string,
  signal?: AbortSignal,
): Promise<GeoapifyMetroStationDirectory> {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) {
    throw new SearchProviderError(
      "Серверный ключ Geoapify не настроен",
      "GEOAPIFY_NOT_CONFIGURED",
    );
  }

  const observations: MetroStationObservation[] = [];
  let completed = false;
  for (let page = 0; page < MAX_METRO_STATION_PAGES; page += 1) {
    const offset = page * METRO_STATION_PAGE_LIMIT;
    const data = await requestGeoapify(
      PLACES_ENDPOINT,
      {
        categories: METRO_STATION_CATEGORY,
        conditions: "named",
        filter: `circle:${system.center[0]},${system.center[1]},${system.searchRadiusMeters}`,
        bias: `proximity:${system.center[0]},${system.center[1]}`,
        lang: "ru",
        limit: String(METRO_STATION_PAGE_LIMIT),
        offset: String(offset),
      },
      normalizedApiKey,
      FETCH_TIMEOUT_MS,
      signal,
    );
    const features = data.features ?? [];
    for (const feature of features) {
      const observation = normalizeMetroStationObservation(feature);
      if (observation) observations.push(observation);
    }
    if (features.length < METRO_STATION_PAGE_LIMIT) {
      completed = true;
      break;
    }
  }
  if (!completed) {
    throw new SearchProviderError(
      "Geoapify вернул слишком большую выборку станций метро",
      "GEOAPIFY_RESULT_LIMIT",
    );
  }

  return {
    systemId: system.id,
    stations: dedupeMetroStations(system.id, observations),
    fetchedAt: new Date().toISOString(),
  };
}

export async function findGeoapifyMetroStations(
  system: RussianMetroSystem,
  query: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<MetroStation[]> {
  const stationQuery = safeStationName(query);
  if (!stationQuery) return [];
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) {
    throw new SearchProviderError(
      "Серверный ключ Geoapify не настроен",
      "GEOAPIFY_NOT_CONFIGURED",
    );
  }

  const data = await requestGeoapify(
    GEOCODE_ENDPOINT,
    {
      text: `метро ${stationQuery}, ${system.city}, Россия`,
      type: "amenity",
      filter: `circle:${system.center[0]},${system.center[1]},${system.searchRadiusMeters}`,
      bias: `proximity:${system.center[0]},${system.center[1]}`,
      lang: "ru",
      format: "geojson",
      limit: "20",
    },
    normalizedApiKey,
    FETCH_TIMEOUT_MS,
    signal,
  );
  const normalizedQuery = normalizeText(stationQuery);
  const candidates = (data.features ?? [])
    .map(normalizeMetroGeocodeCandidate)
    .filter((station): station is MetroGeocodeCandidate => Boolean(station))
    .filter(
      (station) =>
        distanceMeters(system.center, station.coordinates) <=
          system.searchRadiusMeters &&
        (station.normalizedName === normalizedQuery ||
          station.normalizedName.startsWith(`${normalizedQuery} `)),
    );
  const observations: MetroStationObservation[] = [];
  // Typed fallback is an exception path, not a broad directory crawl. Keep
  // Place Details bounded so one typo cannot exhaust the provider quota or SLA.
  for (const candidate of candidates.slice(0, 3)) {
    const details = await requestGeoapify(
      PLACE_DETAILS_ENDPOINT,
      { id: candidate.placeId, features: "details", lang: "ru" },
      normalizedApiKey,
      DETAILS_FETCH_TIMEOUT_MS,
      signal,
    );
    const detailFeature = details.features?.find(
      (feature) => feature.properties?.feature_type === "details",
    );
    if (!detailFeature) continue;
    const observation = normalizeMetroStationObservation(detailFeature);
    if (
      observation &&
      distanceMeters(system.center, observation.coordinates) <=
        system.searchRadiusMeters &&
      (observation.normalizedName === normalizedQuery ||
        observation.normalizedName.startsWith(`${normalizedQuery} `))
    ) {
      observations.push(observation);
    }
  }
  return dedupeMetroStations(system.id, observations);
}

export async function verifyGeoapifyMetroStationSelection(
  system: RussianMetroSystem,
  selection: {
    stationId: string;
    stationName: string;
    coordinates: [number, number];
  },
  apiKey: string,
  signal?: AbortSignal,
): Promise<MetroStation> {
  const prefix = "geoapify:";
  if (!selection.stationId.startsWith(prefix)) {
    throw new SearchProviderError(
      "Выберите станцию заново из серверного справочника",
      "METRO_STATION_MISMATCH",
    );
  }
  const placeId = selection.stationId.slice(prefix.length).trim();
  if (!placeId || placeId.length > 500) {
    throw new SearchProviderError(
      "Выбранная станция содержит некорректный ID",
      "METRO_STATION_MISMATCH",
    );
  }
  const cacheKey = `${system.id}:${placeId}`;
  const cached = verifiedMetroStations.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) {
    if (
      normalizeText(cached.station.name) === normalizeText(selection.stationName) &&
      distanceMeters(cached.station.coordinates, selection.coordinates) <= 1_500
    ) {
      return cached.station;
    }
    throw new SearchProviderError(
      "Название или координаты станции не совпадают со справочником",
      "METRO_STATION_MISMATCH",
    );
  }
  if (cached) verifiedMetroStations.delete(cacheKey);

  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) {
    throw new SearchProviderError(
      "Серверный ключ Geoapify не настроен",
      "GEOAPIFY_NOT_CONFIGURED",
    );
  }
  const details = await requestGeoapify(
    PLACE_DETAILS_ENDPOINT,
    { id: placeId, features: "details", lang: "ru" },
    normalizedApiKey,
    DETAILS_FETCH_TIMEOUT_MS,
    signal,
  );
  const detailFeature = details.features?.find(
    (feature) => feature.properties?.feature_type === "details",
  );
  const observation = detailFeature
    ? normalizeMetroStationObservation(detailFeature)
    : null;
  if (
    !observation ||
    normalizeText(observation.name) !== normalizeText(selection.stationName) ||
    distanceMeters(system.center, observation.coordinates) >
      system.searchRadiusMeters ||
    distanceMeters(observation.coordinates, selection.coordinates) > 1_500
  ) {
    throw new SearchProviderError(
      "Название или координаты станции не совпадают со справочником",
      "METRO_STATION_MISMATCH",
    );
  }
  const verifiedStation = dedupeMetroStations(system.id, [observation])[0];
  if (!verifiedStation) {
    throw new SearchProviderError(
      "Не удалось подтвердить выбранную станцию",
      "METRO_STATION_MISMATCH",
    );
  }
  // Place Details may canonicalize a valid lookup ID to another provider ID
  // for the same station/line record. Preserve the directory ID submitted by
  // the client while retaining every canonical ID returned by Geoapify.
  const station: MetroStation = {
    ...verifiedStation,
    id: selection.stationId,
    providerPlaceIds: [
      ...new Set([placeId, ...verifiedStation.providerPlaceIds]),
    ].sort(),
  };
  if (verifiedMetroStations.size >= MAX_VERIFIED_METRO_CACHE_ENTRIES) {
    const oldestKey = verifiedMetroStations.keys().next().value;
    if (typeof oldestKey === "string") verifiedMetroStations.delete(oldestKey);
  }
  verifiedMetroStations.set(cacheKey, {
    station,
    expiresAtMs: Date.now() + VERIFIED_METRO_CACHE_TTL_MS,
  });
  return station;
}

function placeAddress(properties: Record<string, unknown>): string {
  const assembled = [
      stringValue(properties.city, 120),
      stringValue(properties.street, 160),
      stringValue(properties.housenumber, 40),
    ]
      .filter(Boolean)
      .join(", ");
  return stringValue(properties.formatted, 500) ?? (assembled || "Адрес не указан");
}

function externalId(feature: GeoapifyFeature): string {
  const properties = feature.properties ?? {};
  return (
    explicitExternalId(feature) ??
    `${placeName(feature) ?? "place"}:${placeAddress(properties)}`
  );
}

function explicitExternalId(feature: GeoapifyFeature): string | null {
  return (
    stringValue(feature.properties?.place_id, 500) ??
    stringValue(feature.id, 500) ??
    null
  );
}

function organizationIdentityKey(feature: GeoapifyFeature): string | null {
  const name = normalizeText(placeName(feature) ?? "");
  const address = normalizeText(placeAddress(feature.properties ?? {}));
  if (!name || !address || address === normalizeText("Адрес не указан")) {
    return null;
  }
  return `${name}\u001f${address}`;
}

function isNearbyIdentityMatch(
  left: GeoapifyFeature,
  right: GeoapifyFeature,
): boolean {
  const leftCoordinates = featureCoordinates(left);
  const rightCoordinates = featureCoordinates(right);
  return Boolean(
    leftCoordinates &&
      rightCoordinates &&
      distanceMeters(leftCoordinates, rightCoordinates) <=
        ORGANIZATION_IDENTITY_MAX_DISTANCE_METERS,
  );
}

function candidateEvidence(
  observation: PlaceObservation,
  candidateId: string,
): CandidateEvidence {
  const properties = observation.feature.properties ?? {};
  const expansionOnly = observation.retrievalArms.every(
    (arm) => arm.type === "fallback" || arm.type === "adjacent",
  );
  return {
    candidateId,
    name: placeName(observation.feature),
    // A category obtained through the same fallback that retrieved the card is
    // not independent evidence. Text can still support it, while exact/recall
    // arms retain their observed provider categories.
    providerCategoryIds: expansionOnly ? [] : [...observation.providerCategoryIds],
    locality:
      stringValue(properties.city, 120) ??
      stringValue(properties.town, 120) ??
      stringValue(properties.village, 120) ??
      stringValue(properties.state, 120),
    sourceDescription: stringValue(properties.description, 500),
  };
}

function relevanceIntent(
  payload: SearchPayload,
  provided: SemanticIntentV2 | undefined,
): SemanticIntentV2 {
  if (provided) return provided;
  return {
    schemaVersion: "2.2",
    normalizedGoal: payload.description || payload.primaryQuery,
    entityKind: "physical_business",
    physicalLocationRequirement: "required",
    industries: [],
    coreBusinessTypes: [payload.primaryQuery],
    adjacentBusinessTypes: [...payload.relatedQueries],
    excludedBusinessTypes: [...payload.excludeQueries],
    productsAndServices: [],
    includeSignals: [payload.primaryQuery, ...payload.relatedQueries],
    excludeSignals: [...payload.excludeQueries],
    retrievalTerms: {
      precision: [payload.primaryQuery],
      recall: [...payload.relatedQueries],
      exclude: [...payload.excludeQueries],
    },
    brandSearch: "include",
    confidence: "low",
    ambiguity: {
      isAmbiguous: false,
      reason: null,
      clarificationQuestion: null,
    },
  };
}

function relevanceCounts(items: Iterable<LeadRelevance>) {
  const counts = { matched: 0, maybe: 0, rejected: 0, notChecked: 0 };
  for (const item of items) {
    if (item.status === "matched") counts.matched += 1;
    else if (item.status === "maybe") counts.maybe += 1;
    else if (item.status === "rejected") counts.rejected += 1;
    else counts.notChecked += 1;
  }
  return counts;
}

async function runRelevanceClassifier(
  classifier: NonNullable<SearchProviderOptions["relevanceClassifier"]>,
  input: RelevanceClassifierInput,
  parentSignal?: AbortSignal,
  timeoutMs = relevanceClassifierTimeoutMs(),
): Promise<unknown> {
  throwIfSearchAborted(parentSignal);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(),
    timeoutMs,
  );
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(new Error("Relevance classifier deadline exceeded")),
      { once: true },
    );
  });

  try {
    return await Promise.race([
      classifier.classify(input, controller.signal),
      aborted,
    ]);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      throwIfSearchAborted(signal);
      const currentIndex = nextIndex;
      nextIndex += 1;
      output[currentIndex] = await mapper(items[currentIndex]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return output;
}

function isFatalDetailError(error: SearchProviderError): boolean {
  return (
    error.code === "GEOAPIFY_FORBIDDEN" ||
    error.code === "GEOAPIFY_RATE_LIMIT" ||
    error.code === "SEARCH_ABORTED"
  );
}

async function enrichPlace(
  observation: PlaceObservation,
  apiKey: string,
  signal?: AbortSignal,
  timeoutMs = DETAILS_FETCH_TIMEOUT_MS,
): Promise<DetailEnrichment> {
  throwIfSearchAborted(signal);
  if (!observation.placeId) {
    return { properties: null, succeeded: false, temporaryFailure: false };
  }
  try {
    const collection = await requestGeoapify(
      PLACE_DETAILS_ENDPOINT,
      {
        id: observation.placeId,
        features: "details",
        lang: "ru",
      },
      apiKey,
      timeoutMs,
      signal,
    );
    const detailFeature = collection.features?.find(
      (feature) => feature.properties?.feature_type === "details",
    );
    return {
      properties: detailFeature?.properties ?? null,
      succeeded: Boolean(detailFeature?.properties),
      temporaryFailure: false,
      ...(detailFeature
        ? { canonicalExternalId: explicitExternalId(detailFeature) ?? undefined }
        : {}),
    };
  } catch (error) {
    if (error instanceof SearchProviderError && isFatalDetailError(error)) {
      throw error;
    }
    const temporaryFailure =
      error instanceof SearchProviderError &&
      [
        "GEOAPIFY_TIMEOUT",
        "GEOAPIFY_NETWORK_ERROR",
        "GEOAPIFY_UPSTREAM_ERROR",
      ].includes(error.code);
    return { properties: null, succeeded: false, temporaryFailure };
  }
}

function detailContact(
  details: Record<string, unknown> | null,
): Record<string, unknown> {
  return details && isRecord(details.contact) ? details.contact : {};
}

function firstContactValue(
  details: Record<string, unknown> | null,
  key: string,
): string | null {
  const contact = detailContact(details);
  const candidates = [
    contact[key],
    contact[`${key}_other`],
    details?.[key],
    details?.[`${key}_other`],
  ];
  for (const candidate of candidates) {
    const direct = stringValue(candidate, 500);
    if (direct) return direct;
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const nested = stringValue(item, 500);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function categoryLabel(categories: string[]): string {
  for (const category of categories) {
    if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  }
  const specific = categories.find((category) => category.includes("."));
  return specific
    ? specific
        .split(".")
        .at(-1)!
        .replaceAll("_", " ")
    : "Организация";
}

function scoreLead(input: {
  primaryFound: boolean;
  hasPhone: boolean;
  websiteStatus: Lead["website"]["sourceStatus"];
  detailsChecked: boolean;
  matchedQueries: number;
}) {
  const hasWebsite = input.websiteStatus === "listed";
  const websiteKnownMissing = input.websiteStatus === "not_listed";
  const opportunity = Math.min(
    100,
    35 +
      (input.hasPhone ? 20 : 0) +
      (websiteKnownMissing ? 20 : 5) +
      Math.min(15, input.matchedQueries * 5),
  );
  const hiddenness = Math.min(
    100,
    25 + (!input.primaryFound ? 40 : 0) + (websiteKnownMissing ? 20 : 0),
  );
  const confidence = Math.min(
    100,
    35 +
      (input.hasPhone ? 20 : 0) +
      (hasWebsite ? 15 : 0) +
      (input.detailsChecked ? 15 : 0),
  );
  return { opportunity, hiddenness, confidence };
}

function recommendedOffer(
  payload: SearchPayload,
  websiteStatus: Lead["website"]["sourceStatus"],
): string {
  const offer =
    payload.offer ||
    (payload.services.length
      ? `обсудить: ${payload.services.join(", ")}`
      : "предложить первичный аудит цифрового присутствия");
  if (websiteStatus !== "listed") {
    const verificationStep =
      websiteStatus === "not_checked"
        ? "Сначала получить расширенные данные и проверить наличие сайта вне Geoapify"
        : "Сначала проверить наличие сайта вне Geoapify";
    return `${verificationStep}. При подтверждении цифрового разрыва — ${offer}.`;
  }
  return payload.offer ||
    (payload.services.length
      ? `Проверить потребность: ${payload.services.join(", ")}.`
      : "Провести первичный аудит цифрового присутствия.");
}

function normalizeLead(
  observation: PlaceObservation,
  details: Record<string, unknown> | null,
  detailsChecked: boolean,
  payload: SearchPayload,
  observedAt: string,
  center: [number, number],
  relevance: LeadRelevance,
): Lead {
  const properties = observation.feature.properties ?? {};
  const categories = boundedProviderCategoryIds(
    properties.categories,
    properties.category,
  );
  const rawCoordinates = observation.feature.geometry?.coordinates;
  const coordinates: [number, number] = validCoordinates(rawCoordinates)
    ? [rawCoordinates[0], rawCoordinates[1]]
    : center;
  const phone = firstContactValue(details, "phone");
  const email = firstContactValue(details, "email");
  const website = safeHttpUrl(firstContactValue(details, "website"));
  const websiteStatus: Lead["website"]["sourceStatus"] = website
    ? "listed"
    : detailsChecked
      ? "not_listed"
      : "not_checked";
  const contact = detailContact(details);
  const telegram = socialUrl(
    contact.telegram ?? contact["contact:telegram"],
    "telegram",
  );
  const vk = socialUrl(contact.vk ?? contact["contact:vk"], "vk");
  const searchable = normalizeText(
    [
      placeName(observation.feature),
      placeAddress(properties),
      ...categories,
      ...categories.map((category) => CATEGORY_LABELS[category]).filter(Boolean),
    ]
      .filter(Boolean)
      .join(" "),
  );
  const queryTerms = [payload.primaryQuery, ...payload.relatedQueries];
  const matchedQueries = queryTerms.filter((term) => matchesQueryTerm(searchable, term));
  const primaryFound = matchesQueryTerm(searchable, payload.primaryQuery);
  const scores = scoreLead({
    primaryFound,
    hasPhone: Boolean(phone),
    websiteStatus,
    detailsChecked,
    matchedQueries: matchedQueries.length,
  });
  const digitalProblems: string[] = [];
  if (detailsChecked && !website) {
    digitalProblems.push("Сайт не указан в данных Geoapify/OSM");
  }
  if (detailsChecked && !phone) {
    digitalProblems.push("Телефон не указан в данных Geoapify/OSM");
  }
  if (!detailsChecked) {
    digitalProblems.push("Расширенные контактные данные не проверены");
  }

  return {
    id: `geoapify-${observation.externalId}`,
    name: placeName(observation.feature) ?? "Организация",
    category: categoryLabel(categories),
    tags: categories,
    location: {
      address: placeAddress(properties),
      coordinates,
    },
    phone,
    email,
    website: {
      sourceStatus: websiteStatus,
      // A URL in OSM/Geoapify has not yet been fetched or ownership-verified.
      verifiedStatus: "not_checked",
      url: website,
    },
    socials: {
      ...(telegram ? { telegram } : {}),
      ...(vk ? { vk } : {}),
    },
    digitalProblems,
    discovery: {
      matchedQueries,
      hiddenReason: primaryFound
        ? "Название или категория совпали с основным запросом"
        : "Обнаружена по категории Geoapify без точного совпадения основного запроса",
      observedAt,
      source: "geoapify",
      primaryFound,
      retrievalArms: observation.retrievalArms.map((arm) => ({
        ...arm,
        categoryIds: [...arm.categoryIds],
        provenance: arm.provenance.map((item) => ({ ...item })),
      })),
    },
    sources: observation.externalIds.map((externalId) => ({
        provider: "geoapify",
        externalId,
        observedAt,
      })),
    scores,
    status: detailsChecked && (phone || website) ? "Новый" : "Проверить",
    summary: `Карточка обнаружена через Geoapify на основе открытых данных OpenStreetMap. ${
      detailsChecked
        ? phone
          ? "Телефон указан."
          : "Телефон не указан в расширенных данных."
        : "Расширенные контактные данные не запрашивались."
    } ${
      websiteStatus === "listed"
        ? "URL сайта указан, но доступность не проверена."
        : websiteStatus === "not_listed"
          ? "URL сайта не указан после проверки источника; это не доказывает отсутствие сайта."
          : "Наличие сайта по расширенным данным не проверялось."
    }`,
    recommendedOffer: recommendedOffer(payload, websiteStatus),
    possibleBranches: [],
    relevance,
  };
}

export class GeoapifyProvider implements SearchProvider {
  readonly id = "geoapify" as const;

  constructor(private readonly apiKey: string) {
    if (!apiKey.trim()) {
      throw new SearchProviderError(
        "Серверный ключ Geoapify не настроен",
        "GEOAPIFY_NOT_CONFIGURED",
      );
    }
  }

  async search(
    payload: SearchPayload,
    options: SearchProviderOptions = {},
  ): Promise<SearchResponse> {
    const reportProgress = async (
      event: Omit<SearchProgressEvent, "type" | "timestamp">,
    ) => {
      throwIfSearchAborted(options.signal);
      await options.onProgress?.({
        type: "progress",
        ...event,
        timestamp: new Date().toISOString(),
      });
    };
    const apiKey = this.apiKey.trim();
    const observedAt = new Date().toISOString();
    const degradedStages: NonNullable<
      NonNullable<SearchResponse["provider"]["coverage"]>["degradedStages"]
    > = [];
    const markDegraded = (
      stage: (typeof degradedStages)[number]["stage"],
      reason: (typeof degradedStages)[number]["reason"],
    ) => {
      if (!degradedStages.some((item) => item.stage === stage && item.reason === reason)) {
        degradedStages.push({ stage, reason });
      }
    };
    const requiredStageTimeout = (maximumMs: number, reserveMs = 0) => {
      const timeoutMs = options.runtime?.stageTimeoutMs(maximumMs, reserveMs) ?? maximumMs;
      if (timeoutMs < 1) {
        options.runtime?.throwIfAborted();
        throw new SearchProviderError(
          "Общий лимит времени поиска исчерпан",
          "SEARCH_DEADLINE_EXCEEDED",
        );
      }
      return timeoutMs;
    };
    const compiledPlan = options.compiledPlan;
    if (compiledPlan && !compiledPlanHasReadableShape(compiledPlan)) {
      throw new SearchProviderError(
        "Скомпилированный план Geoapify имеет некорректную структуру",
        "GEOAPIFY_INVALID_COMPILED_PLAN",
      );
    }
    if (
      compiledPlan &&
      (compiledPlan.providerCatalogVersion !== GEOAPIFY_PROVIDER_CATALOG_VERSION ||
        compiledPlan.registryChecksum !== GEOAPIFY_CAPABILITY_REGISTRY.checksum)
    ) {
      throw new SearchProviderError(
        "Версия каталога Geoapify не совпадает с серверным registry",
        "GEOAPIFY_CATALOG_MISMATCH",
      );
    }
    if (
      compiledPlan &&
      [
        ...compiledPlan.categoryIds,
        ...compiledPlan.batches.flatMap((batch) => batch.categoryIds),
      ].some((categoryId) => !isGeoapifyCategoryId(categoryId))
    ) {
      throw new SearchProviderError(
        "Сервер не смог подготовить категории Geoapify",
        "GEOAPIFY_UNSUPPORTED_CATEGORY",
      );
    }
    if (compiledPlan && !compiledPlanIsCoherent(compiledPlan)) {
      throw new SearchProviderError(
        "Скомпилированный план Geoapify внутренне противоречив",
        "GEOAPIFY_INVALID_COMPILED_PLAN",
      );
    }
    const nativeCategoryResolutionRequired =
      compiledPlan?.nativeCategoryResolutionRequired === true;
    const nativeRecoveryAuthorization = nativeCategoryResolutionRequired
      ? projectGeoapifyNativeRecovery(compiledPlan)
      : null;
    if (nativeCategoryResolutionRequired && !nativeRecoveryAuthorization) {
      throw new SearchProviderError(
        "Скомпилированный план Geoapify не содержит допустимого recovery arm",
        "GEOAPIFY_INVALID_COMPILED_PLAN",
      );
    }
    let categoryPlan = compiledPlan
      ? categoryPlanFromCompiled(compiledPlan)
      : resolveGeoapifyCategories(payload);
    let categoryResolution: CategoryResolutionState = {
      status:
        process.env.GEOAPIFY_CATEGORY_HINTS_ENABLED === "true"
          ? "not_needed"
          : "disabled",
      requests: 0,
    };
    let resolvedFallbackArmId: string | null = null;
    let resolvedFallbackPlanArmId: string | null = null;
    if (
      !categoryPlan.categories.length ||
      !categoryPlan.batches.length ||
      categoryPlan.batches.some((batch) =>
        batch.categoryIds.length === 0,
      )
    ) {
      throw new SearchProviderError(
        "Сервер не смог подготовить категории Geoapify",
        "GEOAPIFY_UNSUPPORTED_CATEGORY",
      );
    }
    const countryCode = compiledPlan?.countryCode ?? "RU";
    const language = compiledPlan?.language ?? "ru";
    let center: [number, number];
    if (payload.center) {
      if (!validCoordinates(payload.center)) {
        throw new SearchProviderError(
          "Координаты центра поиска некорректны",
          "GEOAPIFY_INVALID_CENTER",
        );
      }
      await reportProgress({
        stage: "geocoding",
        status: "started",
        message: "Используем точку, выбранную на карте",
      });
      center = [payload.center[0], payload.center[1]];
      await reportProgress({
        stage: "geocoding",
        status: "completed",
        message: "Используем точку, выбранную на карте",
      });
    } else {
      const geocodingBudget = options.runtime?.beginStage(
        5_000,
        NORMALIZATION_RESERVE_MS,
      );
      await reportProgress({
        stage: "geocoding",
        status: "started",
        message: "Определяем координаты указанной географии",
      });
      center = await geocodeGeoapifyLocation(
        payload.location,
        apiKey,
        options.signal,
        countryCode,
        language,
        geocodingBudget
          ? requiredStageTimeout(geocodingBudget.timeoutMs(5_000))
          : 5_000,
      );
      await reportProgress({
        stage: "geocoding",
        status: "completed",
        message: "География поиска определена",
      });
    }
    if (nativeRecoveryAuthorization) {
      const hintTimeoutMs =
        options.runtime?.stageTimeoutMs(
          CATEGORY_HINT_TIMEOUT_MS,
          PLACES_STAGE_BUDGET_MS + NORMALIZATION_RESERVE_MS,
        ) ?? CATEGORY_HINT_TIMEOUT_MS;
      try {
        const resolved = await resolveGeoapifyNativeRecovery(
          {
            authorization: nativeRecoveryAuthorization,
            center,
            radiusMeters: payload.radiusKm * 1_000,
            countryCode,
            language,
            timeoutMs: Math.min(CATEGORY_HINT_TIMEOUT_MS, hintTimeoutMs),
            signal: options.signal,
          },
          {
            async autocomplete(request) {
              try {
                const collection = await requestGeoapify(
                  AUTOCOMPLETE_ENDPOINT,
                  {
                    text: request.text,
                    type: "amenity",
                    filter: `circle:${request.center[0]},${request.center[1]},${Math.round(
                      request.radiusMeters,
                    )}`,
                    bias: `proximity:${request.center[0]},${request.center[1]}`,
                    lang: request.language,
                    format: "geojson",
                    limit: String(request.limit),
                  },
                  apiKey,
                  request.timeoutMs,
                  request.signal,
                  MAX_CATEGORY_HINT_RESPONSE_BYTES,
                );
                const observations: GeoapifyCategoryObservation[] = (
                  collection.features ?? []
                )
                  .slice(0, request.limit)
                  .map((feature) => ({
                    categoryId: stringValue(
                      feature.properties?.category,
                      200,
                    ),
                    countryCode: stringValue(
                      feature.properties?.country_code,
                      8,
                    ),
                    coordinates: featureCoordinates(feature),
                    providerPlaceId: stringValue(
                      feature.properties?.place_id,
                      500,
                    ),
                  }));
                return { kind: "observations" as const, observations };
              } catch (error) {
                if (options.signal?.aborted) throw abortedSearchError();
                if (error instanceof SearchProviderError) {
                  return {
                    kind: "failure" as const,
                    code: nativeRecoveryFailureCode(error),
                  };
                }
                return { kind: "failure" as const, code: "network" as const };
              }
            },
          },
        );
        categoryPlan = categoryPlanFromCompiled(resolved.categoryPlan);
        resolvedFallbackArmId = resolved.armBinding.runtimeArmId;
        resolvedFallbackPlanArmId = resolved.armBinding.planArmId;
        categoryResolution = resolved.categoryResolution;
      } catch (error) {
        if (error instanceof GeoapifyNativeRecoveryError) {
          throw providerErrorForNativeRecovery(error);
        }
        throw error;
      }
    }
    if (
      compiledPlan &&
      options.semanticIntent &&
      !nativeCategoryResolutionRequired &&
      process.env.GEOAPIFY_CATEGORY_HINTS_ENABLED === "true" &&
      needsNativeCategoryResolution(compiledPlan)
    ) {
      const fallback = compiledPlan.batches.find(
        (batch) => batch.type === "fallback" && Boolean(batch.nameQuery),
      );
      const hintTimeoutMs =
        options.runtime?.stageTimeoutMs(
          CATEGORY_HINT_TIMEOUT_MS,
          PLACES_STAGE_BUDGET_MS + NORMALIZATION_RESERVE_MS,
        ) ?? CATEGORY_HINT_TIMEOUT_MS;
      if (!fallback?.nameQuery || hintTimeoutMs < MIN_CATEGORY_HINT_BUDGET_MS) {
        categoryResolution = { status: "degraded", requests: 0 };
      } else {
        try {
          categoryResolution = { status: "no_match", requests: 1 };
          const hints = await requestGeoapify(
            AUTOCOMPLETE_ENDPOINT,
            {
              text: fallback.nameQuery,
              type: "amenity",
              filter: `circle:${center[0]},${center[1]},${Math.round(
                payload.radiusKm * 1_000,
              )}`,
              bias: `proximity:${center[0]},${center[1]}`,
              lang: language,
              format: "geojson",
              limit: "5",
            },
            apiKey,
            Math.min(CATEGORY_HINT_TIMEOUT_MS, hintTimeoutMs),
            options.signal,
            MAX_CATEGORY_HINT_RESPONSE_BYTES,
          );
          const hintedCategoryIds = selectGeoapifyCategoryHints(
            hints.features ?? [],
            {
              center,
              radiusMeters: payload.radiusKm * 1_000,
              countryCode,
            },
          );
          if (hintedCategoryIds.length) {
            const refined = applyGeoapifyNativeResolution(
              compiledPlan,
              hintedCategoryIds,
            );
            const resolvedFallback = refined.batches.find(
              (batch) => batch.type === "fallback",
            );
            if (resolvedFallback && resolvedFallback.id !== fallback.id) {
              categoryPlan = categoryPlanFromCompiled(refined);
              resolvedFallbackArmId = resolvedFallback.id;
              resolvedFallbackPlanArmId = fallback.id;
              categoryResolution = { status: "resolved", requests: 1 };
            }
          }
        } catch (error) {
          if (options.signal?.aborted) throw abortedSearchError();
          if (
            error instanceof SearchProviderError &&
            error.code === "GEOAPIFY_FORBIDDEN"
          ) {
            throw error;
          }
          categoryResolution = { status: "degraded", requests: 1 };
        }
      }
    }
    const observations = new Map<string, PlaceObservation>();
    const observationIdsByIdentity = new Map<string, string[]>();
    let cardsFound = 0;
    let upstreamRequests = 0;
    const effectiveExclusions = [
      ...new Set([
        ...payload.excludeQueries,
        ...categoryPlan.exclusionTerms,
      ].map((term) => term.trim()).filter(Boolean)),
    ];

    // Retrieval arms are sequential to remain friendly to the free-plan rate
    // and are capped again here even after server-side compilation.
    const retrievalArms = categoryPlan.batches
      .slice(0, Math.min(categoryPlan.limits.maxArms, MAX_RETRIEVAL_ARMS))
      .sort((left, right) => left.priority - right.priority);
    const acceptedIntent = relevanceIntent(payload, options.semanticIntent);
    const precisionCategoryIds = [
      ...new Set(
        retrievalArms
          .filter(
            (arm) => arm.mode === "precision" && arm.type !== "fallback",
          )
          .flatMap((arm) =>
            arm.provenance
              .filter((item) => item.match !== "parent")
              .map((item) => item.categoryId),
          ),
      ),
    ];
    const broadCategoryIds = [
      ...new Set(
        retrievalArms
          .filter((arm) => arm.role === "primary")
          .flatMap((arm) =>
            arm.mode === "broad" && arm.type !== "fallback"
              ? arm.categoryIds
              : arm.provenance
                  .filter((item) => item.match === "parent")
                  .map((item) => item.categoryId),
          ),
      ),
    ];
    const matchedCandidateCount = () =>
      [...observations.values()].filter((observation, index) => {
        const relevance = classifyCandidateRelevance(
          candidateEvidence(observation, `preflight-${index + 1}`),
          {
            semanticIntent: acceptedIntent,
            precisionCategoryIds,
            broadCategoryIds,
            exclusionTerms: effectiveExclusions,
            expansionOnly: observation.retrievalArms.every(
              (arm) => arm.type === "fallback" || arm.type === "adjacent",
            ),
          },
        );
        return relevance.status === "matched";
      }).length;
    let completedRetrievalArms = 0;
    const executedRetrievalArms: SearchProviderExecutedRetrievalArm[] = [];
    await reportProgress({
      stage: "places",
      status: "started",
      message: "Ищем организации по категориям Geoapify",
      completed: 0,
      total: retrievalArms.length,
    });
    const placesBudget = options.runtime?.beginStage(
      PLACES_STAGE_BUDGET_MS,
      NORMALIZATION_RESERVE_MS,
    );
    for (const categoryBatch of retrievalArms) {
      if (
        completedRetrievalArms > 0 &&
        matchedCandidateCount() >= MIN_MATCHED_RESULTS_BEFORE_EXPANSION_STOP
      ) {
        break;
      }
      if (
        upstreamRequests >=
          Math.min(categoryPlan.limits.maxUpstreamRequests, MAX_RETRIEVAL_REQUESTS) ||
        cardsFound >= Math.min(categoryPlan.limits.maxCards, MAX_RETRIEVAL_CARDS)
      ) {
        break;
      }
      const categoryIds = categoryBatch.categoryIds;
      const remainingCards =
        Math.min(categoryPlan.limits.maxCards, MAX_RETRIEVAL_CARDS) - cardsFound;
      const requestLimit = Math.min(
        geoapifyPlacesLimit(),
        categoryBatch.resultBudget,
        remainingCards,
      );
      if (requestLimit < 1) break;
      const isNameFallback =
        categoryBatch.type === "fallback" &&
        Boolean(categoryBatch.nameQuery) &&
        categoryBatch.id !== resolvedFallbackArmId;
      const isResolvedNativeFallback =
        categoryBatch.type === "fallback" &&
        Boolean(categoryBatch.nameQuery) &&
        categoryBatch.id === resolvedFallbackArmId;
      const requestParameters: Record<string, string> = {
        filter: `circle:${center[0]},${center[1]},${Math.round(
          payload.radiusKm * 1_000,
        )}`,
        bias: `proximity:${center[0]},${center[1]}`,
        lang: language,
        limit: String(requestLimit),
      };
      if (isNameFallback) {
        // A free-text intent that does not map to a provider category must not
        // be broadened to several root categories. Geoapify's forward geocoder
        // resolves named amenities directly and returns the same GeoJSON feature
        // shape, so the common dedupe/relevance/enrichment pipeline stays intact.
        requestParameters.text = fallbackGeocodeText(
          categoryBatch.nameQuery!,
          payload.location,
        );
        requestParameters.type = "amenity";
        requestParameters.format = "geojson";
      } else {
        requestParameters.categories = categoryIds.join(",");
      }
      const placesTimeoutMs = placesBudget
        ? placesBudget.timeoutMs(PLACES_STAGE_BUDGET_MS)
        : PLACES_STAGE_BUDGET_MS;
      if (placesTimeoutMs < 1) {
        if (observations.size > 0) {
          markDegraded("places", "STAGE_BUDGET_EXHAUSTED");
          break;
        }
        requiredStageTimeout(placesTimeoutMs);
      }
      let collection: GeoapifyCollection;
      try {
        upstreamRequests += 1;
        collection = await requestGeoapify(
          isNameFallback ? GEOCODE_ENDPOINT : PLACES_ENDPOINT,
          requestParameters,
          apiKey,
          placesTimeoutMs,
          options.signal,
        );
      } catch (error) {
        const canFailSoft =
          !nativeCategoryResolutionRequired &&
          isResolvedNativeFallback &&
          error instanceof SearchProviderError &&
          [
            "GEOAPIFY_TIMEOUT",
            "GEOAPIFY_UPSTREAM_ERROR",
            "GEOAPIFY_NETWORK_ERROR",
            "GEOAPIFY_INVALID_RESPONSE",
          ].includes(error.code) &&
          upstreamRequests <
            Math.min(
              categoryPlan.limits.maxUpstreamRequests,
              MAX_RETRIEVAL_REQUESTS,
            );
        if (canFailSoft) {
          const fallbackTimeoutMs = placesBudget
            ? placesBudget.timeoutMs(PLACES_STAGE_BUDGET_MS)
            : PLACES_STAGE_BUDGET_MS;
          if (fallbackTimeoutMs >= 1) {
            upstreamRequests += 1;
            collection = await requestGeoapify(
              GEOCODE_ENDPOINT,
              {
                filter: requestParameters.filter,
                bias: requestParameters.bias,
                lang: requestParameters.lang,
                limit: requestParameters.limit,
                text: fallbackGeocodeText(
                  categoryBatch.nameQuery!,
                  payload.location,
                ),
                type: "amenity",
                format: "geojson",
              },
              apiKey,
              fallbackTimeoutMs,
              options.signal,
            );
            categoryResolution = { status: "degraded", requests: 1 };
          } else {
            throw error;
          }
        } else {
        if (
          options.runtime &&
          observations.size > 0 &&
          error instanceof SearchProviderError &&
          error.code === "GEOAPIFY_TIMEOUT"
        ) {
          markDegraded("places", "STAGE_BUDGET_EXHAUSTED");
          break;
        }
        throw error;
        }
      }
      if (
        !nativeCategoryResolutionRequired &&
        isResolvedNativeFallback &&
        !(collection.features ?? []).some(
          (feature) => placeName(feature) && isCountryPlace(feature, countryCode),
        ) &&
        upstreamRequests <
          Math.min(
            categoryPlan.limits.maxUpstreamRequests,
            MAX_RETRIEVAL_REQUESTS,
          )
      ) {
        const fallbackTimeoutMs = placesBudget
          ? placesBudget.timeoutMs(PLACES_STAGE_BUDGET_MS)
          : PLACES_STAGE_BUDGET_MS;
        if (fallbackTimeoutMs >= 1) {
          upstreamRequests += 1;
          collection = await requestGeoapify(
            GEOCODE_ENDPOINT,
            {
              filter: requestParameters.filter,
              bias: requestParameters.bias,
              lang: requestParameters.lang,
              limit: requestParameters.limit,
              text: fallbackGeocodeText(
                categoryBatch.nameQuery!,
                payload.location,
              ),
              type: "amenity",
              format: "geojson",
            },
            apiKey,
            fallbackTimeoutMs,
            options.signal,
          );
          categoryResolution = { status: "degraded", requests: 1 };
        }
      }
      const receivedFeatures = (collection.features ?? []).slice(0, requestLimit);
      cardsFound += receivedFeatures.length;
      const armObservation: LeadRetrievalArm = {
        id: categoryBatch.id,
        type: categoryBatch.type,
        role: categoryBatch.role,
        priority: categoryBatch.priority,
        categoryIds: [...categoryBatch.categoryIds],
        provenance: categoryBatch.provenance.map((item) => ({ ...item })),
      };
      for (const feature of receivedFeatures) {
        // Unnamed industrial footprints are not actionable business leads and
        // usually have no contacts; skip them before spending detail credits.
        if (
          !placeName(feature) ||
          !isCountryPlace(feature, countryCode)
        ) {
          continue;
        }
        const id = externalId(feature);
        const identityKey = organizationIdentityKey(feature);
        const existingObservationId = observations.has(id)
          ? id
          : identityKey
            ? observationIdsByIdentity
                .get(identityKey)
                ?.find((candidateId) => {
                  const candidate = observations.get(candidateId);
                  return Boolean(
                    candidate &&
                      isNearbyIdentityMatch(candidate.feature, feature),
                  );
                })
            : undefined;
        const existing = existingObservationId
          ? observations.get(existingObservationId)
          : undefined;
        if (!existing) {
          observations.set(id, {
            feature,
            externalId: id,
            externalIds: [id],
            placeId: stringValue(feature.properties?.place_id, 500),
            providerCategoryIds: boundedProviderCategoryIds(
              feature.properties?.categories,
              feature.properties?.category,
            ),
            retrievalArms: [armObservation],
          });
          if (identityKey) {
            const identityIds = observationIdsByIdentity.get(identityKey) ?? [];
            identityIds.push(id);
            observationIdsByIdentity.set(identityKey, identityIds);
          }
        } else {
          if (!existing.externalIds.includes(id)) {
            existing.externalIds.push(id);
          }
          if (!existing.placeId) {
            existing.placeId = stringValue(feature.properties?.place_id, 500);
          }
          for (const categoryId of boundedProviderCategoryIds(
            feature.properties?.categories,
            feature.properties?.category,
          )) {
            if (!existing.providerCategoryIds.includes(categoryId)) {
              existing.providerCategoryIds.push(categoryId);
              if (
                existing.providerCategoryIds.length >=
                MAX_CANDIDATE_CATEGORY_IDS
              ) break;
            }
          }
          if (!existing.retrievalArms.some((arm) => arm.id === armObservation.id)) {
            existing.retrievalArms.push(armObservation);
            existing.retrievalArms.sort((left, right) => left.priority - right.priority);
          }
        }
      }
      executedRetrievalArms.push({
        id: categoryBatch.id,
        planArmId:
          categoryBatch.id === resolvedFallbackArmId
            ? (resolvedFallbackPlanArmId ?? categoryBatch.id)
            : categoryBatch.id,
        type: categoryBatch.type,
        role: categoryBatch.role,
      });
      completedRetrievalArms += 1;
      await reportProgress({
        stage: "places",
        status: "running",
        message: `Получено карточек: ${cardsFound}`,
        completed: completedRetrievalArms,
        total: retrievalArms.length,
      });
    }

    await reportProgress({
      stage: "places",
      status: "completed",
      message: `Поиск организаций завершён: ${observations.size}`,
      completed: completedRetrievalArms,
      total: retrievalArms.length,
    });

    const namedPlaces = [...observations.values()];
    await reportProgress({
      stage: "relevance_classification",
      status: "started",
      message: "Проверяем соответствие карточек исходной задаче",
      completed: 0,
      total: namedPlaces.length,
    });
    const evidenceById = new Map<string, CandidateEvidence>();
    const externalIdByCandidateId = new Map<string, string>();
    const relevanceById = new Map<string, LeadRelevance>();
    for (const [index, observation] of namedPlaces.entries()) {
      const evidence = candidateEvidence(
        observation,
        `candidate-${String(index + 1).padStart(4, "0")}`,
      );
      evidenceById.set(observation.externalId, evidence);
      externalIdByCandidateId.set(evidence.candidateId, observation.externalId);
      relevanceById.set(
        observation.externalId,
        classifyCandidateRelevance(evidence, {
          semanticIntent: acceptedIntent,
          precisionCategoryIds,
          broadCategoryIds,
          exclusionTerms: effectiveExclusions,
          expansionOnly: observation.retrievalArms.every(
            (arm) => arm.type === "fallback" || arm.type === "adjacent",
          ),
        }),
      );
    }

    let classifierState: "disabled" | "completed" | "degraded" = "disabled";
    if (process.env.KIMI_LEAD_CLASSIFICATION_ENABLED === "true") {
      const candidates = namedPlaces
        .filter(
          (observation) =>
            relevanceById.get(observation.externalId)?.status === "maybe",
        )
        .slice(0, MAX_RELEVANCE_CLASSIFIER_CANDIDATES)
        .map((observation) => evidenceById.get(observation.externalId)!)
        .filter(Boolean);
      if (candidates.length) {
        if (options.relevanceClassifier) {
          const classifierBudget = options.runtime?.beginStage(
            relevanceClassifierTimeoutMs(),
            NORMALIZATION_RESERVE_MS,
          );
          const classifierTimeoutMs = classifierBudget?.timeoutMs(
            relevanceClassifierTimeoutMs(),
          ) ?? relevanceClassifierTimeoutMs();
          if (
            options.runtime &&
            classifierTimeoutMs < MIN_OPTIONAL_STAGE_BUDGET_MS
          ) {
            for (const evidence of candidates) {
              relevanceById.set(
                externalIdByCandidateId.get(evidence.candidateId)!,
                notCheckedRelevance(
                  evidence.candidateId,
                  "OPTIONAL_CLASSIFIER_UNAVAILABLE",
                ),
              );
            }
            classifierState = "degraded";
            markDegraded(
              "relevance_classification",
              "INSUFFICIENT_REMAINING_BUDGET",
            );
          } else try {
            const raw = await runRelevanceClassifier(
              options.relevanceClassifier,
              { semanticIntent: acceptedIntent, candidates },
              options.signal,
              classifierTimeoutMs,
            );
            if (!Array.isArray(raw) || raw.length !== candidates.length) {
              throw new Error("Classifier result count is invalid");
            }
            const allowedCandidateIds = new Set(
              candidates.map((candidate) => candidate.candidateId),
            );
            const byCandidateId = new Map<string, Record<string, unknown>>();
            for (const item of raw) {
              if (
                !item ||
                typeof item !== "object" ||
                Array.isArray(item) ||
                typeof (item as { candidateId?: unknown }).candidateId !==
                  "string"
              ) {
                throw new Error("Classifier result item is invalid");
              }
              const candidateId = String(
                (item as { candidateId: string }).candidateId,
              );
              if (
                !allowedCandidateIds.has(candidateId) ||
                byCandidateId.has(candidateId)
              ) {
                throw new Error("Classifier returned an unknown or duplicate ID");
              }
              byCandidateId.set(candidateId, item as Record<string, unknown>);
            }
            let invalid = false;
            for (const evidence of candidates) {
              const checked = validateCandidateRelevance(
                evidence,
                byCandidateId.get(evidence.candidateId),
              );
              if (checked.status === "not_checked") invalid = true;
              relevanceById.set(
                externalIdByCandidateId.get(evidence.candidateId)!,
                checked,
              );
            }
            classifierState = invalid ? "degraded" : "completed";
          } catch {
            if (options.signal?.aborted) throw abortedSearchError();
            for (const evidence of candidates) {
              relevanceById.set(
                externalIdByCandidateId.get(evidence.candidateId)!,
                notCheckedRelevance(
                  evidence.candidateId,
                  "OPTIONAL_CLASSIFIER_UNAVAILABLE",
                ),
              );
            }
            classifierState = "degraded";
          }
        } else {
          for (const evidence of candidates) {
            relevanceById.set(
              externalIdByCandidateId.get(evidence.candidateId)!,
              notCheckedRelevance(
                evidence.candidateId,
                "OPTIONAL_CLASSIFIER_NOT_CONFIGURED",
              ),
            );
          }
          classifierState = "degraded";
        }
      } else {
        classifierState = "completed";
      }
    }
    const classifiedCounts = relevanceCounts(relevanceById.values());
    await reportProgress({
      stage: "relevance_classification",
      status: "completed",
      message: `Релевантность проверена: ${classifiedCounts.matched} точных, ${classifiedCounts.maybe} возможных`,
      completed: namedPlaces.length,
      total: namedPlaces.length,
    });

    const plannedDetailTargets = namedPlaces
      .filter(
        (observation) =>
          observation.placeId &&
          ["matched", "maybe"].includes(
            relevanceById.get(observation.externalId)?.status ?? "not_checked",
          ),
      )
      .slice(
        0,
        Math.min(
          geoapifyDetailsLimit(),
          categoryPlan.limits.maxDetails,
          MAX_DETAILS_LIMIT,
        ),
      );
    const detailsBudget = options.runtime?.beginStage(
      DETAILS_STAGE_BUDGET_MS,
      NORMALIZATION_RESERVE_MS,
    );
    const detailStageTimeoutMs = detailsBudget?.timeoutMs(
      DETAILS_FETCH_TIMEOUT_MS,
    ) ?? DETAILS_FETCH_TIMEOUT_MS;
    const skipDetailsForBudget =
      Boolean(options.runtime) &&
      plannedDetailTargets.length > 0 &&
      detailStageTimeoutMs < MIN_OPTIONAL_STAGE_BUDGET_MS;
    if (skipDetailsForBudget) {
      markDegraded("details", "INSUFFICIENT_REMAINING_BUDGET");
    }
    const detailTargets = skipDetailsForBudget ? [] : plannedDetailTargets;
    let detailCircuitOpen = false;
    let detailsRequested = 0;
    let detailsCompleted = 0;
    await reportProgress({
      stage: "details",
      status: "started",
      message: detailTargets.length
        ? "Получаем контакты и сайты организаций"
        : "Расширенные карточки не запрашиваются",
      completed: 0,
      total: detailTargets.length,
    });
    const detailResults = await mapConcurrent(
      detailTargets,
      DETAILS_CONCURRENCY,
      async (observation) => {
        let enrichment: DetailEnrichment;
        if (detailCircuitOpen) {
          enrichment = {
            properties: null,
            succeeded: false,
            temporaryFailure: true,
          };
        } else {
          const detailCallTimeoutMs = detailsBudget?.timeoutMs(
            DETAILS_FETCH_TIMEOUT_MS,
          ) ?? DETAILS_FETCH_TIMEOUT_MS;
          if (detailCallTimeoutMs < MIN_OPTIONAL_STAGE_BUDGET_MS) {
            markDegraded("details", "STAGE_BUDGET_EXHAUSTED");
            detailCircuitOpen = true;
            enrichment = {
              properties: null,
              succeeded: false,
              temporaryFailure: true,
            };
          } else {
            detailsRequested += 1;
            enrichment = await enrichPlace(
              observation,
              apiKey,
              options.signal,
              detailCallTimeoutMs,
            );
            if (enrichment.temporaryFailure) {
              detailCircuitOpen = true;
              if (
                detailsBudget &&
                detailsBudget.remainingMs() < MIN_OPTIONAL_STAGE_BUDGET_MS
              ) {
                markDegraded("details", "STAGE_BUDGET_EXHAUSTED");
              }
            }
          }
        }
        detailsCompleted += 1;
        await reportProgress({
          stage: "details",
          status: "running",
          message: `Обработано расширенных карточек: ${detailsCompleted} из ${detailTargets.length}`,
          completed: detailsCompleted,
          total: detailTargets.length,
        });
        return enrichment;
      },
      options.signal,
    );
    await reportProgress({
      stage: "details",
      status: "completed",
      message: `Расширенные карточки обработаны: ${detailsCompleted} из ${detailTargets.length}`,
      completed: detailsCompleted,
      total: detailTargets.length,
    });
    const detailsById = new Map<string, DetailEnrichment>();
    detailTargets.forEach((observation, index) => {
      const enrichment = detailResults[index];
      detailsById.set(observation.externalId, enrichment);
      if (
        enrichment.canonicalExternalId &&
        !observation.externalIds.includes(enrichment.canonicalExternalId)
      ) {
        observation.externalIds.push(enrichment.canonicalExternalId);
      }
    });
    const detailsSucceeded = detailResults.filter((result) => result.succeeded).length;

    await reportProgress({
      stage: "normalizing",
      status: "started",
      message: "Структурируем, оцениваем и сортируем лиды",
    });
    const leads = namedPlaces.map((observation) => {
      const enrichment = detailsById.get(observation.externalId);
      return normalizeLead(
        observation,
        enrichment?.properties ?? null,
        enrichment?.succeeded ?? false,
        payload,
        observedAt,
        center,
        relevanceById.get(observation.externalId) ??
          notCheckedRelevance(observation.externalId),
      );
    });
    const relevancePriority: Record<LeadRelevance["status"], number> = {
      matched: 0,
      maybe: 1,
      not_checked: 2,
      rejected: 3,
    };
    const textEvidenceCount = (lead: Lead) =>
      lead.relevance?.evidence.filter(
        (fact) => fact.field === "name" || fact.field === "sourceDescription",
      ).length ?? 0;
    const corroboratingArmCount = (lead: Lead) =>
      new Set(
        (lead.discovery.retrievalArms ?? [])
          .filter((arm) => arm.type !== "adjacent")
          .map((arm) => arm.id),
      ).size;
    const retrievalTier = (lead: Lead) => {
      const tier: Record<LeadRetrievalArm["type"], number> = {
        precision: 0,
        legacy: 0,
        recall: 1,
        fallback: 2,
        adjacent: 3,
      };
      return Math.min(
        ...(lead.discovery.retrievalArms ?? []).map((arm) => tier[arm.type]),
      );
    };
    leads.sort(
      (left, right) =>
        relevancePriority[left.relevance?.status ?? "not_checked"] -
          relevancePriority[right.relevance?.status ?? "not_checked"] ||
        corroboratingArmCount(right) - corroboratingArmCount(left) ||
        retrievalTier(left) - retrievalTier(right) ||
        textEvidenceCount(right) - textEvidenceCount(left) ||
        (right.relevance?.confidence ?? -1) -
          (left.relevance?.confidence ?? -1) ||
        right.scores.opportunity - left.scores.opportunity,
    );
    const foundByPrimary = leads.filter((lead) => lead.discovery.primaryFound).length;
    const foundOnlyExpanded = leads.length - foundByPrimary;
    const generatedAt = new Date().toISOString();

    await reportProgress({
      stage: "normalizing",
      status: "completed",
      message: `Подготовлено лидов: ${leads.length}`,
    });

    const response: SearchResponse = {
      mode: "geoapify",
      provider: {
        id: "geoapify",
        label: "Geoapify Places API",
        queriedAt: observedAt,
        policy: {
          persistence: "allowed_with_attribution",
          attributionRequired: true,
          attribution: ["Geoapify", "OpenStreetMap contributors"],
          rawResponsesStored: false,
        },
        coverage: {
          categories: categoryPlan.categories,
          categoryResolution,
          retrievalArms: retrievalArms.length,
          completedRetrievalArms,
          executedRetrievalArms,
          upstreamRequests,
          cardsAccepted: observations.size,
          detailsRequested,
          detailsSucceeded,
          ...(degradedStages.length
            ? { degradedStages: degradedStages.map((stage) => ({ ...stage })) }
            : {}),
          relevance: {
            classifier: classifierState,
            ...classifiedCounts,
          },
        },
      },
      query: payload,
      summary: {
        cardsFound,
        uniqueLocations: leads.length,
        assumedBusinesses: leads.length,
        foundByPrimary,
        foundOnlyExpanded,
        digitalGapCandidates: leads.filter(
          (lead) => lead.website.sourceStatus === "not_listed",
        ).length,
        manualReviewCandidates: leads.filter(
          (lead) =>
            lead.scores.confidence < 70 ||
            lead.website.sourceStatus === "not_listed" ||
            lead.relevance?.status !== "matched",
        ).length,
        relevance: { ...classifiedCounts },
      },
      leads,
      notice: `Обнаруженная выборка Geoapify/OSM, а не полный реестр рынка. Именованных организаций: ${leads.length}; расширенные контакты получены для ${detailsSucceeded} из ${detailsRequested} фактически запрошенных карточек. Требуется атрибуция Geoapify и OpenStreetMap contributors.`,
      generatedAt,
    };
    await reportProgress({
      stage: "complete",
      status: "completed",
      message: `Поиск завершён: ${leads.length} лидов`,
    });
    return response;
  }
}
