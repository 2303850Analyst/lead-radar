import { createDemoResponse } from "@/lib/demo-data";
import {
  GeoapifyProvider,
  geoapifyDetailsLimit,
  geoapifyPlacesLimit,
  verifyGeoapifyMetroStationSelection,
} from "@/lib/providers/geoapify";
import {
  SearchProviderError,
  type CompiledGeoapifyPlan,
  type SearchProgressCallback,
} from "@/lib/providers/types";
import {
  compileGeoapifySemanticIntent,
  compileGeoapifySelectors,
  GEOAPIFY_CAPABILITY_REGISTRY,
  GEOAPIFY_RETRIEVAL_LIMITS,
} from "@/lib/search-planner/catalogs/geoapify";
import { canonicalJson, type CanonicalJsonValue } from "@/lib/search-planner/hashing";
import { projectGeoapifyNativeRecovery } from "@/lib/geoapify-native-recovery";
import { ConfirmationTokenError } from "@/lib/search-planner/confirmation-token";
import {
  confirmSearchPlan,
  createSearchPlanFromEnv,
  isSearchPlannerInfrastructureFailure,
  plannerModeFromEnv,
  searchPlannerRuntimeMetrics,
} from "@/lib/search-planner/planner";
import { validateKimiSemanticIntent } from "@/lib/search-planner/schema";
import { notCheckedRelevance } from "@/lib/search-planner/relevance";
import type {
  ConfirmedSemanticAlternative,
  SearchPlan,
} from "@/lib/search-planner/types";
import type {
  Lead,
  SearchLocationMode,
  SearchMetroSelection,
  SearchPayload,
  SearchProgressEvent,
  SearchResponse,
} from "@/lib/types";
import {
  RUSSIAN_METRO_SYSTEMS,
  getRussianMetroSystem,
  isRussianMetroSystemId,
} from "@/lib/metro";
import {
  SUPPORTED_COUNTRY_CODES,
  SUPPORTED_LOCALES,
  type SupportedCountryCode,
  type SupportedLocale,
} from "@/lib/search-planner/types";
import {
  SearchPlanOutcomeError,
  createSearchOrchestrator,
} from "@/lib/search-orchestrator";
import {
  SearchRuntimeError,
  createProgressHeartbeat,
  createSearchRuntime,
  searchDeadlineMsFromEnv,
} from "@/lib/search-runtime";
import packageMetadata from "@/package.json";

const YANDEX_ENDPOINT = "https://search-maps.yandex.ru/v1/";
const MAX_QUERY_TERMS = 8;
const FETCH_TIMEOUT_MS = 15_000;

function requiresGeoapifyNativeRecovery(plan: SearchPlan): boolean {
  return (
    plan.resolution.reasonCodes.includes("SEMANTIC_MATCH") &&
    plan.resolution.reasonCodes.includes("PROVIDER_COVERAGE_GAP")
  );
}

function selectedProvider(): "demo" | "geoapify" | "yandex" {
  const configuredName = process.env.SEARCH_PROVIDER?.trim().toLocaleLowerCase("en-US");
  const geoapifyConfigured = Boolean(process.env.GEOAPIFY_API_KEY?.trim());
  const yandexConfigured =
    Boolean(process.env.YANDEX_MAPS_API_KEY?.trim()) &&
    process.env.YANDEX_LIVE_UI_ENABLED === "true";

  if (configuredName === "geoapify") {
    return geoapifyConfigured ? "geoapify" : "demo";
  }
  if (configuredName === "yandex") {
    return yandexConfigured ? "yandex" : "demo";
  }
  // Preserve the legacy Yandex opt-in only when no provider was selected.
  if (!configuredName && yandexConfigured) return "yandex";
  return "demo";
}

type PayloadResult =
  | { ok: true; payload: SearchPayload }
  | { ok: false; error: string };

const SEARCH_LOCATION_MODES: SearchLocationMode[] = [
  "city",
  "district",
  "radius",
  "metro",
  "region",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(
  value: unknown,
  fieldName: string,
  maxItems = 20,
): { value?: string[]; error?: string } {
  if (value === undefined) return { value: [] };
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return { error: `Поле «${fieldName}» должно быть массивом строк` };
  }
  const normalized = [...new Set(value.map((item) => item.trim()).filter(Boolean))];
  if (normalized.length > maxItems) {
    return { error: `Поле «${fieldName}» содержит слишком много значений` };
  }
  if (normalized.some((item) => item.length > 160)) {
    return { error: `Значения поля «${fieldName}» не должны превышать 160 символов` };
  }
  return { value: normalized };
}

function searchCenter(
  value: unknown,
): { value?: [number, number]; error?: string } {
  if (value === undefined) return {};
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "number" ||
    !Number.isFinite(value[0]) ||
    value[0] < -180 ||
    value[0] > 180 ||
    typeof value[1] !== "number" ||
    !Number.isFinite(value[1]) ||
    value[1] < -90 ||
    value[1] > 90
  ) {
    return {
      error:
        "Поле «center» должно содержать [долгота, широта] в допустимом диапазоне",
    };
  }
  return { value: [value[0], value[1]] };
}

