import type {
  MetroStation,
  RussianMetroSystem,
  RussianMetroSystemId,
} from "../metro";
import { SearchProviderError } from "./types";

const DGIS_GEOCODE_ENDPOINT = "https://catalog.api.2gis.com/3.0/items/geocode";
const DGIS_PLACES_ENDPOINT = "https://catalog.api.2gis.com/3.0/items";
const DGIS_DETAILS_ENDPOINT = "https://catalog.api.2gis.com/3.0/items/byid";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_METRO_PAGES = 10;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type TwoGisPoint = {
  lon?: unknown;
  lat?: unknown;
};

type TwoGisItem = {
  id?: unknown;
  name?: unknown;
  full_name?: unknown;
  full_address_name?: unknown;
  type?: unknown;
  point?: TwoGisPoint;
  color?: unknown;
};

type TwoGisResponse = {
  meta?: { code?: unknown };
  result?: {
    items?: unknown;
    total?: unknown;
  };
};

export type TwoGisLocationOptions = {
  signal?: AbortSignal;
  locale?: string;
  timeoutMs?: number;
  demoMode?: boolean;
  fetch?: FetchLike;
  geocodeEndpoint?: string;
  placesEndpoint?: string;
  detailsEndpoint?: string;
};

export type TwoGisMetroStationDirectory = {
  systemId: RussianMetroSystemId;
  stations: MetroStation[];
  fetchedAt: string;
};

const LOCALES: Record<string, string> = {
  "ru-RU": "ru_RU",
  "ru-BY": "ru_BY",
  "be-BY": "ru_BY",
  "ru-KZ": "ru_KZ",
  "kk-KZ": "kk_KZ",
};

function stringValue(value: unknown, maximum = 500): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function itemCoordinates(item: TwoGisItem): [number, number] | null {
  const candidate: unknown = [item.point?.lon, item.point?.lat];
  return validCoordinates(candidate) ? candidate : null;
}

function responseCode(data: TwoGisResponse): number | null {
  const code = data.meta?.code;
  return typeof code === "number" && Number.isInteger(code) ? code : null;
}

function errorForStatus(status: number): SearchProviderError {
  if (status === 400 || status === 422) {
    return new SearchProviderError(
      "2ГИС отклонил параметры запроса",
      "DGIS_INVALID_REQUEST",
    );
  }
  if (status === 401 || status === 403) {
    return new SearchProviderError(
      "Ключ 2ГИС недействителен или не имеет доступа к API",
      "DGIS_AUTH_FAILED",
    );
  }
  if (status === 429) {
    return new SearchProviderError("Превышен лимит запросов 2ГИС", "DGIS_RATE_LIMIT");
  }
  return new SearchProviderError("2ГИС временно недоступен", "DGIS_UPSTREAM_UNAVAILABLE");
}

async function requestTwoGis(
  endpoint: string,
  parameters: Record<string, string>,
  apiKey: string,
  options: TwoGisLocationOptions,
): Promise<{ items: TwoGisItem[]; total: number | null }> {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) {
    throw new SearchProviderError(
      "Серверный ключ 2ГИС не настроен",
      "DGIS_NOT_CONFIGURED",
    );
  }

  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("key", normalizedApiKey);

  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000));
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException("2GIS request timed out", "TimeoutError")),
    timeoutMs,
  );

  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    if (options.signal?.aborted) {
      throw new SearchProviderError("Запрос отменён", "SEARCH_ABORTED");
    }
    const timedOut = controller.signal.reason instanceof Error &&
      controller.signal.reason.name === "TimeoutError";
    throw new SearchProviderError(
      timedOut ? "2ГИС не ответил вовремя" : "Не удалось подключиться к 2ГИС",
      timedOut ? "DGIS_TIMEOUT" : "DGIS_NETWORK_ERROR",
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }

  if (response.status === 404) return { items: [], total: 0 };
  if (!response.ok) throw errorForStatus(response.status);

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new SearchProviderError("Не удалось прочитать ответ 2ГИС", "DGIS_INVALID_RESPONSE");
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new SearchProviderError("2ГИС вернул слишком большой ответ", "DGIS_RESPONSE_TOO_LARGE");
  }

  let data: TwoGisResponse;
  try {
    data = JSON.parse(text) as TwoGisResponse;
  } catch {
    throw new SearchProviderError("2ГИС вернул ответ неизвестного формата", "DGIS_INVALID_RESPONSE");
  }
  const metaCode = responseCode(data);
  if (metaCode === 404) return { items: [], total: 0 };
  if (metaCode !== null && metaCode !== 200) throw errorForStatus(metaCode);

  const rawItems = data.result?.items;
  const total = typeof data.result?.total === "number" && Number.isFinite(data.result.total)
    ? Math.max(0, Math.trunc(data.result.total))
    : null;
  if (!Array.isArray(rawItems)) {
    if (total === 0) return { items: [], total };
    throw new SearchProviderError("2ГИС вернул ответ неизвестного формата", "DGIS_INVALID_RESPONSE");
  }
  return {
    items: rawItems.filter(
      (item): item is TwoGisItem => Boolean(item) && typeof item === "object",
    ),
    total,
  };
}

