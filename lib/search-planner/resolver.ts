import {
  CANONICAL_TAXONOMY,
  canonicalConceptLabel,
  type CanonicalConceptId,
} from "./taxonomy";
import {
  SUPPORTED_COUNTRY_CODES,
  SUPPORTED_LOCALES,
  type ConceptCandidate,
  type DeterministicResolution,
  type KimiCandidate,
  type NormalizedSearchIntent,
  type PlannerInput,
  type SupportedCountryCode,
  type SupportedLocale,
} from "./types";

export const FUZZY_SHORTLIST_THRESHOLD = 0.35;
export const FUZZY_READY_THRESHOLD = 0.92;
export const FUZZY_READY_MARGIN = 0.15;
export const MAX_KIMI_SHORTLIST_SIZE = 20;

const MAX_DESCRIPTION_LENGTH = 1_000;
const MAX_PRIMARY_QUERY_LENGTH = 200;
const MAX_QUERY_LENGTH = 160;
const MAX_QUERY_ITEMS = 20;

const COUNTRY_BY_LOCALE: Record<SupportedLocale, SupportedCountryCode> = {
  "ru-RU": "RU",
  "ru-BY": "BY",
  "be-BY": "BY",
  "ru-KZ": "KZ",
  "kk-KZ": "KZ",
};

const SUPPORTED_LOCALE_SET = new Set<string>(SUPPORTED_LOCALES);
const SUPPORTED_COUNTRY_SET = new Set<string>(SUPPORTED_COUNTRY_CODES);

const GENERIC_AMBIGUOUS_QUERIES: Readonly<Record<string, readonly CanonicalConceptId[]>> = {
  "склад": ["logistics.warehouse", "logistics.fulfillment"],
  "склады": ["logistics.warehouse", "logistics.fulfillment"],
  "қойма": ["logistics.warehouse", "logistics.fulfillment"],
  "салон": [
    "personal_care.beauty_salon",
    "retail.florist",
    "personal_care.barbershop",
  ],
  "клиника": ["health.medical_clinic", "health.dentist", "retail.pet_store"],
  "мойка": ["automotive.car_wash", "services.cleaning"],
  "агентство": [
    "business.real_estate_agency",
    "professional.law_firm",
    "professional.accounting",
  ],
  "доставка": ["retail.convenience_store", "logistics.fulfillment"],
  "ремонт": [
    "automotive.repair",
    "services.cleaning",
    "marketing.advertising_agency",
  ],
  "школа": ["education.language_school", "education.driving_school"],
  "студия": ["services.photography", "technology.it_company"],
  "магазин для дома": [
    "retail.building_materials",
    "retail.furniture",
    "marketing.advertising_agency",
  ],
};

export class PlannerInputValidationError extends Error {
  readonly code = "INVALID_PLANNER_INPUT";
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid planner input: ${issues.join("; ")}`);
    this.name = "PlannerInputValidationError";
    this.issues = issues;
  }
}

/**
 * Produces the lexical form used for matching and cache identity. The
 * transformation is intentionally language-light and deterministic.
 */
export function normalizeSearchText(
  value: string,
  locale: SupportedLocale = "ru-RU",
): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase(locale)
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function normalizeQueryList(
  values: readonly string[] | undefined,
  locale: SupportedLocale,
): string[] {
  return uniqueSorted((values ?? []).map((value) => normalizeSearchText(value, locale)));
}

function validateStringList(
  field: string,
  values: unknown,
  issues: string[],
): values is readonly string[] | undefined {
  if (values === undefined) return true;
  if (!Array.isArray(values)) {
    issues.push(`${field} must be an array`);
    return false;
  }
  if (values.length > MAX_QUERY_ITEMS) {
    issues.push(`${field} must contain at most ${MAX_QUERY_ITEMS} items`);
  }
  values.forEach((value, index) => {
    if (typeof value !== "string") {
      issues.push(`${field}[${index}] must be a string`);
    } else if (value.length > MAX_QUERY_LENGTH) {
      issues.push(`${field}[${index}] must be at most ${MAX_QUERY_LENGTH} characters`);
    }
  });
  return values.every((value) => typeof value === "string");
}

export function normalizePlannerInput(input: PlannerInput): NormalizedSearchIntent {
  const issues: string[] = [];
  if (!input || typeof input !== "object") {
    throw new PlannerInputValidationError(["input must be an object"]);
  }

  const rawLocale: unknown = input.locale ?? "ru-RU";
  if (typeof rawLocale !== "string" || !SUPPORTED_LOCALE_SET.has(rawLocale)) {
    issues.push(`locale must be one of ${SUPPORTED_LOCALES.join(", ")}`);
  }
  const locale = SUPPORTED_LOCALE_SET.has(String(rawLocale))
    ? (rawLocale as SupportedLocale)
    : "ru-RU";

  if (typeof input.primaryQuery !== "string") {
    issues.push("primaryQuery must be a string");
  } else if (input.primaryQuery.length > MAX_PRIMARY_QUERY_LENGTH) {
    issues.push(`primaryQuery must be at most ${MAX_PRIMARY_QUERY_LENGTH} characters`);
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    issues.push("description must be a string");
  } else if ((input.description?.length ?? 0) > MAX_DESCRIPTION_LENGTH) {
    issues.push(`description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  const relatedValid = validateStringList("relatedQueries", input.relatedQueries, issues);
  const excludeValid = validateStringList("excludeQueries", input.excludeQueries, issues);