function parseSearchPayload(value: unknown): PayloadResult {
  if (!isRecord(value)) return { ok: false, error: "Тело запроса должно быть объектом" };

  const primaryQuery =
    typeof value.primaryQuery === "string" ? value.primaryQuery.trim() : "";
  const center = searchCenter(value.center);
  if (center.error) return { ok: false, error: center.error };
  const locationInput = typeof value.location === "string" ? value.location.trim() : "";
  const location = locationInput || (center.value ? "Точка на карте" : "");
  if (!primaryQuery) return { ok: false, error: "Укажите основной поисковый запрос" };
  if (!location) return { ok: false, error: "Укажите город, район или адрес центра поиска" };
  if (primaryQuery.length > 200 || location.length > 300) {
    return { ok: false, error: "Поисковый запрос или география слишком длинные" };
  }

  const relatedQueries = stringList(value.relatedQueries, "relatedQueries");
  const excludeQueries = stringList(value.excludeQueries, "excludeQueries");
  const services = stringList(value.services, "services");
  const confirmedConceptIds = stringList(
    value.confirmedConceptIds,
    "confirmedConceptIds",
    3,
  );
  const listError =
    relatedQueries.error ??
    excludeQueries.error ??
    services.error ??
    confirmedConceptIds.error;
  if (listError) return { ok: false, error: listError };

  const localeInput = value.locale === undefined ? "ru-RU" : value.locale;
  if (
    typeof localeInput !== "string" ||
    !SUPPORTED_LOCALES.includes(localeInput as SupportedLocale)
  ) {
    return { ok: false, error: "Поле «locale» содержит неподдерживаемую локаль" };
  }
  const locale = localeInput as SupportedLocale;

  const countryCodesInput = value.countryCodes === undefined
    ? ["RU"]
    : value.countryCodes;
  if (
    !Array.isArray(countryCodesInput) ||
    countryCodesInput.length !== 1 ||
    typeof countryCodesInput[0] !== "string" ||
    !SUPPORTED_COUNTRY_CODES.includes(
      countryCodesInput[0] as SupportedCountryCode,
    )
  ) {
    return {
      ok: false,
      error: "В версии 0.4 поддерживается поиск ровно в одной стране: RU, BY или KZ",
    };
  }
  const countryCodes = [countryCodesInput[0] as SupportedCountryCode];
  const expectedCountryByLocale: Record<SupportedLocale, SupportedCountryCode> = {
    "ru-RU": "RU",
    "ru-BY": "BY",
    "be-BY": "BY",
    "ru-KZ": "KZ",
    "kk-KZ": "KZ",
  };
  if (countryCodes[0] !== expectedCountryByLocale[locale]) {
    return {
      ok: false,
      error: `Локаль ${locale} несовместима со страной ${countryCodes[0]}`,
    };
  }

  const confirmationToken =
    typeof value.confirmationToken === "string"
      ? value.confirmationToken.trim()
      : undefined;
  if (confirmationToken && confirmationToken.length > 8_192) {
    return { ok: false, error: "Токен подтверждения слишком длинный" };
  }
  let confirmedAlternative: ConfirmedSemanticAlternative | undefined;
  if (value.confirmedAlternative !== undefined) {
    if (!isRecord(value.confirmedAlternative)) {
      return { ok: false, error: "Подтверждённая трактовка имеет неверный формат" };
    }
    const alternativeId = value.confirmedAlternative.alternativeId;
    const alternativeHash = value.confirmedAlternative.alternativeHash;
    if (
      typeof alternativeId !== "string" ||
      !/^alt-[a-f0-9]{16}$/.test(alternativeId) ||
      typeof alternativeHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(alternativeHash)
    ) {
      return { ok: false, error: "Подтверждённая трактовка содержит неверный ID" };
    }
    try {
      confirmedAlternative = {
        alternativeId,
        alternativeHash,
        semanticIntent: validateKimiSemanticIntent(
          value.confirmedAlternative.semanticIntent,
        ),
      };
    } catch {
      return { ok: false, error: "Подтверждённая трактовка не прошла проверку" };
    }
  }
  if (
    ((confirmedConceptIds.value?.length ?? 0) > 0 || confirmedAlternative) &&
    !confirmationToken
  ) {
    return {
      ok: false,
      error: "Для подтверждённой трактовки нужен confirmationToken",
    };
  }
  if (confirmedAlternative && (confirmedConceptIds.value?.length ?? 0) > 0) {
    return {
      ok: false,
      error: "Нельзя одновременно подтверждать V1-категорию и V2-трактовку",
    };
  }

  const radiusKm = value.radiusKm === undefined ? 15 : value.radiusKm;
  if (
    typeof radiusKm !== "number" ||
    !Number.isFinite(radiusKm) ||
    radiusKm < 0.5 ||
    radiusKm > 250
  ) {
    return { ok: false, error: "Радиус должен быть числом от 0,5 до 250 км" };
  }

  const description =
    typeof value.description === "string" && value.description.trim()
      ? value.description.trim()
      : primaryQuery;
  if (description.length > 1_000) {
    return { ok: false, error: "Описание не должно превышать 1000 символов" };
  }

  const offer = typeof value.offer === "string" ? value.offer.trim() : undefined;
  if (offer && offer.length > 500) {
    return { ok: false, error: "Описание предложения не должно превышать 500 символов" };
  }

  const locationModeInput = value.locationMode ?? "radius";
  if (
    typeof locationModeInput !== "string" ||
    !SEARCH_LOCATION_MODES.includes(locationModeInput as SearchLocationMode)
  ) {
    return { ok: false, error: "Поле «locationMode» содержит неподдерживаемый режим" };
  }
  const locationMode = locationModeInput as SearchLocationMode;

  let metro: SearchMetroSelection | undefined;
  if (value.metro !== undefined) {
    if (!isRecord(value.metro) || typeof value.metro.systemId !== "string") {
      return { ok: false, error: "Поле «metro» должно содержать выбранный метрополитен" };
    }
    if (!isRussianMetroSystemId(value.metro.systemId)) {
      return { ok: false, error: "Выбран неподдерживаемый метрополитен" };
    }
    const stationId =
      typeof value.metro.stationId === "string"
        ? value.metro.stationId.trim()
        : undefined;
    const stationName =
      typeof value.metro.stationName === "string"
        ? value.metro.stationName.trim()
        : undefined;
    if ((stationId && !stationName) || (!stationId && stationName)) {
      return { ok: false, error: "Станция метро должна содержать ID и название" };
    }
    if (
      (stationId?.length ?? 0) > 600 ||
      (stationName?.length ?? 0) > 160 ||
      (stationName ? /[\p{Cc}\p{Cf}]/u.test(stationName) : false)
    ) {
      return { ok: false, error: "Данные станции метро слишком длинные" };
    }
    metro = {
      systemId: value.metro.systemId,
      ...(stationId && stationName ? { stationId, stationName } : {}),
    };
  }
  if (locationMode === "metro" && (!metro?.stationId || !metro.stationName || !center.value)) {
    return {
      ok: false,
      error: "Для режима метро выберите конкретную станцию и её координаты",
    };
  }
  if (locationMode !== "metro" && metro) {
    return {
      ok: false,
      error: "Выбор станции метро допустим только в режиме «metro»",
    };
  }
  if (locationMode === "metro" && metro && center.value) {
    if (locale !== "ru-RU" || countryCodes[0] !== "RU") {
      return {
        ok: false,
        error: "Поиск по метро доступен только для городов России",
      };
    }
    if (radiusKm > 10) {
      return {
        ok: false,
        error: "Радиус поиска от метро должен быть от 0,5 до 10 км",
      };
    }
    if (!metro.stationId?.startsWith("geoapify:")) {
      return {
        ok: false,
        error: "Станция метро должна быть выбрана из серверного справочника",
      };
    }
    const system = getRussianMetroSystem(metro.systemId);
    if (
      !system ||
      distanceKm(
        [system.center[0], system.center[1]],
        center.value,
      ) > system.searchRadiusMeters / 1_000
    ) {
      return {
        ok: false,
        error: "Координаты станции не соответствуют выбранному метрополитену",
      };
    }
  }

  return {
    ok: true,
    payload: {
      description,
      primaryQuery,
      relatedQueries: relatedQueries.value ?? [],
      excludeQueries: excludeQueries.value ?? [],
      location:
        locationMode === "metro" && metro?.stationName
          ? `Метро «${metro.stationName}», ${getRussianMetroSystem(metro.systemId)?.city ?? "Россия"}`
          : location,
      locationMode,
      ...(metro ? { metro } : {}),
      ...(center.value ? { center: center.value } : {}),
      radiusKm,
      ...(offer ? { offer } : {}),
      services: services.value ?? [],
      locale,
      countryCodes,
      ...(confirmedConceptIds.value?.length
        ? { confirmedConceptIds: confirmedConceptIds.value }
        : {}),
      ...(confirmedAlternative ? { confirmedAlternative } : {}),
      ...(confirmationToken ? { confirmationToken } : {}),
    },
  };
}