function locale(options: TwoGisLocationOptions): string {
  return LOCALES[options.locale ?? "ru-RU"] ?? "ru_RU";
}

export async function geocodeTwoGisLocation(
  location: string,
  apiKey: string,
  options: TwoGisLocationOptions = {},
): Promise<[number, number]> {
  const query = stringValue(location, 300);
  if (!query) {
    throw new SearchProviderError("Укажите город, район или адрес", "DGIS_INVALID_LOCATION");
  }
  const result = await requestTwoGis(
    options.geocodeEndpoint ?? DGIS_GEOCODE_ENDPOINT,
    {
      q: query,
      fields: "items.point,items.full_address_name",
      locale: locale(options),
    },
    apiKey,
    options,
  );
  const coordinates = result.items.map(itemCoordinates).find(
    (candidate): candidate is [number, number] => Boolean(candidate),
  );
  if (!coordinates) {
    throw new SearchProviderError(
      "2ГИС не нашёл указанную географию",
      "DGIS_LOCATION_NOT_FOUND",
    );
  }
  return coordinates;
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
    Math.cos(leftLatitude) * Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
}

function metroStationFromItem(
  system: RussianMetroSystem,
  item: TwoGisItem,
): MetroStation | null {
  const externalId = stringValue(item.id, 160);
  const name = stringValue(item.name ?? item.full_name, 160);
  const coordinates = itemCoordinates(item);
  if (!externalId || !name || !coordinates) return null;
  if (distanceMeters(system.center, coordinates) > system.searchRadiusMeters) return null;
  const color = stringValue(item.color, 9);
  return {
    id: `2gis:${externalId}`,
    systemId: system.id,
    name,
    coordinates,
    lineColors: color && /^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(color)
      ? [color.toLocaleLowerCase("en-US")]
      : [],
    providerPlaceIds: [externalId],
  };
}

function averageCoordinates(stations: readonly MetroStation[]): [number, number] {
  const totals = stations.reduce(
    ([longitude, latitude], station) => [
      longitude + station.coordinates[0],
      latitude + station.coordinates[1],
    ],
    [0, 0],
  );
  return [
    Number((totals[0] / stations.length).toFixed(6)),
    Number((totals[1] / stations.length).toFixed(6)),
  ];
}

