import { geocodeGeoapifyLocation } from "@/lib/providers/geoapify";
import { geocodeTwoGisLocation } from "@/lib/providers/2gis-location";
import { SearchProviderError } from "@/lib/providers/types";

function errorStatus(code: string) {
  if (code === "GEOAPIFY_INVALID_LOCATION" || code === "DGIS_INVALID_LOCATION") return 400;
  if (code === "GEOAPIFY_LOCATION_NOT_FOUND" || code === "DGIS_LOCATION_NOT_FOUND") return 404;
  if (code === "GEOAPIFY_NOT_CONFIGURED" || code === "DGIS_NOT_CONFIGURED") return 503;
  if (code === "GEOAPIFY_TIMEOUT" || code === "DGIS_TIMEOUT") return 504;
  return 502;
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Некорректный JSON" }, { status: 400 });
  }

  const location =
    body &&
    typeof body === "object" &&
    "location" in body &&
    typeof body.location === "string"
      ? body.location.trim()
      : "";
  if (!location) {
    return Response.json(
      { error: "Укажите город, район или адрес" },
      { status: 400 },
    );
  }
  if (location.length > 300) {
    return Response.json(
      { error: "География поиска не должна превышать 300 символов" },
      { status: 400 },
    );
  }

  const provider = process.env.SEARCH_PROVIDER?.trim().toLocaleLowerCase("en-US") === "2gis"
    ? "2gis"
    : "geoapify";
  const apiKey = provider === "2gis"
    ? process.env.DGIS_API_KEY?.trim()
    : process.env.GEOAPIFY_API_KEY?.trim();
  if (!apiKey) {
    return Response.json(
      { error: `Серверный ключ ${provider === "2gis" ? "2GIS" : "Geoapify"} не настроен` },
      { status: 503 },
    );
  }

  try {
    const coordinates = provider === "2gis"
      ? await geocodeTwoGisLocation(location, apiKey, { signal: request.signal })
      : await geocodeGeoapifyLocation(location, apiKey, request.signal);
    return Response.json({
      coordinates,
      location,
      provider,
    });
  } catch (error) {
    const providerError =
      error instanceof SearchProviderError
        ? error
        : new SearchProviderError(
          "Не удалось определить точку на карте",
            provider === "2gis" ? "DGIS_UNKNOWN_ERROR" : "GEOAPIFY_UNKNOWN_ERROR",
          );
    return Response.json(
      { error: providerError.message, code: providerError.code },
      { status: errorStatus(providerError.code) },
    );
  }
}
