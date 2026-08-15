import type { Lead, SearchPayload, SearchResponse } from "../types";
import { SearchProviderError, type SearchProvider } from "./types";

const GEOCODE_ENDPOINT = "https://api.geoapify.com/v1/geocode/search";
const PLACES_ENDPOINT = "https://api.geoapify.com/v2/places";
const PLACE_DETAILS_ENDPOINT = "https://api.geoapify.com/v2/place-details";
const FETCH_TIMEOUT_MS = 15_000;
const DETAILS_FETCH_TIMEOUT_MS = 8_000;
const MIN_REQUEST_INTERVAL_MS = 225;

const DEFAULT_PLACES_LIMIT = 100;
const MAX_PLACES_LIMIT = 500;
const DEFAULT_DETAILS_LIMIT = 20;
const MAX_DETAILS_LIMIT = 50;
const DETAILS_CONCURRENCY = 3;
let nextGeoapifyRequestAt = 0;

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

type CategoryPlan = {
  categories: string[];
  batches: string[][];
};

type PlaceObservation = {
  feature: GeoapifyFeature;
  externalId: string;
  placeId: string | null;
};

type DetailEnrichment = {
  properties: Record<string, unknown> | null;
  succeeded: boolean;
  temporaryFailure: boolean;
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
  return { categories: all, batches: [all] };
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

async function requestGeoapify(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<GeoapifyCollection> {
  const now = Date.now();
  const requestAt = Math.max(now, nextGeoapifyRequestAt);
  nextGeoapifyRequestAt = requestAt + MIN_REQUEST_INTERVAL_MS;
  if (requestAt > now) {
    await new Promise<void>((resolve) => setTimeout(resolve, requestAt - now));
  }
  const query = new URLSearchParams(params);
  query.set("apiKey", apiKey);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
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
      const data: unknown = await response.json();
      if (!isRecord(data)) {
        throw new SearchProviderError(
          "Geoapify вернул ответ неизвестного формата",
          "GEOAPIFY_INVALID_RESPONSE",
        );
      }
      const features = data.features;
      if (features !== undefined && !Array.isArray(features)) {
        throw new SearchProviderError(
          "Geoapify вернул ответ неизвестного формата",
          "GEOAPIFY_INVALID_RESPONSE",
        );
      }
      return data as GeoapifyCollection;
    } catch (error) {
      if (error instanceof SearchProviderError) throw error;
      throw new SearchProviderError(
        "Не удалось прочитать ответ Geoapify",
        "GEOAPIFY_INVALID_RESPONSE",
      );
    }
  } catch (error) {
    if (error instanceof SearchProviderError) throw error;
    if (controller.signal.aborted) {
      throw new SearchProviderError(
        `Geoapify не ответил за ${Math.ceil(timeoutMs / 1_000)} секунд`,
        "GEOAPIFY_TIMEOUT",
      );
    }
    // Native fetch errors may include the full request URL and API key. Never
    // forward their messages to callers or logs.
    throw new SearchProviderError(
      "Не удалось подключиться к Geoapify",
      "GEOAPIFY_NETWORK_ERROR",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCenter(
  location: string,
  apiKey: string,
): Promise<[number, number]> {
  const data = await requestGeoapify(
    GEOCODE_ENDPOINT,
    {
      text: location,
      lang: "ru",
      filter: "countrycode:ru",
      format: "geojson",
      limit: "1",
    },
    apiKey,
  );
  const feature = data.features?.[0];
  const geometryCoordinates = feature?.geometry?.coordinates;
  if (validCoordinates(geometryCoordinates)) {
    return [geometryCoordinates[0], geometryCoordinates[1]];
  }
  const lon = feature?.properties?.lon;
  const lat = feature?.properties?.lat;
  if (validCoordinates([lon, lat])) {
    return [lon, lat];
  }
  throw new SearchProviderError(
    "Не удалось определить указанную географию в России",
    "GEOAPIFY_LOCATION_NOT_FOUND",
  );
}

function placeName(feature: GeoapifyFeature): string | null {
  return stringValue(feature.properties?.name, 300);
}

function isRussianPlace(feature: GeoapifyFeature): boolean {
  const countryCode = stringValue(feature.properties?.country_code, 8);
  // Old or community-authored OSM objects may omit the country code. The
  // circle still guarantees geographic proximity, so only reject an explicit
  // non-Russian country marker.
  return !countryCode || countryCode.toLocaleLowerCase("en-US") === "ru";
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
    stringValue(properties.place_id, 500) ??
    stringValue(feature.id, 500) ??
    `${placeName(feature) ?? "place"}:${placeAddress(properties)}`
  );
}

function isExcluded(feature: GeoapifyFeature, exclusions: string[]): boolean {
  if (!exclusions.length) return false;
  const properties = feature.properties ?? {};
  const searchable = normalizeText(
    [
      placeName(feature),
      placeAddress(properties),
      ...stringArray(properties.categories),
    ]
      .filter(Boolean)
      .join(" "),
  );
  return exclusions.some((item) => containsTerm(searchable, item));
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
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
    error.code === "GEOAPIFY_RATE_LIMIT"
  );
}

async function enrichPlace(
  observation: PlaceObservation,
  apiKey: string,
): Promise<DetailEnrichment> {
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
      DETAILS_FETCH_TIMEOUT_MS,
    );
    const detailFeature = collection.features?.find(
      (feature) => feature.properties?.feature_type === "details",
    );
    return {
      properties: detailFeature?.properties ?? null,
      succeeded: Boolean(detailFeature?.properties),
      temporaryFailure: false,
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
): Lead {
  const properties = observation.feature.properties ?? {};
  const categories = stringArray(properties.categories);
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
    },
    sources: [
      {
        provider: "geoapify",
        externalId: observation.externalId,
        observedAt,
      },
    ],
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

  async search(payload: SearchPayload): Promise<SearchResponse> {
    const apiKey = this.apiKey.trim();
    const observedAt = new Date().toISOString();
    const categoryPlan = resolveGeoapifyCategories(payload);
    const center = await resolveCenter(payload.location, apiKey);
    const observations = new Map<string, PlaceObservation>();
    let cardsFound = 0;

    // Category batches are sequential to remain friendly to the free-plan
    // request rate. The current MVP has one batch; the shape is future-ready.
    for (const categoryBatch of categoryPlan.batches) {
      const collection = await requestGeoapify(
        PLACES_ENDPOINT,
        {
          categories: categoryBatch.join(","),
          filter: `circle:${center[0]},${center[1]},${Math.round(
            payload.radiusKm * 1_000,
          )}`,
          bias: `proximity:${center[0]},${center[1]}`,
          lang: "ru",
          limit: String(geoapifyPlacesLimit()),
        },
        apiKey,
      );
      cardsFound += collection.features?.length ?? 0;
      for (const feature of collection.features ?? []) {
        // Unnamed industrial footprints are not actionable business leads and
        // usually have no contacts; skip them before spending detail credits.
        if (
          !placeName(feature) ||
          !isRussianPlace(feature) ||
          isExcluded(feature, payload.excludeQueries)
        ) {
          continue;
        }
        const id = externalId(feature);
        if (!observations.has(id)) {
          observations.set(id, {
            feature,
            externalId: id,
            placeId: stringValue(feature.properties?.place_id, 500),
          });
        }
      }
    }

    const namedPlaces = [...observations.values()];
    const detailTargets = namedPlaces
      .filter((observation) => observation.placeId)
      .slice(0, geoapifyDetailsLimit());
    let detailCircuitOpen = false;
    let detailsRequested = 0;
    const detailResults = await mapConcurrent(
      detailTargets,
      DETAILS_CONCURRENCY,
      async (observation) => {
        if (detailCircuitOpen) {
          return { properties: null, succeeded: false, temporaryFailure: true };
        }
        detailsRequested += 1;
        const enrichment = await enrichPlace(observation, apiKey);
        if (enrichment.temporaryFailure) detailCircuitOpen = true;
        return enrichment;
      },
    );
    const detailsById = new Map<string, DetailEnrichment>();
    detailTargets.forEach((observation, index) => {
      detailsById.set(observation.externalId, detailResults[index]);
    });
    const detailsSucceeded = detailResults.filter((result) => result.succeeded).length;

    const leads = namedPlaces.map((observation) => {
      const enrichment = detailsById.get(observation.externalId);
      return normalizeLead(
        observation,
        enrichment?.properties ?? null,
        enrichment?.succeeded ?? false,
        payload,
        observedAt,
        center,
      );
    });
    leads.sort((left, right) => right.scores.opportunity - left.scores.opportunity);
    const foundByPrimary = leads.filter((lead) => lead.discovery.primaryFound).length;
    const foundOnlyExpanded = leads.length - foundByPrimary;
    const generatedAt = new Date().toISOString();

    return {
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
          detailsRequested,
          detailsSucceeded,
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
            lead.website.sourceStatus === "not_listed",
        ).length,
      },
      leads,
      notice: `Обнаруженная выборка Geoapify/OSM, а не полный реестр рынка. Именованных организаций: ${leads.length}; расширенные контакты получены для ${detailsSucceeded} из ${detailsRequested} фактически запрошенных карточек. Требуется атрибуция Geoapify и OpenStreetMap contributors.`,
      generatedAt,
    };
  }
}