  const rawCountries: unknown = input.countryCodes;
  if (rawCountries !== undefined && !Array.isArray(rawCountries)) {
    issues.push("countryCodes must be an array");
  }
  const countries = Array.isArray(rawCountries) ? rawCountries : [];
  if (countries.length > 1) {
    issues.push("countryCodes must contain exactly one country at most");
  }
  countries.forEach((country, index) => {
    if (typeof country !== "string" || !SUPPORTED_COUNTRY_SET.has(country)) {
      issues.push(
        `countryCodes[${index}] must be one of ${SUPPORTED_COUNTRY_CODES.join(", ")}`,
      );
    }
  });

  const expectedCountry = COUNTRY_BY_LOCALE[locale];
  const country = (countries[0] ?? expectedCountry) as SupportedCountryCode;
  if (SUPPORTED_COUNTRY_SET.has(String(country)) && country !== expectedCountry) {
    issues.push(`locale ${locale} is incompatible with country ${country}`);
  }

  const normalizedPrimary =
    typeof input.primaryQuery === "string"
      ? normalizeSearchText(input.primaryQuery, locale)
      : "";
  if (!normalizedPrimary) {
    issues.push("primaryQuery must contain searchable letters or numbers");
  }

  if (issues.length) throw new PlannerInputValidationError(issues);

  return {
    description: normalizeSearchText(input.description ?? "", locale),
    primaryQuery: normalizedPrimary,
    relatedQueries: relatedValid
      ? normalizeQueryList(input.relatedQueries, locale)
      : [],
    excludeQueries: excludeValid
      ? normalizeQueryList(input.excludeQueries, locale)
      : [],
    locale,
    countryCodes: [country],
  };
}

function tokens(value: string): Set<string> {
  return new Set(value.split(" ").filter(Boolean));
}

export function tokenJaccard(left: string, right: string): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (!leftTokens.size && !rightTokens.size) return 1;
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function trigrams(value: string): Set<string> {
  const padded = `  ${value}  `;
  const result = new Set<string>();
  for (let index = 0; index <= padded.length - 3; index += 1) {
    result.add(padded.slice(index, index + 3));
  }
  return result;
}

export function trigramDice(left: string, right: string): number {
  const leftTrigrams = trigrams(left);
  const rightTrigrams = trigrams(right);
  if (!leftTrigrams.size && !rightTrigrams.size) return 1;
  if (!leftTrigrams.size || !rightTrigrams.size) return 0;
  let intersection = 0;
  for (const trigram of leftTrigrams) {
    if (rightTrigrams.has(trigram)) intersection += 1;
  }
  return (2 * intersection) / (leftTrigrams.size + rightTrigrams.size);
}

/** 60% token overlap + 40% character-trigram similarity. */
export function lexicalSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  return 0.6 * tokenJaccard(left, right) + 0.4 * trigramDice(left, right);
}

