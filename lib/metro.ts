export const RUSSIAN_METRO_SYSTEMS = [
  {
    id: "moscow",
    city: "Москва",
    name: "Московский метрополитен",
    center: [37.6173, 55.7558] as const,
    searchRadiusMeters: 45_000,
    defaultLocalRadiusKm: 1.5,
  },
  {
    id: "saint-petersburg",
    city: "Санкт-Петербург",
    name: "Петербургский метрополитен",
    center: [30.3158, 59.9398] as const,
    searchRadiusMeters: 40_000,
    defaultLocalRadiusKm: 1.5,
  },
  {
    id: "novosibirsk",
    city: "Новосибирск",
    name: "Новосибирский метрополитен",
    center: [82.9204, 55.0302] as const,
    searchRadiusMeters: 20_000,
    defaultLocalRadiusKm: 1.5,
  },
  {
    id: "nizhny-novgorod",
    city: "Нижний Новгород",
    name: "Нижегородский метрополитен",
    center: [44.0059, 56.3269] as const,
    searchRadiusMeters: 25_000,
    defaultLocalRadiusKm: 1.5,
  },
  {
    id: "samara",
    city: "Самара",
    name: "Самарский метрополитен",
    center: [50.1002, 53.1959] as const,
    searchRadiusMeters: 25_000,
    defaultLocalRadiusKm: 1.5,
  },
  {
    id: "yekaterinburg",
    city: "Екатеринбург",
    name: "Екатеринбургский метрополитен",
    center: [60.5975, 56.8389] as const,
    searchRadiusMeters: 20_000,
    defaultLocalRadiusKm: 1.5,
  },
  {
    id: "kazan",
    city: "Казань",
    name: "Казанский метрополитен",
    center: [49.1064, 55.7961] as const,
    searchRadiusMeters: 20_000,
    defaultLocalRadiusKm: 1.5,
  },
] as const;

export type RussianMetroSystem = (typeof RUSSIAN_METRO_SYSTEMS)[number];
export type RussianMetroSystemId = RussianMetroSystem["id"];

export type MetroStation = {
  id: string;
  systemId: RussianMetroSystemId;
  name: string;
  coordinates: [number, number];
  lineColors: string[];
  providerPlaceIds: string[];
};

export function isRussianMetroSystemId(
  value: string,
): value is RussianMetroSystemId {
  return RUSSIAN_METRO_SYSTEMS.some((system) => system.id === value);
}

export function getRussianMetroSystem(
  id: string,
): RussianMetroSystem | undefined {
  if (!isRussianMetroSystemId(id)) return undefined;
  return RUSSIAN_METRO_SYSTEMS.find((system) => system.id === id);
}