function websiteStatus(hasWebsite: boolean) {
  return {
    sourceStatus: hasWebsite ? ("listed" as const) : ("not_listed" as const),
    // The API only tells us whether a URL is present in the Yandex card. It
    // does not verify that the website is reachable or belongs to the entity.
    verifiedStatus: "not_checked" as const,
  };
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
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

function scoreLead(input: {
  primaryFound: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  matchedQueries: number;
}) {
  const opportunity = Math.min(
    100,
    35 +
      (input.hasPhone ? 20 : 0) +
      (!input.hasWebsite ? 20 : 5) +
      Math.min(15, input.matchedQueries * 5),
  );
  const hiddenness = Math.min(
    100,
    25 + (!input.primaryFound ? 45 : 0) + (!input.hasWebsite ? 20 : 0),
  );
  const confidence = Math.min(
    100,
    45 + (input.hasPhone ? 20 : 0) + (input.hasWebsite ? 15 : 0) + 10,
  );
  return { opportunity, hiddenness, confidence };
}

type YandexFeature = {
  properties?: {
    name?: string;
    description?: string;
    uri?: string;
    CompanyMetaData?: {
      id?: string;
      name?: string;
      address?: string;
      Address?: { formatted?: string };
      url?: string;
      Categories?: Array<{ class?: string; name?: string }>;
      Phones?: Array<{ type?: string; formatted?: string }>;
      Hours?: { text?: string };
    };
  };
  geometry?: { type?: string; coordinates?: number[] };
};

type YandexCollection = {
  features?: YandexFeature[];
};

class YandexProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "YandexProviderError";
  }
}