function conceptTerms(
  concept: (typeof CANONICAL_TAXONOMY)[number],
  locale: SupportedLocale,
): { aliases: string[]; negativeAliases: string[] } {
  return {
    aliases: uniqueSorted(
      concept.aliases[locale].map((value) => normalizeSearchText(value, locale)),
    ),
    negativeAliases: uniqueSorted(
      concept.negativeAliases[locale].map((value) => normalizeSearchText(value, locale)),
    ),
  };
}

function containsPhrase(text: string, phrase: string): boolean {
  return text === phrase || text.startsWith(`${phrase} `) || text.endsWith(` ${phrase}`) || text.includes(` ${phrase} `);
}

function hasNegativeConflict(
  intent: NormalizedSearchIntent,
  aliases: readonly string[],
  negativeAliases: readonly string[],
): boolean {
  const positiveInputs = [
    intent.primaryQuery,
    ...intent.relatedQueries,
    intent.description,
  ].filter(Boolean);
  const negativeAliasHit = positiveInputs.some((input) =>
    negativeAliases.some((negativeAlias) => containsPhrase(input, negativeAlias)),
  );
  const explicitlyExcluded = intent.excludeQueries.some((excluded) =>
    aliases.some(
      (alias) => containsPhrase(excluded, alias) || containsPhrase(alias, excluded),
    ),
  );
  return negativeAliasHit || explicitlyExcluded;
}

function scoreConcept(
  intent: NormalizedSearchIntent,
  aliases: readonly string[],
): number {
  const weightedQueries: Array<{ value: string; weight: number }> = [
    { value: intent.primaryQuery, weight: 1 },
    ...intent.relatedQueries.map((value) => ({ value, weight: 0.9 })),
    ...(intent.description ? [{ value: intent.description, weight: 0.65 }] : []),
  ];
  let best = 0;
  for (const query of weightedQueries) {
    for (const alias of aliases) {
      best = Math.max(best, lexicalSimilarity(query.value, alias) * query.weight);
    }
  }
  return best;
}

function roundScore(score: number): number {
  return Math.round(score * 10_000) / 10_000;
}

