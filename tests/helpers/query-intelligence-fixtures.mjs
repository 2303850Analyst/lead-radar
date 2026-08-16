import { readFile } from "node:fs/promises";

const plannerFixtureUrl = new URL(
  "../fixtures/search-intents.cis.json",
  import.meta.url,
);
const classifierFixtureUrl = new URL(
  "../fixtures/search-candidates.cis.json",
  import.meta.url,
);

async function loadJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

export async function loadPlannerFixture() {
  return loadJson(plannerFixtureUrl);
}

export async function loadClassifierFixture() {
  return loadJson(classifierFixtureUrl);
}

export function expandPlannerCases(fixture, { splits } = {}) {
  const allowedSplits = splits ? new Set(splits) : null;
  const include = (entry) => !allowedSplits || allowedSplits.has(entry.split);
  const familyCases = fixture.conceptFamilies.flatMap((family) =>
    family.phrases.map((query, index) => ({
      id: `family-${family.familyId}-${String(index + 1).padStart(2, "0")}`,
      familyId: family.familyId,
      kind: "unambiguous",
      split: family.split,
      locale: "ru-RU",
      countryCode: "RU",
      query,
      expectedStatus: "ready",
      expectedConceptId: family.expectedConceptId,
      forbiddenConceptIds: family.forbiddenConceptIds,
    })),
  );

  return [
    ...familyCases,
    ...fixture.zeroOverlapCases.map((entry) => ({
      ...entry,
      kind: "zero_overlap",
    })),
    ...fixture.ambiguousCases.map((entry) => ({
      ...entry,
      kind: "ambiguous",
    })),
    ...fixture.unsupportedCases.map((entry) => ({
      ...entry,
      kind: "unsupported",
    })),
    ...fixture.injectionCases.map((entry) => ({
      ...entry,
      kind: "injection",
    })),
    ...fixture.localizedCases.map((entry) => ({
      ...entry,
      kind: "localized",
    })),
  ].filter(include);
}

export function normalizeForFixture(value) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const STOP_WORDS = new Set([
  "без",
  "в",
  "где",
  "для",
  "и",
  "из",
  "к",
  "на",
  "по",
  "рядом",
  "с",
  "у",
  "за",
]);

export function meaningfulTokens(value) {
  return normalizeForFixture(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}
