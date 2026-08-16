"use client";

import { Building2, LocateFixed, MapPin, Search, TrainFront } from "lucide-react";
import {
  type Dispatch,
  KeyboardEvent,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  RUSSIAN_METRO_SYSTEMS,
  getRussianMetroSystem,
  type MetroStation,
  type RussianMetroSystemId,
} from "@/lib/metro";
import type { SearchLocationMode, SearchPayload } from "@/lib/types";

import SearchAreaMap from "./SearchAreaMap";

const DEFAULT_SEARCH_CENTER: [number, number] = [37.6173, 55.7558];
const DEFAULT_METRO_SYSTEM_ID: RussianMetroSystemId = "moscow";

const LOCATION_MODES: Array<{
  id: SearchLocationMode;
  label: string;
  fieldLabel: string;
  placeholder: string;
  help: string;
  defaultRadiusKm: number;
}> = [
  {
    id: "city",
    label: "Город",
    fieldLabel: "Город",
    placeholder: "Например, Казань",
    help: "Укажите город — карта найдёт его центр, а радиус задаст круговой охват.",
    defaultRadiusKm: 20,
  },
  {
    id: "district",
    label: "Район",
    fieldLabel: "Район и город",
    placeholder: "Например, Василеостровский район, Санкт-Петербург",
    help: "Укажите район вместе с городом, чтобы избежать совпадений в других регионах.",
    defaultRadiusKm: 5,
  },
  {
    id: "metro",
    label: "Метро",
    fieldLabel: "Станция метро",
    placeholder: "Начните вводить название станции",
    help: "Выберите станцию из списка или введите название и нажмите «Найти».",
    defaultRadiusKm: 1.5,
  },
  {
    id: "region",
    label: "Область",
    fieldLabel: "Регион",
    placeholder: "Например, Московская область",
    help: "В alpha регион задаётся центром и круговым охватом; точные границы появятся позже.",
    defaultRadiusKm: 100,
  },
  {
    id: "radius",
    label: "Радиус",
    fieldLabel: "Центр",
    placeholder: "Адрес или точка на карте",
    help: "Введите адрес и нажмите «Показать» — либо выберите точку прямо на карте.",
    defaultRadiusKm: 15,
  },
];

type MetroDirectoryResponse = {
  system: { id: RussianMetroSystemId; city: string };
  stations: MetroStation[];
  provider: "geoapify";
  attribution: string[];
  queriedAt: string;
  cached?: boolean;
  query?: string;
  error?: string;
};

function normalizeStationName(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/^(?:станция\s+)?метро\s+/i, "")
    .replace(/[«»"']/g, "")
    .replace(/\s+/g, " ");
}

function uniqueStations(stations: MetroStation[]) {
  const unique = new Map<string, MetroStation>();
  for (const station of stations) {
    const key = normalizeStationName(station.name);
    if (!unique.has(key)) unique.set(key, station);
  }
  return [...unique.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "ru"),
  );
}