export function resolveDeterministically(
  intent: NormalizedSearchIntent,
): DeterministicResolution {
  const exactMatches: ConceptCandidate[] = [];
  const primaryExactMatches: ConceptCandidate[] = [];
  const fuzzyCandidates: ConceptCandidate[] = [];

  for (const concept of CANONICAL_TAXONOMY) {
    const { aliases, negativeAliases } = conceptTerms(concept, intent.locale);
    const negativeConflict = hasNegativeConflict(intent, aliases, negativeAliases);
    const primaryExact = aliases.includes(intent.primaryQuery);
    const exact =
      primaryExact ||
      intent.relatedQueries.some((query) => aliases.includes(query));
    const fuzzyScore = scoreConcept(intent, aliases);
    const candidate: ConceptCandidate = {
      conceptId: concept.id,
      label: canonicalConceptLabel(concept.id, intent.locale),
      score: roundScore(exact ? 1 : fuzzyScore),
      reasonCodes: [exact ? "EXACT_ALIAS" : "FUZZY_MATCH"],
      negativeConflict,
    };
    if (negativeConflict) candidate.reasonCodes.push("NEGATIVE_CONFLICT");
    if (exact) exactMatches.push(candidate);
    if (primaryExact) primaryExactMatches.push(candidate);
    if (fuzzyScore >= FUZZY_SHORTLIST_THRESHOLD) fuzzyCandidates.push(candidate);
  }

  const stableSort = (left: ConceptCandidate, right: ConceptCandidate) =>
    right.score - left.score ||
    (left.conceptId < right.conceptId ? -1 : left.conceptId > right.conceptId ? 1 : 0);
  exactMatches.sort(stableSort);
  primaryExactMatches.sort(stableSort);
  fuzzyCandidates.sort(stableSort);

  const ambiguityConceptIds = GENERIC_AMBIGUOUS_QUERIES[intent.primaryQuery];
  if (ambiguityConceptIds) {
    const existing = new Map(
      [...exactMatches, ...fuzzyCandidates].map((candidate) => [
        candidate.conceptId,
        candidate,
      ]),
    );
    const ambiguousCandidates = ambiguityConceptIds.map((conceptId, index) => {
      const candidate = existing.get(conceptId);
      return {
        conceptId,
        label: canonicalConceptLabel(conceptId, intent.locale),
        score: candidate?.score ?? roundScore(0.85 - index * 0.05),
        reasonCodes: [
          ...(candidate?.reasonCodes ?? ["FUZZY_MATCH" as const]),
          "AMBIGUOUS_SCOPE" as const,
        ],
        negativeConflict: candidate?.negativeConflict ?? false,
      } satisfies ConceptCandidate;
    });
    return {
      decision: "semantic_required",
      method: "exact",
      selectedConceptId: null,
      candidates: ambiguousCandidates,
      fullCatalog: false,
    };
  }

  // The explicit primary field owns the intent. Related queries widen provider
  // recall and must not turn a precise primary category into an ambiguity.
  const viablePrimaryExact = primaryExactMatches.filter(
    (candidate) => !candidate.negativeConflict,
  );
  if (viablePrimaryExact.length === 1) {
    return {
      decision: "ready",
      method: "exact",
      selectedConceptId: viablePrimaryExact[0].conceptId,
      candidates: exactMatches.slice(0, MAX_KIMI_SHORTLIST_SIZE),
      fullCatalog: false,
    };
  }
  if (primaryExactMatches.length) {
    return {
      decision: "semantic_required",
      method: "exact",
      selectedConceptId: null,
      candidates: primaryExactMatches.slice(0, MAX_KIMI_SHORTLIST_SIZE),
      fullCatalog: false,
    };
  }

  const viableExact = exactMatches.filter((candidate) => !candidate.negativeConflict);
  if (viableExact.length === 1) {
    return {
      decision: "ready",
      method: "exact",
      selectedConceptId: viableExact[0].conceptId,
      candidates: exactMatches.slice(0, MAX_KIMI_SHORTLIST_SIZE),
      fullCatalog: false,
    };
  }
  if (exactMatches.length) {
    return {
      decision: "semantic_required",
      method: "exact",
      selectedConceptId: null,
      candidates: exactMatches.slice(0, MAX_KIMI_SHORTLIST_SIZE),
      fullCatalog: false,
    };
  }

  const shortlist = fuzzyCandidates.slice(0, MAX_KIMI_SHORTLIST_SIZE);
  const first = shortlist.find((candidate) => !candidate.negativeConflict);
  const second = shortlist.find(
    (candidate) =>
      !candidate.negativeConflict && candidate.conceptId !== first?.conceptId,
  );
  if (
    first &&
    first.score >= FUZZY_READY_THRESHOLD &&
    first.score - (second?.score ?? 0) >= FUZZY_READY_MARGIN
  ) {
    return {
      decision: "ready",
      method: "fuzzy",
      selectedConceptId: first.conceptId,
      candidates: shortlist,
      fullCatalog: false,
    };
  }

  if (shortlist.length) {
    return {
      decision: "semantic_required",
      method: "fuzzy",
      selectedConceptId: null,
      candidates: shortlist,
      fullCatalog: false,
    };
  }

  return {
    decision: "semantic_required",
    method: "full_catalog",
    selectedConceptId: null,
    candidates: [],
    fullCatalog: true,
  };
}

export function buildKimiCandidates(
  resolution: DeterministicResolution,
  locale: SupportedLocale,
): KimiCandidate[] {
  const ids: readonly string[] = resolution.fullCatalog
    ? CANONICAL_TAXONOMY.map((concept) => concept.id)
    : resolution.candidates.map((candidate) => candidate.conceptId);
  const allowed = new Set(ids);
  return CANONICAL_TAXONOMY.filter((concept) => allowed.has(concept.id)).map(
    (concept) => ({
      conceptId: concept.id,
      label: canonicalConceptLabel(concept.id, locale),
      aliases: conceptTerms(concept, locale).aliases,
      negativeAliases: conceptTerms(concept, locale).negativeAliases,
      physicalPlace: concept.physicalPlace,
    }),
  );
}

export function asCanonicalConceptIds(
  candidates: readonly ConceptCandidate[],
): CanonicalConceptId[] {
  return candidates.map((candidate) => candidate.conceptId as CanonicalConceptId);
}
