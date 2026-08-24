import {
  getRussianMetroSystem,
  type RussianMetroSystem,
  type RussianMetroSystemId,
} from "@/lib/metro";
import {
  fetchGeoapifyMetroStationDirectory,
  findGeoapifyMetroStations,
  searchGeoapifyMetroStations,
} from "@/lib/providers/geoapify";
import {
  fetchTwoGisMetroStationDirectory,
  findTwoGisMetroStations,
  searchTwoGisMetroStations,
} from "@/lib/providers/2gis-location";
import { SearchProviderError } from "@/lib/providers/types";

const DIRECTORY_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_QUERY_LENGTH = 100;
const MIN_TYPED_QUERY_LENGTH = 2;
const REQUEST_DEADLINE_MS = 30_000;
const RATE_WINDOW_MS = 60_000;
const DIRECTORY_REQUESTS_PER_WINDOW = 30;
const FALLBACK_REQUESTS_PER_WINDOW = 6;
type MetroProvider = "2gis" | "geoapify";
type MetroStationDirectory = {
  systemId: RussianMetroSystemId;
  stations: import("@/lib/metro").MetroStation[];
  fetchedAt: string;
};

type CachedDirectory = {
  directory: MetroStationDirectory;
  expiresAtMs: number;
};

const directoryCache = new Map<string, CachedDirectory>();
const directoryRateWindows = new Map<string, number[]>();
const fallbackRateWindows = new Map<string, number[]>();
const GLOBAL_RATE_KEY = "__global__";
const MAX_RATE_KEYS = 1_000;