export default function LocationSelector({
  query,
  setQuery,
  loading,
}: {
  query: SearchPayload;
  setQuery: Dispatch<SetStateAction<SearchPayload>>;
  loading: boolean;
}) {
  const locationMode = query.locationMode ?? "radius";
  const mode = LOCATION_MODES.find((item) => item.id === locationMode) ?? LOCATION_MODES[4];
  const metroSystemId = query.metro?.systemId ?? DEFAULT_METRO_SYSTEM_ID;
  const metroSystem = getRussianMetroSystem(metroSystemId) ?? RUSSIAN_METRO_SYSTEMS[0];
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [metroStations, setMetroStations] = useState<MetroStation[]>([]);
  const [stationText, setStationText] = useState(query.metro?.stationName ?? "");
  const [metroLoading, setMetroLoading] = useState(locationMode === "metro");
  const [metroError, setMetroError] = useState("");
  const [metroMatchMessage, setMetroMatchMessage] = useState("");
  const [metroCandidates, setMetroCandidates] = useState<MetroStation[]>([]);
  const [metroReload, setMetroReload] = useState(0);
  const typedStationController = useRef<AbortController | null>(null);
  const locationController = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      typedStationController.current?.abort();
      locationController.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (locationMode !== "metro") return;
    const controller = new AbortController();

    fetch(`/api/metro-stations?city=${encodeURIComponent(metroSystemId)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as MetroDirectoryResponse;
        if (!response.ok) throw new Error(payload.error || "Не удалось загрузить станции метро");
        return payload;
      })
      .then((payload) => setMetroStations(uniqueStations(payload.stations)))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setMetroStations([]);
        setMetroError(error instanceof Error ? error.message : "Не удалось загрузить станции метро");
      })
      .finally(() => {
        if (!controller.signal.aborted) setMetroLoading(false);
      });

    return () => controller.abort();
  }, [locationMode, metroReload, metroSystemId]);

  const stationOptions = useMemo(
    () => uniqueStations(metroStations),
    [metroStations],
  );

  const chooseMode = (nextMode: SearchLocationMode) => {
    if (nextMode === locationMode) return;
    typedStationController.current?.abort();
    locationController.current?.abort();
    const next = LOCATION_MODES.find((item) => item.id === nextMode) ?? LOCATION_MODES[4];
    setLocationError("");
    setMetroError("");
    setMetroMatchMessage("");
    setMetroCandidates([]);
    setStationText("");
    setQuery((current) => ({
      ...current,
      locationMode: nextMode,
      location: "",
      center: undefined,
      radiusKm: next.defaultRadiusKm,
      metro:
        nextMode === "metro"
          ? { systemId: metroSystemId }
          : undefined,
    }));
  };

  const locateOnMap = async () => {
    const requestedLocation = query.location.trim();
    const requestedMode = locationMode;
    if (!requestedLocation) {
      setLocationError("Сначала укажите географию поиска.");
      return;
    }
    locationController.current?.abort();
    const controller = new AbortController();
    locationController.current = controller;
    setLocating(true);
    setLocationError("");
    try {
      const response = await fetch("/api/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: requestedLocation }),
        signal: controller.signal,
      });
      const payload = (await response.json()) as {
        coordinates?: [number, number];
        error?: string;
      };
      if (!response.ok || !payload.coordinates) {
        throw new Error(payload.error || "Не удалось найти географию на карте");
      }
      if (controller.signal.aborted) return;
      setQuery((current) =>
        (current.locationMode ?? "radius") === requestedMode &&
        current.location.trim() === requestedLocation
          ? { ...current, center: payload.coordinates }
          : current,
      );
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLocationError(
        error instanceof Error ? error.message : "Не удалось найти географию на карте",
      );
    } finally {
      if (locationController.current === controller) {
        locationController.current = null;
        setLocating(false);
      }
    }
  };

  const selectMapCenter = (center: [number, number]) => {
    locationController.current?.abort();
    const [longitude, latitude] = center;
    setLocationError("");
    setMetroError("");
    setStationText("");
    setQuery((current) => ({
      ...current,
      locationMode: "radius",
      metro: undefined,
      center,
      location: `Точка на карте: ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
    }));
  };

  const chooseMetroSystem = (systemId: RussianMetroSystemId) => {
    typedStationController.current?.abort();
    locationController.current?.abort();
    setLocationError("");
    setMetroError("");
    setMetroMatchMessage("");
    setMetroCandidates([]);
    setMetroStations([]);
    setStationText("");
    setQuery((current) => ({
      ...current,
      locationMode: "metro",
      metro: { systemId },
      location: "",
      center: undefined,
      radiusKm: 1.5,
    }));
  };

  const chooseStation = (station: MetroStation) => {
    if (station.systemId !== metroSystemId) return;
    setStationText(station.name);
    setMetroError("");
    setMetroMatchMessage("");
    setMetroCandidates([]);
    setQuery((current) => {
      if (
        current.locationMode !== "metro" ||
        current.metro?.systemId !== station.systemId
      ) {
        return current;
      }
      const selectedSystem = getRussianMetroSystem(station.systemId);
      if (!selectedSystem) return current;
      return {
        ...current,
        locationMode: "metro",
        metro: {
          systemId: station.systemId,
          stationId: station.id,
          stationName: station.name,
        },
        location: `Метро «${station.name}», ${selectedSystem.city}`,
        center: station.coordinates,
        radiusKm:
          current.radiusKm >= 0.5 && current.radiusKm <= 10
            ? current.radiusKm
            : selectedSystem.defaultLocalRadiusKm,
      };
    });
  };

  const updateStationText = (value: string) => {
    typedStationController.current?.abort();
    typedStationController.current = null;
    setMetroLoading(false);
    setStationText(value);
    setMetroError("");
    setMetroMatchMessage("");
    setMetroCandidates([]);
    const exact = stationOptions.find(
      (station) => normalizeStationName(station.name) === normalizeStationName(value),
    );
    if (exact) {
      chooseStation(exact);
      return;
    }
    setQuery((current) =>
      current.locationMode === "metro" && current.metro?.systemId === metroSystemId
        ? {
            ...current,
            metro: { systemId: metroSystemId },
            location: "",
            center: undefined,
          }
        : current,
    );
  };

  const findTypedStation = async () => {
    const typedStation = stationText.trim();
    if (typedStation.length < 2) {
      setMetroError("Введите хотя бы две буквы названия станции.");
      return;
    }
    const exact = stationOptions.find(
      (station) => normalizeStationName(station.name) === normalizeStationName(typedStation),
    );
    if (exact) {
      chooseStation(exact);
      return;
    }

    typedStationController.current?.abort();
    const controller = new AbortController();
    typedStationController.current = controller;
    const requestedSystemId = metroSystemId;
    setMetroLoading(true);
    setMetroError("");
    setMetroMatchMessage("");
    setMetroCandidates([]);
    try {
      const response = await fetch(
        `/api/metro-stations?city=${encodeURIComponent(requestedSystemId)}&q=${encodeURIComponent(typedStation)}`,
        { signal: controller.signal },
      );
      const payload = (await response.json()) as MetroDirectoryResponse;
      if (!response.ok) throw new Error(payload.error || "Не удалось найти станцию");
      if (controller.signal.aborted || payload.system.id !== requestedSystemId) return;
      const candidates = uniqueStations(payload.stations);
      if (!candidates.length) {
        throw new Error("Станция не найдена. Проверьте город и написание.");
      }
      setMetroStations((current) => uniqueStations([...current, ...candidates]));
      const normalizedTypedStation = normalizeStationName(typedStation);
      const exactCandidate = candidates.find(
        (station) => normalizeStationName(station.name) === normalizedTypedStation,
      );
      if (exactCandidate) {
        chooseStation(exactCandidate);
      } else if (candidates.length === 1) {
        chooseStation(candidates[0]);
      } else {
        setMetroCandidates(candidates);
        setMetroMatchMessage(
          `Найдено вариантов: ${candidates.length}. Выберите конкретную станцию.`,
        );
      }
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMetroError(error instanceof Error ? error.message : "Не удалось найти станцию");
    } finally {
      if (typedStationController.current === controller) {
        typedStationController.current = null;
        setMetroLoading(false);
      }
    }
  };

  const handleStationKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void findTypedStation();
  };

  const mapCenter: [number, number] = query.center
    ? query.center
    : locationMode === "metro"
      ? [metroSystem.center[0], metroSystem.center[1]]
      : DEFAULT_SEARCH_CENTER;
  const metroSelected = Boolean(query.metro?.stationId && query.center);
  const radiusMax = locationMode === "metro" ? 10 : 250;

  return (
    <>
      <div className="section-title">
        <span className="icon-box"><MapPin size={18} /></span>
        <div><h2>Где ищем</h2><p>Выберите тип географии, центр и охват выборки</p></div>
      </div>
      <div className="segmented location-modes" role="group" aria-label="Тип географии поиска">
        {LOCATION_MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={locationMode === item.id}
            className={locationMode === item.id ? "active" : ""}
            onClick={() => chooseMode(item.id)}
            disabled={loading}
          >
            {item.label}
          </button>
        ))}
      </div>

      {locationMode === "metro" ? (
        <div className="metro-selector">
          <div className="metro-fields">
            <div className="field-group">
              <label htmlFor="metro-city">Город</label>
              <div className="input-icon select-icon">
                <select
                  id="metro-city"
                  value={metroSystemId}
                  onChange={(event) => chooseMetroSystem(event.target.value as RussianMetroSystemId)}
                  disabled={loading}
                >
                  {RUSSIAN_METRO_SYSTEMS.map((system) => (
                    <option value={system.id} key={system.id}>{system.city}</option>
                  ))}
                </select>
                <Building2 size={16} />
              </div>
            </div>
            <div className="field-group metro-station-field">
              <label htmlFor="metro-station">Станция метро</label>
              <div className="location-input-row metro-input-row">
                <div className="input-icon">
                  <input
                    id="metro-station"
                    list="metro-station-options"
                    value={stationText}
                    onChange={(event) => updateStationText(event.target.value)}
                    onKeyDown={handleStationKeyDown}
                    placeholder={metroLoading && !metroStations.length ? "Загружаем станции…" : mode.placeholder}
                    autoComplete="off"
                    disabled={loading}
                    aria-describedby="metro-station-help"
                    aria-invalid={Boolean(metroError)}
                  />
                  <TrainFront size={17} />
                  <datalist id="metro-station-options">
                    {stationOptions.map((station) => (
                      <option value={station.name} key={station.id} />
                    ))}
                  </datalist>
                </div>
                <button
                  type="button"
                  className="button button-small location-action"
                  onClick={() => void findTypedStation()}
                  disabled={loading || metroLoading || stationText.trim().length < 2}
                >
                  <Search size={15} />{metroLoading ? "Ищем…" : "Найти"}
                </button>
              </div>
              <small className="location-help" id="metro-station-help">
                {metroStations.length
                  ? `В справочнике ${metroStations.length} станций. Если нужной нет — введите название вручную.`
                  : mode.help}
              </small>
              {metroMatchMessage && (
                <small className="location-help metro-match-message" role="status">
                  {metroMatchMessage}
                </small>
              )}
              {metroCandidates.length > 1 && (
                <div className="metro-candidates" aria-label="Найденные станции">
                  {metroCandidates.map((station) => (
                    <button
                      key={station.id}
                      type="button"
                      onClick={() => chooseStation(station)}
                    >
                      {station.name}
                    </button>
                  ))}
                </div>
              )}
              {metroError && (
                <small className="location-error metro-error" role="alert">
                  {metroError}
                  {!stationText.trim() && (
                    <button
                      type="button"
                      onClick={() => {
                        setMetroLoading(true);
                        setMetroError("");
                        setMetroReload((value) => value + 1);
                      }}
                    >
                      Повторить
                    </button>
                  )}
                </small>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="field-group">
          <label htmlFor="location">{mode.fieldLabel}</label>
          <div className="location-input-row">
            <div className="input-icon">
              <input
                id="location"
                value={query.location}
                onChange={(event) => {
                  locationController.current?.abort();
                  const location = event.target.value;
                  setLocating(false);
                  setQuery((current) => ({ ...current, location, center: undefined }));
                }}
                placeholder={mode.placeholder}
                required
              />
              <MapPin size={17} />
            </div>
            <button
              type="button"
              className="button button-small location-action"
              onClick={() => void locateOnMap()}
              disabled={locating || loading}
            >
              <LocateFixed size={15} />{locating ? "Ищем…" : "Показать"}
            </button>
          </div>
          <small className="location-help">{mode.help}</small>
          {locationError && <small className="location-error" role="alert">{locationError}</small>}
        </div>
      )}

      <div className="radius-row">
        <div className="field-group">
          <label htmlFor="radius">
            {locationMode === "metro" ? "Радиус от метро" : "Радиус"}
          </label>
          <div className="unit-input">
            <input
              id="radius"
              type="number"
              min={0.5}
              max={radiusMax}
              step={0.5}
              value={query.radiusKm}
              onChange={(event) => {
                const radiusKm = Number(event.target.value);
                setQuery((current) => ({ ...current, radiusKm }));
              }}
            />
            <span>км</span>
          </div>
        </div>
        <div className="radius-summary">
          <strong>{query.radiusKm} км</strong>
          <span>{locationMode === "metro" ? "вокруг выбранной станции" : "от выбранного центра"}</span>
        </div>
      </div>
      <SearchAreaMap
        center={mapCenter}
        radiusKm={query.radiusKm}
        onCenterChange={selectMapCenter}
        className="location-map"
      />
      <div className={`map-selection-meta ${query.center ? "selected" : ""}`}>
        <LocateFixed size={14} />
        <span>
          {locationMode === "metro" && !metroSelected
            ? `Выберите станцию метро в городе ${metroSystem.city}`
            : query.center
              ? `${locationMode === "metro" ? `Выбрана станция «${query.metro?.stationName}»` : "Центр зафиксирован"}: ${query.center[1].toFixed(5)}, ${query.center[0].toFixed(5)}`
              : "Карта готова: нажмите на неё, чтобы перейти к ручному радиусу"}
        </span>
      </div>
      {locationMode === "metro" && (
        <div className="metro-attribution">
          Станции: <a href="https://www.geoapify.com/" target="_blank" rel="noreferrer">Geoapify</a>
          <span>·</span>
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>
        </div>
      )}
    </>
  );
}
