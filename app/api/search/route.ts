import { createDemoResponse } from "@/lib/demo-data";
import type { Lead, SearchPayload, SearchResponse } from "@/lib/types";
import packageMetadata from "@/package.json";

const YANDEX_ENDPOINT = "https://search-maps.yandex.ru/v1/";
const MAX_QUERY_TERMS = 8;
const FETCH_TIMEOUT_MS = 15_000;

type PayloadResult =
  | { ok: true; payload: SearchPayload }
  | { ok: false; error: string };

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

function parseSearchPayload(value: unknown): PayloadResult {
  if (!isRecord(value)) return { ok: false, error: "Тело запроса должно быть объектом" };

  const primaryQuery =
    typeof value.primaryQuery === "string" ? value.primaryQuery.trim() : "";
  const location = typeof value.location === "string" ? value.location.trim() : "";
  if (!primaryQuery) return { ok: false, error: "Укажите основной поисковый запрос" };
  if (!location) return { ok: false, error: "Укажите город, район или адрес центра поиска" };
  if (primaryQuery.length > 200 || location.length > 300) {
    return { ok: false, error: "Поисковый запрос или география слишком длинные" };
  }

  const relatedQueries = stringList(value.relatedQueries, "relatedQueries");
  const excludeQueries = stringList(value.excludeQueries, "excludeQueries");
  const services = stringList(value.services, "services");
  const listError = relatedQueries.error ?? excludeQueries.error ?? services.error;
  if (listError) return { ok: false, error: listError };

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

  return {
    ok: true,
    payload: {
      description,
      primaryQuery,
      relatedQueries: relatedQueries.value ?? [],
      excludeQueries: excludeQueries.value ?? [],
      location,
      radiusKm,
      ...(offer ? { offer } : {}),
      services: services.value ?? [],
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
): Promise<YandexCollection> {
  const query = new URLSearchParams({ ...params, apikey: apiKey });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

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
    if (controller.signal.aborted) {
      throw new YandexProviderError(
        "Яндекс.Карты не ответили за 15 секунд",
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
  }
}

async function resolveSearchCenter(
  location: string,
  apiKey: string,
): Promise<[number, number]> {
  const data = await requestYandex(
    { text: location, type: "geo", lang: "ru_RU", results: "1" },
    apiKey,
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
): Promise<SearchResponse> {
  const terms = [
    ...new Set([payload.primaryQuery, ...payload.relatedQueries].map((term) => term.trim())),
  ]
    .filter(Boolean)
    .slice(0, MAX_QUERY_TERMS);
  const center = await resolveSearchCenter(payload.location, apiKey);
  const span = searchSpan(center, payload.radiusKm);
  const observations = new Map<
    string,
    { feature: YandexFeature; matchedQueries: string[]; primaryFound: boolean }
  >();
  let cardsFound = 0;

  for (const term of terms) {
    const data = await requestYandex({
      text: term,
      type: "biz",
      lang: "ru_RU",
      results: "50",
      ll: `${center[0]},${center[1]}`,
      spn: `${span[0]},${span[1]}`,
      rspn: "1",
    }, apiKey);
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
  }

  const leads: Lead[] = [...observations.entries()].map(
    ([id, observation], index) => {
      const company = observation.feature.properties?.CompanyMetaData ?? {};
      const rawCoordinates = observation.feature.geometry?.coordinates;
      const coordinates: [number, number] = validCoordinates(rawCoordinates)
        ? [rawCoordinates[0], rawCoordinates[1]]
        : center;
      const hasWebsite = Boolean(company.url);
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
          url: company.url ?? null,
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
      };
    },
  );

  leads.sort((left, right) => right.scores.opportunity - left.scores.opportunity);
  const foundByPrimary = leads.filter((lead) => lead.discovery.primaryFound).length;
  const foundOnlyExpanded = leads.length - foundByPrimary;
  return {
    mode: "yandex",
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
    },
    leads,
    notice:
      "Результат является обнаруженной выборкой API, а не гарантированно полным реестром рынка.",
    generatedAt: new Date().toISOString(),
  };
}

export async function GET() {
  const yandexKeyConfigured = Boolean(process.env.YANDEX_MAPS_API_KEY?.trim());
  const yandexLiveUiEnabled = process.env.YANDEX_LIVE_UI_ENABLED === "true";
  const yandexConfigured = yandexKeyConfigured && yandexLiveUiEnabled;
  return Response.json({
    status: "ok",
    service: "LeadRadar Search API",
    version: packageMetadata.version,
    mode: yandexConfigured ? "yandex" : "demo",
    yandexConfigured,
    yandexKeyConfigured,
    yandexLiveUiEnabled,
    capabilities: {
      demoMode: true,
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
      yandexKeyConfigured && !yandexLiveUiEnabled
        ? "Ключ обнаружен, но live UI заблокирован до подтверждения лицензионных условий. Используется demo-режим."
        : "Поиск возвращает обнаруженную выборку релевантных организаций, а не полный реестр рынка.",
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  }
  const parsed = parseSearchPayload(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  const payload = parsed.payload;

  const liveUiEnabled = process.env.YANDEX_LIVE_UI_ENABLED === "true";
  const apiKey = liveUiEnabled
    ? process.env.YANDEX_MAPS_API_KEY?.trim()
    : undefined;
  if (!apiKey) return Response.json(createDemoResponse(payload));

  try {
    return Response.json(await yandexSearch(payload, apiKey));
  } catch (error) {
    const providerError =
      error instanceof YandexProviderError
        ? error
        : new YandexProviderError(
            "Неизвестная ошибка источника данных",
            "YANDEX_UNKNOWN_ERROR",
          );
    return Response.json(
      {
        error: providerError.message,
        code: providerError.code,
      },
      { status: 502 },
    );
  }
}
