import { isGeoapifyLeafCategoryId } from "../search-planner/catalogs/geoapify";

type CategoryHintOptions = {
  center: readonly [number, number];
  radiusMeters: number;
  countryCode: "RU" | "BY" | "KZ";
  maxCategoryIds?: number;
  minCorroboratingFeatures?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

/**
 * Converts transient Autocomplete POI suggestions into corroborated provider
 * category IDs. Names, addresses, contacts and place IDs never leave this
 * function. A category needs two distinct in-area suggestions, so a single POI
 * cannot silently redefine the user's accepted semantic intent.
 */
export function selectGeoapifyCategoryHints(
  features: readonly unknown[],
  options: CategoryHintOptions,
): string[] {
  const maxCategoryIds = Math.min(Math.max(options.maxCategoryIds ?? 2, 1), 2);
  const minimumEvidence = Math.min(
    Math.max(options.minCorroboratingFeatures ?? 2, 2),
    5,
  );
  const evidenceByCategory = new Map<string, Set<string>>();

  for (const feature of features.slice(0, 20)) {
    if (!isRecord(feature) || !isRecord(feature.properties)) continue;
    const geometry = isRecord(feature.geometry) ? feature.geometry : null;
    if (!geometry || !validCoordinates(geometry.coordinates)) continue;
    if (
      distanceMeters(options.center, geometry.coordinates) >
      options.radiusMeters
    ) {
      continue;
    }
    const countryCode = feature.properties.country_code;
    if (
      typeof countryCode !== "string" ||
      countryCode.toLocaleUpperCase("en-US") !== options.countryCode
    ) {
      continue;
    }
    const categoryId = feature.properties.category;
    if (
      typeof categoryId !== "string" ||
      !isGeoapifyLeafCategoryId(categoryId)
    ) {
      continue;
    }
    const placeId = feature.properties.place_id;
    const evidenceId =
      typeof placeId === "string" && placeId.length <= 500
        ? placeId
        : `${geometry.coordinates[0].toFixed(6)}:${geometry.coordinates[1].toFixed(6)}`;
    const evidence = evidenceByCategory.get(categoryId) ?? new Set<string>();
    evidence.add(evidenceId);
    evidenceByCategory.set(categoryId, evidence);
  }

  return [...evidenceByCategory.entries()]
    .filter(([, evidence]) => evidence.size >= minimumEvidence)
    .sort(
      ([leftId, leftEvidence], [rightId, rightEvidence]) =>
        rightEvidence.size - leftEvidence.size || leftId.localeCompare(rightId),
    )
    .slice(0, maxCategoryIds)
    .map(([categoryId]) => categoryId);
}