function validCoordinates(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

async function requestYandex(
  params: Record<string, string>,
  apiKey: string,
  signal?: AbortSignal,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<YandexCollection> {
  const query = new URLSearchParams({ ...params, apikey: apiKey });
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${YANDEX_ENDPOINT}?${query.toString()}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      if (response.status === 400) {
        throw new YandexProviderError(
          "Яндекс отклонил параметры поискового запроса",
          "YANDEX_BAD_REQUEST",
        );
      }
      if (response.status === 403) {
        throw new YandexProviderError(
          "Ключ Яндекс.Карт недействителен или не имеет доступа к API поиска",
          "YANDEX_FORBIDDEN",
        );
      }
      if (response.status === 429) {
        throw new YandexProviderError(
          "Превышен лимит запросов к Яндекс.Картам",
          "YANDEX_RATE_LIMIT",
        );
      }
      throw new YandexProviderError(
        `Сервис Яндекс.Карт временно недоступен (HTTP ${response.status})`,
        "YANDEX_UPSTREAM_ERROR",
      );
    }

    try {
      const data: unknown = await response.json();
      if (!isRecord(data)) {
        throw new YandexProviderError(
          "Яндекс.Карты вернули ответ неизвестного формата",
          "YANDEX_INVALID_RESPONSE",
        );
      }
      return data as YandexCollection;
    } catch (error) {
      if (error instanceof YandexProviderError) throw error;
      throw new YandexProviderError(
        "Не удалось прочитать ответ Яндекс.Карт",
        "YANDEX_INVALID_RESPONSE",
      );
    }
  } catch (error) {
    if (error instanceof YandexProviderError) throw error;
    if (signal?.aborted) {
      throw new YandexProviderError("Поиск отменён", "SEARCH_ABORTED");
    }
    if (controller.signal.aborted) {
      throw new YandexProviderError(
        `Яндекс.Карты не ответили за ${Math.ceil(timeoutMs / 1_000)} секунд`,
        "YANDEX_TIMEOUT",
      );
    }
    // Never forward fetch errors: depending on the runtime they may contain
    // the request URL, including the API key.
    throw new YandexProviderError(
      "Не удалось подключиться к Яндекс.Картам",
      "YANDEX_NETWORK_ERROR",
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

async function resolveSearchCenter(
  location: string,
  apiKey: string,
  signal?: AbortSignal,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<[number, number]> {
  const data = await requestYandex(
    { text: location, type: "geo", lang: "ru_RU", results: "1" },
    apiKey,
    signal,
    timeoutMs,
  );
  const coordinates = data.features?.[0]?.geometry?.coordinates;
  if (!validCoordinates(coordinates)) {
    throw new YandexProviderError(
      "Не удалось определить центр указанной географии",
      "YANDEX_LOCATION_NOT_FOUND",
    );
  }
  return [coordinates[0], coordinates[1]];
}

function searchSpan(
  center: [number, number],
  radiusKm: number,
): [number, number] {
  const latitudeRadians = (center[1] * Math.PI) / 180;
  const latitudeSpan = Math.min(180, (radiusKm * 2) / 111.32);
  const longitudeKm = Math.max(1, 111.32 * Math.cos(latitudeRadians));
  const longitudeSpan = Math.min(360, (radiusKm * 2) / longitudeKm);
  return [longitudeSpan, latitudeSpan];
}

function distanceKm(
  left: [number, number],
  right: [number, number],
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6_371;
  const latitudeDelta = toRadians(right[1] - left[1]);
  const longitudeDelta = toRadians(right[0] - left[0]);
  const latitude1 = toRadians(left[1]);
  const latitude2 = toRadians(right[1]);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) *
      Math.cos(latitude2) *
      Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isExcluded(feature: YandexFeature, exclusions: string[]): boolean {
  if (!exclusions.length) return false;
  const company = feature.properties?.CompanyMetaData;
  const searchable = [
    company?.name,
    company?.address,
    company?.Address?.formatted,
    ...(company?.Categories?.map((category) => category.name) ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase("ru-RU");
  return exclusions.some((item) => searchable.includes(item.toLocaleLowerCase("ru-RU")));
}

async function yandexSearch(
  payload: SearchPayload,
  apiKey: string,
  onProgress?: SearchProgressCallback,
  signal?: AbortSignal,
  runtime?: import("@/lib/search-runtime").SearchRuntimeContext,
): Promise<SearchResponse> {
  const requiredStageTimeout = (maximumMs: number) => {
    const timeoutMs = runtime?.stageTimeoutMs(maximumMs, 1_000) ?? maximumMs;
    if (timeoutMs < 1) {
      runtime?.throwIfAborted();
      throw new SearchRuntimeError(
        "SEARCH_DEADLINE_EXCEEDED",
        "Общий лимит времени поиска исчерпан",
      );
    }
    return timeoutMs;
  };
  const terms = [
    ...new Set([payload.primaryQuery, ...payload.relatedQueries].map((term) => term.trim())),
  ]
    .filter(Boolean)
    .slice(0, MAX_QUERY_TERMS);
  await emitProgress(onProgress, {
    stage: "geocoding",
    status: "started",
    message: payload.center
      ? "Используем точку, выбранную на карте"
      : "Определяем координаты указанной географии",
  });
  const geocodingBudget = runtime?.beginStage(5_000, 1_000);
  const center: [number, number] = payload.center
    ? [payload.center[0], payload.center[1]]
    : await resolveSearchCenter(
        payload.location,
        apiKey,
        signal,
        geocodingBudget
          ? requiredStageTimeout(geocodingBudget.timeoutMs(5_000))
          : 5_000,
      );
  await emitProgress(onProgress, {
    stage: "geocoding",
    status: "completed",
    message: "География поиска определена",
  });
  const span = searchSpan(center, payload.radiusKm);
  const observations = new Map<
    string,
    { feature: YandexFeature; matchedQueries: string[]; primaryFound: boolean }
  >();
  let cardsFound = 0;
  const placesBudget = runtime?.beginStage(7_000, 1_000);

  await emitProgress(onProgress, {
    stage: "places",
    status: "started",
    message: "Ищем организации по поисковым запросам",
    completed: 0,
    total: terms.length,
  });
  for (const [termIndex, term] of terms.entries()) {
    const placesTimeoutMs = placesBudget?.timeoutMs(7_000) ?? 7_000;
    const data = await requestYandex({
      text: term,
      type: "biz",
      lang: "ru_RU",
      results: "50",
      ll: `${center[0]},${center[1]}`,
      spn: `${span[0]},${span[1]}`,
      rspn: "1",
    }, apiKey, signal, requiredStageTimeout(placesTimeoutMs));
    for (const feature of data.features ?? []) {
      const company = feature.properties?.CompanyMetaData;
      const coordinates = feature.geometry?.coordinates;
      if (
        !company?.name ||
        !validCoordinates(coordinates) ||
        distanceKm(center, coordinates) > payload.radiusKm ||
        isExcluded(feature, payload.excludeQueries)
      ) {
        continue;
      }
      cardsFound += 1;
      const address = company.address ?? company.Address?.formatted ?? "";
      const id = company.id ?? feature.properties?.uri ?? `${company.name}:${address}`;
      const current = observations.get(id);
      if (current) {
        if (!current.matchedQueries.includes(term)) current.matchedQueries.push(term);
        if (term === payload.primaryQuery) current.primaryFound = true;
      } else {
        observations.set(id, {
          feature,
          matchedQueries: [term],
          primaryFound: term === payload.primaryQuery,
        });
      }
    }
    await emitProgress(onProgress, {
      stage: "places",
      status: "running",
      message: `Обработано поисковых запросов: ${termIndex + 1} из ${terms.length}`,
      completed: termIndex + 1,
      total: terms.length,
    });
  }

  await emitProgress(onProgress, {
    stage: "places",
    status: "completed",
    message: `Поиск организаций завершён: ${observations.size}`,
    completed: terms.length,
    total: terms.length,
  });
  await emitProgress(onProgress, {
    stage: "relevance_classification",
    status: "completed",
    message: "Live-карточки Яндекса не передаются классификатору",
    completed: observations.size,
    total: observations.size,
  });
  await emitProgress(onProgress, {
    stage: "details",
    status: "started",
    message: "Контакты получены вместе с карточками Яндекса",
    completed: 0,
    total: 0,
  });
  await emitProgress(onProgress, {
    stage: "details",
    status: "completed",
    message: "Отдельное обогащение карточек не требуется",
    completed: 0,
    total: 0,
  });
  await emitProgress(onProgress, {
    stage: "normalizing",
    status: "started",
    message: "Структурируем, оцениваем и сортируем лиды",
  });

  const leads: Lead[] = [...observations.entries()].map(
    ([id, observation], index) => {
      const company = observation.feature.properties?.CompanyMetaData ?? {};
      const rawCoordinates = observation.feature.geometry?.coordinates;
      const coordinates: [number, number] = validCoordinates(rawCoordinates)
        ? [rawCoordinates[0], rawCoordinates[1]]
        : center;
      const websiteUrl = safeHttpUrl(company.url);
      const hasWebsite = Boolean(websiteUrl);
      const phone = company.Phones?.find((item) => item.formatted)?.formatted ?? null;
      const scores = scoreLead({
        primaryFound: observation.primaryFound,
        hasPhone: Boolean(phone),
        hasWebsite,
        matchedQueries: observation.matchedQueries.length,
      });
      return {
        id: `yandex-${id}`,
        name: company.name ?? `Организация ${index + 1}`,
        category: company.Categories?.[0]?.name ?? "Организация",
        tags: (company.Categories ?? [])
          .map((category) => category.name)
          .filter((value): value is string => Boolean(value)),
        location: {
          address: company.address ?? company.Address?.formatted ?? "Адрес не указан",
          coordinates,
        },
        phone,
        website: {
          ...websiteStatus(hasWebsite),
          url: websiteUrl,
        },
        socials: {},
        digitalProblems: hasWebsite
          ? []
          : [
              "Сайт не указан в карточке Яндекса",
              "Наличие сайта вне Яндекса не проверено",
            ],
        discovery: {
          matchedQueries: observation.matchedQueries,
          hiddenReason: observation.primaryFound
            ? "Найден по основному запросу"
            : "Найден только по смежному запросу",
          observedAt: new Date().toISOString(),
          source: "yandex",
          primaryFound: observation.primaryFound,
        },
        sources: [
          {
            provider: "yandex",
            externalId: id,
            observedAt: new Date().toISOString(),
          },
        ],
        scores,
        status: "Новый",
        summary: `Карточка получена через официальный API Яндекс.Карт. ${
          phone ? "Телефон указан." : "Телефон не указан."
        } ${hasWebsite ? "URL сайта указан, доступность не проверена." : "URL сайта не указан; это не доказывает отсутствие сайта."}`,
        recommendedOffer: !hasWebsite
          ? `Сначала проверить наличие сайта вне Яндекса. При подтверждении цифрового разрыва — ${
              payload.offer ||
              (payload.services.length
                ? `обсудить: ${payload.services.join(", ")}`
                : "предложить первичный аудит цифрового присутствия")
            }.`
          : payload.offer ||
            (payload.services.length
              ? `Проверить потребность: ${payload.services.join(", ")}.`
              : "Провести первичный аудит цифрового присутствия."),
        possibleBranches: [],
        relevance: notCheckedRelevance(id, "CLASSIFIER_DISABLED_FOR_PROVIDER"),
      };
    },
  );

  leads.sort((left, right) => right.scores.opportunity - left.scores.opportunity);
  const foundByPrimary = leads.filter((lead) => lead.discovery.primaryFound).length;
  const foundOnlyExpanded = leads.length - foundByPrimary;
  await emitProgress(onProgress, {
    stage: "normalizing",
    status: "completed",
    message: `Подготовлено лидов: ${leads.length}`,
  });
  const response: SearchResponse = {
    mode: "yandex",
    provider: {
      id: "yandex",
      label: "Яндекс Search API",
      queriedAt: new Date().toISOString(),
      policy: {
        persistence: "contract_required",
        attributionRequired: true,
        attribution: ["Яндекс"],
        rawResponsesStored: false,
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
          lead.scores.confidence < 70 || lead.website.sourceStatus === "not_listed",
      ).length,
      relevance: {
        matched: 0,
        maybe: 0,
        rejected: 0,
        notChecked: leads.length,
      },
    },
    leads,
    notice:
      "Результат является обнаруженной выборкой API, а не гарантированно полным реестром рынка.",
    generatedAt: new Date().toISOString(),
  };
  await emitProgress(onProgress, {
    stage: "complete",
    status: "completed",
    message: `Поиск завершён: ${leads.length} лидов`,
  });
  return response;
}

export async function GET() {
  const providerSetting =
    process.env.SEARCH_PROVIDER?.trim().toLocaleLowerCase("en-US") || "demo";
  const geoapifyKeyConfigured = Boolean(process.env.GEOAPIFY_API_KEY?.trim());
  const geoapifyConfigured =
    providerSetting === "geoapify" && geoapifyKeyConfigured;
  const yandexKeyConfigured = Boolean(process.env.YANDEX_MAPS_API_KEY?.trim());
  const yandexLiveUiEnabled = process.env.YANDEX_LIVE_UI_ENABLED === "true";
  const yandexConfigured = yandexKeyConfigured && yandexLiveUiEnabled;
  const kimiConfigured = Boolean(
    process.env.KIMI_API_KEY?.trim() || process.env.MOONSHOT_API_KEY?.trim(),
  );
  const mode = selectedProvider();
  return Response.json({
    status: "ok",
    service: "LeadRadar Search API",
    version: packageMetadata.version,
    mode,
    searchProvider: providerSetting,
    geoapifyConfigured,
    geoapifyKeyConfigured,
    yandexConfigured,
    yandexKeyConfigured,
    yandexLiveUiEnabled,
    capabilities: {
      demoMode: true,
      queryIntelligence: {
        configured: kimiConfigured,
        mode: plannerModeFromEnv(),
        model: process.env.KIMI_PLANNER_MODEL?.trim() || "kimi-k3",
        strictStructuredOutput: true,
        relevance: {
          deterministic: true,
          statuses: ["matched", "maybe", "rejected", "not_checked"],
          optionalClassifierEnabled:
            process.env.KIMI_LEAD_CLASSIFICATION_ENABLED === "true",
          liveLeadCardsSentToKimi: false,
        },
        runtime: {
          deadlineMs: searchDeadlineMsFromEnv(),
          heartbeatMs: 1_500,
          ...searchPlannerRuntimeMetrics(),
        },
      },
      geoapifyPlaces: {
        configured: geoapifyConfigured,
        capabilityRegistry: {
          version: GEOAPIFY_CAPABILITY_REGISTRY.version,
          checksum: GEOAPIFY_CAPABILITY_REGISTRY.checksum,
          categoryCount: GEOAPIFY_CAPABILITY_REGISTRY.categories.length,
          sourceRetrievedAt: GEOAPIFY_CAPABILITY_REGISTRY.sourceRetrievedAt,
        },
        placesLimit: geoapifyPlacesLimit(),
        detailsLimit: geoapifyDetailsLimit(),
        retrievalLimits: GEOAPIFY_RETRIEVAL_LIMITS,
        strictRadius: true,
        countryFilter: "ru",
        supportedCountryCodes: SUPPORTED_COUNTRY_CODES,
        rawResponsesStored: false,
      },
      metroStations: {
        configured: geoapifyKeyConfigured,
        systems: RUSSIAN_METRO_SYSTEMS.map(({ id, city }) => ({ id, city })),
        source: "Geoapify / OpenStreetMap",
        typedGeocodeFallback: true,
        rawResponsesStored: false,
      },
      yandexGeosearch: {
        configured: yandexConfigured,
        maxResultsPerQuery: 50,
        maxTermsPerSearch: MAX_QUERY_TERMS,
        strictRadius: true,
        documentedFields: [
          "id",
          "name",
          "address",
          "coordinates",
          "url",
          "categories",
          "phones",
          "hours",
        ],
      },
    },
    notice:
      providerSetting === "geoapify" && !geoapifyKeyConfigured
        ? "Выбран Geoapify, но серверный GEOAPIFY_API_KEY не настроен. Используется demo-режим."
        : yandexKeyConfigured && !yandexLiveUiEnabled
        ? "Ключ обнаружен, но live UI заблокирован до подтверждения лицензионных условий. Используется demo-режим."
        : "Поиск возвращает обнаруженную выборку релевантных организаций, а не полный реестр рынка.",
  });
}

type PublicSearchError = {
  error: string;
  code: string;
  status: number;
  retryable: boolean;
  plan?: SearchPlan;
};

async function emitProgress(
  onProgress: SearchProgressCallback | undefined,
  event: Omit<SearchProgressEvent, "type" | "timestamp">,
) {
  await onProgress?.({
    type: "progress",
    ...event,
    timestamp: new Date().toISOString(),
  });
}

async function demoSearch(
  payload: SearchPayload,
  onProgress?: SearchProgressCallback,
): Promise<SearchResponse> {
  await emitProgress(onProgress, {
    stage: "geocoding",
    status: "completed",
    message: payload.center
      ? "Используем точку, выбранную на карте"
      : "Демо-режим использует подготовленную географию",
  });
  await emitProgress(onProgress, {
    stage: "places",
    status: "started",
    message: "Загружаем демонстрационную выборку",
    completed: 0,
    total: 1,
  });
  await emitProgress(onProgress, {
    stage: "places",
    status: "completed",
    message: "Демонстрационная выборка загружена",
    completed: 1,
    total: 1,
  });
  await emitProgress(onProgress, {
    stage: "relevance_classification",
    status: "completed",
    message: "Синтетические демо-карточки помечены как непроверенные",
    completed: 0,
    total: 0,
  });
  await emitProgress(onProgress, {
    stage: "details",
    status: "started",
    message: "Демо-карточки уже содержат подготовленные контакты",
    completed: 0,
    total: 0,
  });
  await emitProgress(onProgress, {
    stage: "details",
    status: "completed",
    message: "Отдельное обогащение демо-карточек не требуется",
    completed: 0,
    total: 0,
  });
  await emitProgress(onProgress, {
    stage: "normalizing",
    status: "started",
    message: "Структурируем демонстрационные лиды",
  });
  const response = createDemoResponse(payload);
  await emitProgress(onProgress, {
    stage: "normalizing",
    status: "completed",
    message: `Подготовлено лидов: ${response.leads.length}`,
  });
  await emitProgress(onProgress, {
    stage: "complete",
    status: "completed",
    message: `Поиск завершён: ${response.leads.length} лидов`,
  });
  return response;
}

const searchOrchestrator = createSearchOrchestrator({
  async verifyGeography(payload, signal) {
    if (
      payload.locationMode !== "metro" ||
      !payload.metro?.stationId ||
      !payload.metro.stationName ||
      !payload.center
    ) {
      return payload;
    }

    const system = getRussianMetroSystem(payload.metro.systemId);
    const apiKey = process.env.GEOAPIFY_API_KEY?.trim();
    if (!system || !apiKey) {
      throw new SearchProviderError(
        "Справочник метро временно недоступен",
        "GEOAPIFY_NOT_CONFIGURED",
      );
    }
    const station = await verifyGeoapifyMetroStationSelection(
      system,
      {
        stationId: payload.metro.stationId,
        stationName: payload.metro.stationName,
        coordinates: payload.center,
      },
      apiKey,
      signal,
    );
    return {
      ...payload,
      location: `Метро «${station.name}», ${system.city}`,
      metro: {
        systemId: system.id,
        stationId: station.id,
        stationName: station.name,
      },
      center: station.coordinates,
    };
  },
  createPlan: (payload, signal) => createSearchPlanFromEnv(payload, { signal }),
  async confirmPlan(payload) {
    const signingSecret = process.env.SEARCH_PLAN_SIGNING_SECRET?.trim();
    if (!signingSecret) {
      throw new SearchPlanOutcomeError(
        "Сервер не настроен для безопасного подтверждения категории",
        "SEARCH_PLAN_CONFIRMATION_REQUIRED",
        409,
      );
    }
    try {
      return await confirmSearchPlan(
        {
          input: payload,
          confirmationToken: payload.confirmationToken ?? "",
          selectedAlternative: payload.confirmedAlternative as ConfirmedSemanticAlternative,
        },
        { signingSecret },
      );
    } catch (error) {
      if (error instanceof ConfirmationTokenError) {
        throw new SearchPlanOutcomeError(
          "Подтверждение категории недействительно или истекло. Сформируйте план заново.",
          "SEARCH_PLAN_CONFIRMATION_REQUIRED",
          409,
        );
      }
      throw error;
    }
  },
  isPlannerInfrastructureFailure: isSearchPlannerInfrastructureFailure,
  selectProvider: selectedProvider,
  providers: {
    demo: {
      preparationMessage: "Источник demo не требует категорий Geoapify",
      async prepare(plan) {
        if (requiresGeoapifyNativeRecovery(plan)) {
          throw new SearchProviderError(
            "Для подтверждения категории требуется настроенный Geoapify",
            "GEOAPIFY_NOT_CONFIGURED",
          );
        }
        return {
          completedMessage: "Источник demo выбран без Geoapify compilation",
          execute: (payload, { onProgress }) => demoSearch(payload, onProgress),
        };
      },
    },
    geoapify: {
      preparationMessage: "Компилируем разрешённые категории источника",
      async prepare(plan) {
        const nativeCategoryResolutionRequired =
          requiresGeoapifyNativeRecovery(plan);
        const useSemanticCompiler =
          plan.ai.validation === "passed" ||
          plan.resolution.selectedConceptIds.length === 0;
        const compiledSemanticSelectors = useSemanticCompiler
          ? compileGeoapifySemanticIntent(plan.semanticIntent, plan.intent)
          : null;
        const nativeRecoveryAuthorization =
          nativeCategoryResolutionRequired && compiledSemanticSelectors
            ? projectGeoapifyNativeRecovery(compiledSemanticSelectors)
            : null;
        if (nativeCategoryResolutionRequired) {
          if (
            !nativeRecoveryAuthorization ||
            !plan.executionPreview ||
            canonicalJson(
              nativeRecoveryAuthorization.executionPreview as unknown as CanonicalJsonValue,
            ) !==
              canonicalJson(
                plan.executionPreview as unknown as CanonicalJsonValue,
              )
          ) {
            throw new SearchProviderError(
              "Подписанный recovery-план не совпадает с серверной компиляцией",
              "GEOAPIFY_INVALID_COMPILED_PLAN",
            );
          }
        }
        const semanticSelectors = nativeRecoveryAuthorization?.capabilityPlan ??
          compiledSemanticSelectors;
        const legacySelectors = semanticSelectors
          ? null
          : compileGeoapifySelectors(plan.resolution.selectedConceptIds);
        const categoryIds = semanticSelectors
          ? semanticSelectors.categoryIds
          : [...legacySelectors!.categoryIds];
        const batches: CompiledGeoapifyPlan["batches"] = semanticSelectors
          ? semanticSelectors.batches
          : [{
              id: "arm-legacy-00000000",
              type: "legacy",
              mode: "precision",
              role: "primary",
              priority: 1,
              resultBudget: 80,
              categoryIds,
              nameQuery: null,
              provenance: categoryIds.map((categoryId) => ({
                semanticField: "legacy" as const,
                semanticTerm: plan.semanticIntent.normalizedGoal,
                origin: "legacy" as const,
                match: "legacy_binding" as const,
                categoryId,
              })),
            }];
        const compiledPlan: CompiledGeoapifyPlan = {
          provider: "geoapify",
          providerCatalogVersion: GEOAPIFY_CAPABILITY_REGISTRY.version,
          registryChecksum: GEOAPIFY_CAPABILITY_REGISTRY.checksum,
          categoryIds,
          batches,
          limits: semanticSelectors
            ? { ...semanticSelectors.limits }
            : { ...GEOAPIFY_RETRIEVAL_LIMITS },
          exclusionTerms: semanticSelectors
            ? [...semanticSelectors.exclusionTerms]
            : [...plan.intent.excludeQueries],
          countryCode: plan.intent.countryCodes[0],
          language:
            plan.intent.locale === "be-BY"
              ? "be"
              : plan.intent.locale === "kk-KZ"
                ? "kk"
                : "ru",
          conceptIds: [...plan.resolution.selectedConceptIds],
          nativeCategoryResolutionRequired,
        };
        return {
          completedMessage: `Подготовлено категорий: ${compiledPlan.categoryIds.length}`,
          async execute(payload, { onProgress, signal, runtime }) {
            const apiKey = process.env.GEOAPIFY_API_KEY?.trim();
            return apiKey
                ? new GeoapifyProvider(apiKey).search(payload, {
                  onProgress,
                  signal,
                  runtime,
                  compiledPlan,
                  semanticIntent: plan.semanticIntent,
                })
              : demoSearch(payload, onProgress);
          },
        };
      },
    },
    yandex: {
      preparationMessage: "Источник yandex не требует категорий Geoapify",
      async prepare() {
        return {
          completedMessage: "Источник yandex выбран без Geoapify compilation",
          async execute(payload, { onProgress, signal, runtime }) {
            const liveUiEnabled = process.env.YANDEX_LIVE_UI_ENABLED === "true";
            const apiKey = liveUiEnabled
              ? process.env.YANDEX_MAPS_API_KEY?.trim()
              : undefined;
            return apiKey
              ? yandexSearch(payload, apiKey, onProgress, signal, runtime)
              : demoSearch(payload, onProgress);
          },
        };
      },
    },
  },
});

function publicSearchError(error: unknown): PublicSearchError {
  if (error instanceof SearchRuntimeError) {
    return {
      error: error.message,
      code: error.code,
      status: error.code === "SEARCH_DEADLINE_EXCEEDED" ? 504 : 408,
      retryable: error.retryable,
    };
  }
  if (error instanceof SearchPlanOutcomeError) {
    return {
      error: error.message,
      code: error.code,
      status: error.status,
      retryable: error.code === "SEARCH_PLANNER_UNAVAILABLE",
      ...(error.plan ? { plan: error.plan } : {}),
    };
  }
  if (error instanceof SearchProviderError) {
    return {
      error: error.message,
      code: error.code,
      status:
        error.code === "SEARCH_DEADLINE_EXCEEDED"
          ? 504
          : error.code === "METRO_STATION_MISMATCH"
          ? 400
          : error.code === "GEOAPIFY_UNSUPPORTED_CATEGORY"
            ? 422
            : error.code === "GEOAPIFY_NOT_CONFIGURED"
              ? 503
              : 502,
      retryable: [
        "GEOAPIFY_NOT_CONFIGURED",
        "GEOAPIFY_RATE_LIMIT",
        "GEOAPIFY_TIMEOUT",
        "GEOAPIFY_NETWORK_ERROR",
        "GEOAPIFY_UPSTREAM_ERROR",
        "SEARCH_DEADLINE_EXCEEDED",
      ].includes(error.code),
    };
  }
  if (error instanceof YandexProviderError) {
    return {
      error: error.message,
      code: error.code,
      status: 502,
      retryable: [
        "YANDEX_RATE_LIMIT",
        "YANDEX_TIMEOUT",
        "YANDEX_NETWORK_ERROR",
        "YANDEX_UPSTREAM_ERROR",
      ].includes(error.code),
    };
  }
  return {
    error: "Неизвестная ошибка источника данных",
    code: "SEARCH_UNKNOWN_ERROR",
    status: 502,
    retryable: false,
  };
}

function ndjsonResponseLine(
  value: unknown,
  status = 200,
): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function streamSearch(
  payload: SearchPayload,
  requestSignal?: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  const runtime = createSearchRuntime({
    deadlineMs: searchDeadlineMsFromEnv(),
    parentSignal: requestSignal,
  });
  let closed = false;
  let terminalSent = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sendProgress = (event: SearchProgressEvent) => {
        if (closed || terminalSent) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const sendTerminal = (event: unknown) => {
        if (closed || terminalSent) return;
        terminalSent = true;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const heartbeat = createProgressHeartbeat({
        signal: runtime.signal,
        onProgress: sendProgress,
      });

      void (async () => {
        try {
          runtime.throwIfAborted();
          await heartbeat.report({
            type: "progress",
            stage: "validation",
            status: "started",
            message: "Проверяем параметры поиска",
            timestamp: new Date().toISOString(),
          } satisfies SearchProgressEvent);
          await heartbeat.report({
            type: "progress",
            stage: "validation",
            status: "completed",
            message: "Параметры поиска проверены",
            timestamp: new Date().toISOString(),
          } satisfies SearchProgressEvent);
          const result = await searchOrchestrator.search(payload, {
            onProgress: (event) => heartbeat.report(event),
            runtime,
          });
          runtime.throwIfAborted();
          sendTerminal({ type: "result", data: result });
        } catch (error) {
          const runtimeReason = runtime.signal.reason;
          const failure = publicSearchError(
            runtimeReason instanceof SearchRuntimeError ? runtimeReason : error,
          );
          sendTerminal({
            type: "error",
            error: failure.error,
            code: failure.code,
            retryable: failure.retryable,
            ...(failure.plan ? { plan: failure.plan } : {}),
          });
        } finally {
          heartbeat.stop();
          runtime.dispose();
          if (!closed) {
            closed = true;
            controller.close();
          }
        }
      })();
    },
    cancel() {
      closed = true;
      runtime.cancel();
      runtime.dispose();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function POST(request: Request) {
  const streamRequested = new URL(request.url).searchParams.get("stream") === "1";
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    const failure = { type: "error", error: "Некорректный JSON", code: "INVALID_JSON" };
    return streamRequested
      ? ndjsonResponseLine(failure, 400)
      : Response.json(
          { error: failure.error, code: failure.code },
          { status: 400 },
        );
  }
  const parsed = parseSearchPayload(body);
  if (!parsed.ok) {
    const failure = {
      type: "error",
      error: parsed.error,
      code: "INVALID_SEARCH_PAYLOAD",
    };
    return streamRequested
      ? ndjsonResponseLine(failure, 400)
      : Response.json(
          { error: failure.error, code: failure.code },
          { status: 400 },
        );
  }
  const payload = parsed.payload;
  if (streamRequested) return streamSearch(payload, request.signal);

  const runtime = createSearchRuntime({
    deadlineMs: searchDeadlineMsFromEnv(),
    parentSignal: request.signal,
  });
  try {
    const result = await searchOrchestrator.search(payload, { runtime });
    runtime.throwIfAborted();
    return Response.json(result);
  } catch (error) {
    const runtimeReason = runtime.signal.reason;
    const failure = publicSearchError(
      runtimeReason instanceof SearchRuntimeError ? runtimeReason : error,
    );
    return Response.json(
      {
        error: failure.error,
        code: failure.code,
        retryable: failure.retryable,
        ...(failure.plan ? { plan: failure.plan } : {}),
      },
      { status: failure.status },
    );
  } finally {
    runtime.dispose();
  }
}