function normalizeQuery(value: string | null): string {
  return (value ?? "")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function metroDirectory(
  provider: MetroProvider,
  system: RussianMetroSystem,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ directory: MetroStationDirectory; cached: boolean }> {
  const nowMs = Date.now();
  const cacheKey = `${provider}:${system.id}`;
  const cached = directoryCache.get(cacheKey);
  if (cached && cached.expiresAtMs > nowMs) {
    return { directory: cached.directory, cached: true };
  }
  const staleDirectory = cached?.directory;

  try {
    // Each caller owns its cancellation signal. This deliberately avoids
    // sharing an abortable promise between clients: one disconnected request
    // must never cancel a healthy concurrent request.
    const directory = provider === "2gis"
      ? await fetchTwoGisMetroStationDirectory(system, apiKey, {
          signal,
          demoMode: process.env.DGIS_DEMO_MODE !== "false",
        })
      : await fetchGeoapifyMetroStationDirectory(system, apiKey, signal);
    directoryCache.set(cacheKey, {
      directory,
      expiresAtMs: Date.now() + DIRECTORY_CACHE_TTL_MS,
    });
    return { directory, cached: false };
  } catch (error) {
    if (staleDirectory) {
      return { directory: staleDirectory, cached: true };
    }
    throw error;
  }
}

function providerErrorStatus(code: string): number {
  if (code === "GEOAPIFY_NOT_CONFIGURED" || code === "DGIS_NOT_CONFIGURED") return 503;
  if (code === "GEOAPIFY_FORBIDDEN" || code === "DGIS_AUTH_FAILED") return 503;
  if (code === "GEOAPIFY_RATE_LIMIT" || code === "DGIS_RATE_LIMIT") return 503;
  if (code === "GEOAPIFY_TIMEOUT" || code === "DGIS_TIMEOUT") return 504;
  if (code === "SEARCH_ABORTED") return 499;
  return 502;
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function clientRateKey(request: Request): string {
  const forwarded = request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0];
  const normalized = forwarded?.trim().slice(0, 80);
  return `client:${normalized || "local-client"}`;
}

function activeRateWindow(
  windows: Map<string, number[]>,
  key: string,
  now: number,
): number[] | null {
  if (windows.size >= MAX_RATE_KEYS && !windows.has(key)) {
    for (const [candidateKey, timestamps] of windows) {
      if (timestamps.every((timestamp) => timestamp <= now - RATE_WINDOW_MS)) {
        windows.delete(candidateKey);
      }
      if (windows.size < MAX_RATE_KEYS) break;
    }
    if (windows.size >= MAX_RATE_KEYS) return null;
  }
  return (windows.get(key) ?? []).filter(
    (timestamp) => timestamp > now - RATE_WINDOW_MS,
  );
}

function consumeScopedRateWindow(
  windows: Map<string, number[]>,
  clientKey: string,
  clientLimit: number,
  globalLimit: number,
): number | null {
  const now = Date.now();
  const globalWindow = activeRateWindow(windows, GLOBAL_RATE_KEY, now);
  const clientWindow = activeRateWindow(windows, clientKey, now);
  if (!globalWindow || !clientWindow) {
    return Math.ceil(RATE_WINDOW_MS / 1_000);
  }
  windows.set(GLOBAL_RATE_KEY, globalWindow);
  windows.set(clientKey, clientWindow);

  const blockedWindow =
    globalWindow.length >= globalLimit
      ? globalWindow
      : clientWindow.length >= clientLimit
        ? clientWindow
        : null;
  if (blockedWindow) {
    return Math.max(
      1,
      Math.ceil((blockedWindow[0] + RATE_WINDOW_MS - now) / 1_000),
    );
  }

  // Commit both counters only after both checks pass. A rejected client cannot
  // consume the shared global budget and deny service to other clients.
  globalWindow.push(now);
  clientWindow.push(now);
  windows.set(GLOBAL_RATE_KEY, globalWindow);
  windows.set(clientKey, clientWindow);
  return null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cityId = url.searchParams.get("city")?.trim().toLowerCase() ?? "";
  const system = getRussianMetroSystem(cityId);
  if (!system) {
    return json(
      {
        error: "Выберите город с действующим метрополитеном",
        code: "METRO_INVALID_CITY",
      },
      400,
    );
  }

  const rawQuery = url.searchParams.get("q");
  if (rawQuery && rawQuery.length > MAX_QUERY_LENGTH) {
    return json(
      {
        error: `Поиск станции не должен превышать ${MAX_QUERY_LENGTH} символов`,
        code: "METRO_INVALID_QUERY",
      },
      400,
    );
  }
  const query = normalizeQuery(rawQuery);
  if (rawQuery !== null && query.length > 0 && query.length < MIN_TYPED_QUERY_LENGTH) {
    return json(
      {
        error: `Введите хотя бы ${MIN_TYPED_QUERY_LENGTH} символа названия станции`,
        code: "METRO_INVALID_QUERY",
      },
      400,
    );
  }

  const rateKey = clientRateKey(request);
  const directoryRetryAfter = consumeScopedRateWindow(
    directoryRateWindows,
    rateKey,
    DIRECTORY_REQUESTS_PER_WINDOW,
    DIRECTORY_REQUESTS_PER_WINDOW * 2,
  );
  if (directoryRetryAfter !== null) {
    return json(
      {
        error: "Слишком много запросов к справочнику метро. Повторите позже.",
        code: "METRO_RATE_LIMIT",
      },
      429,
      { "Retry-After": String(directoryRetryAfter) },
    );
  }

  const provider: MetroProvider =
    process.env.SEARCH_PROVIDER?.trim().toLocaleLowerCase("en-US") === "2gis"
      ? "2gis"
      : "geoapify";
  const apiKey = provider === "2gis"
    ? process.env.DGIS_API_KEY?.trim()
    : process.env.GEOAPIFY_API_KEY?.trim();
  if (!apiKey) {
    return json(
      {
        error: `Серверный ключ ${provider === "2gis" ? "2GIS" : "Geoapify"} не настроен`,
        code: provider === "2gis" ? "DGIS_NOT_CONFIGURED" : "GEOAPIFY_NOT_CONFIGURED",
      },
      503,
    );
  }

  const controller = new AbortController();
  let deadlineReached = false;
  const deadline = setTimeout(() => {
    deadlineReached = true;
    controller.abort();
  }, REQUEST_DEADLINE_MS);
  const abortForClient = () => controller.abort();
  request.signal.addEventListener("abort", abortForClient, { once: true });

  try {
    const { directory, cached } = await metroDirectory(
      provider,
      system,
      apiKey,
      controller.signal,
    );
    let stations = provider === "2gis"
      ? searchTwoGisMetroStations(directory.stations, query)
      : searchGeoapifyMetroStations(directory.stations, query);
    if (query && stations.length === 0) {
      const fallbackRetryAfter = consumeScopedRateWindow(
        fallbackRateWindows,
        rateKey,
        FALLBACK_REQUESTS_PER_WINDOW,
        FALLBACK_REQUESTS_PER_WINDOW * 2,
      );
      if (fallbackRetryAfter !== null) {
        return json(
          {
            error: "Лимит уточняющего поиска исчерпан. Выберите станцию из списка или повторите позже.",
            code: "METRO_FALLBACK_RATE_LIMIT",
          },
          429,
          { "Retry-After": String(fallbackRetryAfter) },
        );
      }
      stations = provider === "2gis"
        ? await findTwoGisMetroStations(system, query, apiKey, {
            signal: controller.signal,
            demoMode: process.env.DGIS_DEMO_MODE !== "false",
          })
        : await findGeoapifyMetroStations(system, query, apiKey, controller.signal);
    }
    return json({
      system: { id: system.id, city: system.city },
      stations,
      provider,
      attribution: provider === "2gis"
        ? ["2GIS"]
        : ["Geoapify", "OpenStreetMap contributors"],
      queriedAt: new Date().toISOString(),
      cached,
      ...(query ? { query } : {}),
    });
  } catch (error) {
    if (deadlineReached) {
      return json(
        {
          error: "Поиск станции превысил допустимое время ожидания",
          code: "METRO_TIMEOUT",
        },
        504,
      );
    }
    const providerError =
      error instanceof SearchProviderError
        ? error
        : new SearchProviderError(
            "Не удалось загрузить станции метро",
            provider === "2gis" ? "DGIS_UNKNOWN_ERROR" : "GEOAPIFY_UNKNOWN_ERROR",
          );
    return json(
      { error: providerError.message, code: providerError.code },
      providerErrorStatus(providerError.code),
    );
  } finally {
    clearTimeout(deadline);
    request.signal.removeEventListener("abort", abortForClient);
  }
}