function dedupeMetroStations(stations: readonly MetroStation[]): MetroStation[] {
  const groups = new Map<string, MetroStation[]>();
  for (const station of stations) {
    const key = normalizeText(station.name);
    const group = groups.get(key) ?? [];
    group.push(station);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group): MetroStation => {
      const providerPlaceIds = [...new Set(group.flatMap((station) => station.providerPlaceIds))].sort();
      const lineColors = [...new Set(group.flatMap((station) => station.lineColors))].sort();
      return {
        ...group[0],
        id: `2gis:${providerPlaceIds[0]}`,
        coordinates: averageCoordinates(group),
        lineColors,
        providerPlaceIds,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

function metroParameters(
  system: RussianMetroSystem,
  query: string,
  page: number,
  pageSize: number,
  options: TwoGisLocationOptions,
): Record<string, string> {
  const point = `${system.center[0]},${system.center[1]}`;
  return {
    q: query,
    type: "station.metro",
    point,
    location: point,
    radius: String(system.searchRadiusMeters),
    fields: "items.point,items.full_name,items.color",
    locale: locale(options),
    page: String(page),
    page_size: String(pageSize),
  };
}

export function searchTwoGisMetroStations(
  stations: readonly MetroStation[],
  query: string,
): MetroStation[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [...stations];
  const queryTokens = normalizedQuery.split(" ").filter(Boolean);
  return stations
    .filter((station) => {
      const normalizedName = normalizeText(station.name);
      return normalizedName.includes(normalizedQuery) ||
        queryTokens.every((token) => normalizedName.includes(token));
    })
    .sort((left, right) => {
      const leftName = normalizeText(left.name);
      const rightName = normalizeText(right.name);
      return Number(!leftName.startsWith(normalizedQuery)) -
        Number(!rightName.startsWith(normalizedQuery)) ||
        left.name.localeCompare(right.name, "ru");
    });
}

export async function fetchTwoGisMetroStationDirectory(
  system: RussianMetroSystem,
  apiKey: string,
  options: TwoGisLocationOptions = {},
): Promise<TwoGisMetroStationDirectory> {
  const pageSize = options.demoMode === false ? 50 : 10;
  const stations: MetroStation[] = [];
  for (let page = 1; page <= MAX_METRO_PAGES; page += 1) {
    const result = await requestTwoGis(
      options.placesEndpoint ?? DGIS_PLACES_ENDPOINT,
      metroParameters(system, "метро", page, pageSize, options),
      apiKey,
      options,
    );
    stations.push(
      ...result.items
        .map((item) => metroStationFromItem(system, item))
        .filter((station): station is MetroStation => Boolean(station)),
    );
    if (result.items.length < pageSize || (result.total !== null && page * pageSize >= result.total)) {
      break;
    }
  }
  return {
    systemId: system.id,
    stations: dedupeMetroStations(stations),
    fetchedAt: new Date().toISOString(),
  };
}

export async function findTwoGisMetroStations(
  system: RussianMetroSystem,
  query: string,
  apiKey: string,
  options: TwoGisLocationOptions = {},
): Promise<MetroStation[]> {
  const stationName = stringValue(query, 100);
  if (!stationName) return [];
  const pageSize = options.demoMode === false ? 50 : 10;
  const result = await requestTwoGis(
    options.placesEndpoint ?? DGIS_PLACES_ENDPOINT,
    metroParameters(system, stationName, 1, pageSize, options),
    apiKey,
    options,
  );
  const stations = dedupeMetroStations(
    result.items
      .map((item) => metroStationFromItem(system, item))
      .filter((station): station is MetroStation => Boolean(station)),
  );
  return searchTwoGisMetroStations(stations, stationName);
}

export async function verifyTwoGisMetroStationSelection(
  system: RussianMetroSystem,
  selection: {
    stationId: string;
    stationName: string;
    coordinates: [number, number];
  },
  apiKey: string,
  options: TwoGisLocationOptions = {},
): Promise<MetroStation> {
  const prefix = "2gis:";
  if (!selection.stationId.startsWith(prefix)) {
    throw new SearchProviderError(
      "Выберите станцию заново из серверного справочника",
      "METRO_STATION_MISMATCH",
    );
  }
  const externalId = stringValue(selection.stationId.slice(prefix.length), 160);
  if (!externalId) {
    throw new SearchProviderError("Выбранная станция содержит некорректный ID", "METRO_STATION_MISMATCH");
  }
  const result = await requestTwoGis(
    options.detailsEndpoint ?? DGIS_DETAILS_ENDPOINT,
    {
      id: externalId,
      fields: "items.point,items.full_name,items.color",
      locale: locale(options),
    },
    apiKey,
    options,
  );
  const station = result.items
    .map((item) => metroStationFromItem(system, item))
    .filter((candidate): candidate is MetroStation => Boolean(candidate))
    .find((candidate) => candidate.providerPlaceIds.includes(externalId));
  if (
    !station ||
    normalizeText(station.name) !== normalizeText(selection.stationName) ||
    distanceMeters(station.coordinates, selection.coordinates) > 1_500
  ) {
    throw new SearchProviderError(
      "Название или координаты станции не совпадают со справочником",
      "METRO_STATION_MISMATCH",
    );
  }
  return station;
}
