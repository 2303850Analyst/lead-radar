import {
  CANONICAL_CONCEPT_IDS,
  type CanonicalConceptId,
  getCanonicalConcept,
} from "../taxonomy";
import type { SemanticIntentV2 } from "../types";
import capabilitySnapshot from "./geoapify-categories.snapshot.json";

export const GEOAPIFY_PROVIDER_CATALOG_VERSION = capabilitySnapshot.catalogVersion;

/**
 * Full provider capability registry captured from Geoapify's official Places
 * documentation. The snapshot is versioned and code-reviewed; runtime never
 * accepts a category merely because a model emitted a similar string.
 */
export const GEOAPIFY_CAPABILITY_REGISTRY = Object.freeze({
  schemaVersion: capabilitySnapshot.schemaVersion,
  provider: capabilitySnapshot.provider,
  version: capabilitySnapshot.catalogVersion,
  sourceUrl: capabilitySnapshot.sourceUrl,
  sourceRetrievedAt: capabilitySnapshot.sourceRetrievedAt,
  checksumAlgorithm: capabilitySnapshot.checksumAlgorithm,
  checksum: capabilitySnapshot.checksum,
  categories: Object.freeze([...capabilitySnapshot.categories]),
});

export const GEOAPIFY_CATEGORY_IDS: readonly string[] =
  GEOAPIFY_CAPABILITY_REGISTRY.categories;

export type GeoapifyCategoryId = string;

export type GeoapifyConceptBinding = {
  conceptId: CanonicalConceptId;
  categoryIds: readonly GeoapifyCategoryId[];
  precision: "narrow" | "broad";
  notes?: string;
};

export const GEOAPIFY_CONCEPT_BINDINGS = [
  { conceptId: "logistics.fulfillment", categoryIds: ["office.logistics", "rental.storage"], precision: "broad", notes: "Geoapify has no dedicated fulfillment category; relevance filtering is mandatory." },
  { conceptId: "logistics.warehouse", categoryIds: ["rental.storage"], precision: "broad" },
  { conceptId: "personal_care.barbershop", categoryIds: ["service.beauty.hairdresser"], precision: "broad", notes: "The upstream category also includes non-barbershop hairdressers." },
  { conceptId: "personal_care.beauty_salon", categoryIds: ["service.beauty"], precision: "broad" },
  { conceptId: "health.dentist", categoryIds: ["healthcare.dentist"], precision: "narrow" },
  { conceptId: "health.medical_clinic", categoryIds: ["healthcare.clinic_or_praxis"], precision: "broad" },
  { conceptId: "health.pharmacy", categoryIds: ["healthcare.pharmacy"], precision: "narrow" },
  { conceptId: "automotive.repair", categoryIds: ["service.vehicle.repair"], precision: "narrow" },
  { conceptId: "automotive.car_wash", categoryIds: ["service.vehicle.car_wash"], precision: "narrow" },
  { conceptId: "automotive.fuel_station", categoryIds: ["service.vehicle.fuel"], precision: "narrow" },
  { conceptId: "automotive.charging_station", categoryIds: ["service.vehicle.charging_station"], precision: "narrow" },
  { conceptId: "retail.supermarket", categoryIds: ["commercial.supermarket"], precision: "narrow" },
  { conceptId: "retail.convenience_store", categoryIds: ["commercial.convenience"], precision: "narrow" },
  { conceptId: "retail.bakery", categoryIds: ["commercial.food_and_drink.bakery"], precision: "narrow" },
  { conceptId: "retail.butcher", categoryIds: ["commercial.food_and_drink.butcher"], precision: "narrow" },
  { conceptId: "retail.florist", categoryIds: ["commercial.florist"], precision: "narrow" },
  { conceptId: "retail.clothing", categoryIds: ["commercial.clothing.clothes"], precision: "narrow" },
  { conceptId: "retail.shoes", categoryIds: ["commercial.clothing.shoes"], precision: "narrow" },
  { conceptId: "retail.furniture", categoryIds: ["commercial.furniture_and_interior"], precision: "broad" },
  { conceptId: "retail.building_materials", categoryIds: ["commercial.houseware_and_hardware.building_materials"], precision: "narrow" },
  { conceptId: "retail.electronics", categoryIds: ["commercial.elektronics"], precision: "narrow", notes: "Geoapify's official category ID intentionally uses the spelling 'elektronics'." },
  { conceptId: "retail.pet_store", categoryIds: ["commercial.pet"], precision: "narrow" },
  { conceptId: "food.restaurant", categoryIds: ["catering.restaurant"], precision: "narrow" },
  { conceptId: "food.cafe", categoryIds: ["catering.cafe"], precision: "narrow" },
  { conceptId: "food.fast_food", categoryIds: ["catering.fast_food"], precision: "narrow" },
  { conceptId: "hospitality.hotel", categoryIds: ["accommodation.hotel"], precision: "narrow" },
  { conceptId: "hospitality.hostel", categoryIds: ["accommodation.hostel"], precision: "narrow" },
  { conceptId: "business.coworking", categoryIds: ["office.coworking"], precision: "narrow" },
  { conceptId: "business.real_estate_agency", categoryIds: ["office.estate_agent", "service.estate_agent"], precision: "narrow" },
  { conceptId: "professional.law_firm", categoryIds: ["office.lawyer"], precision: "narrow" },
  { conceptId: "professional.accounting", categoryIds: ["office.accountant"], precision: "narrow" },
  { conceptId: "technology.it_company", categoryIds: ["office.it"], precision: "broad" },
  { conceptId: "marketing.advertising_agency", categoryIds: ["office.advertising_agency"], precision: "narrow" },
  { conceptId: "services.cleaning", categoryIds: ["service.cleaning"], precision: "broad" },
  { conceptId: "services.laundry", categoryIds: ["service.cleaning.laundry", "service.cleaning.dry_cleaning"], precision: "narrow" },
  { conceptId: "services.photography", categoryIds: ["service.photographer"], precision: "narrow" },
  { conceptId: "travel.travel_agency", categoryIds: ["office.travel_agent", "service.travel_agency"], precision: "narrow" },
  { conceptId: "mobility.car_rental", categoryIds: ["rental.car"], precision: "narrow" },
  { conceptId: "education.driving_school", categoryIds: ["education.driving_school"], precision: "narrow" },
  { conceptId: "education.language_school", categoryIds: ["education.language_school"], precision: "narrow" },
] as const satisfies readonly GeoapifyConceptBinding[];

const ALLOWED_CATEGORY_IDS = new Set<string>(GEOAPIFY_CATEGORY_IDS);
const BINDING_BY_CONCEPT = new Map(
  GEOAPIFY_CONCEPT_BINDINGS.map((binding) => [binding.conceptId, binding]),
);

export type CompiledGeoapifySelectors = {
  provider: "geoapify";
  providerCatalogVersion: string;
  conceptIds: CanonicalConceptId[];
  categoryIds: GeoapifyCategoryId[];
  broadConceptIds: CanonicalConceptId[];
};

export type GeoapifyCapabilityProvenance = {
  semanticField: "precision" | "recall";
  semanticTerm: string;
  match: "exact_leaf" | "exact_path" | "parent";
  categoryId: string;
};

export type GeoapifyCapabilityBatch = {
  id: "precision" | "broad";
  mode: "precision" | "broad";
  categoryIds: string[];
  provenance: GeoapifyCapabilityProvenance[];
};

export type CompiledGeoapifyCapabilityPlan = {
  provider: "geoapify";
  providerCatalogVersion: string;
  registryChecksum: string;
  categoryIds: string[];
  batches: GeoapifyCapabilityBatch[];
};

export function isGeoapifyCategoryId(value: string): value is GeoapifyCategoryId {
  return ALLOWED_CATEGORY_IDS.has(value);
}

export function getGeoapifyBinding(
  conceptId: string,
): GeoapifyConceptBinding | undefined {
  return BINDING_BY_CONCEPT.get(conceptId as CanonicalConceptId);
}

export function compileGeoapifySelectors(
  conceptIds: readonly string[],
): CompiledGeoapifySelectors {
  const normalizedIds = [...new Set(conceptIds)];
  if (!normalizedIds.length) {
    throw new Error("At least one canonical concept is required");
  }

  const bindings = normalizedIds.map((conceptId) => {
    if (!getCanonicalConcept(conceptId)) {
      throw new Error(`Unknown canonical concept: ${conceptId}`);
    }
    const binding = getGeoapifyBinding(conceptId);
    if (!binding) {
      throw new Error(`Canonical concept has no Geoapify binding: ${conceptId}`);
    }
    return binding;
  });

  const categoryIds = [
    ...new Set(bindings.flatMap((binding) => binding.categoryIds)),
  ];
  if (categoryIds.some((categoryId) => !isGeoapifyCategoryId(categoryId))) {
    throw new Error("Provider catalog contains a non-allowlisted category");
  }

  return {
    provider: "geoapify",
    providerCatalogVersion: GEOAPIFY_PROVIDER_CATALOG_VERSION,
    conceptIds: bindings.map((binding) => binding.conceptId),
    categoryIds,
    broadConceptIds: bindings
      .filter((binding) => binding.precision === "broad")
      .map((binding) => binding.conceptId),
  };
}

const MAX_CATEGORIES_PER_BATCH = 8;
const MAX_TERM_CACHE_ENTRIES = 500;

function normalizedCapabilityToken(value: string): string {
  const token = value.toLocaleLowerCase("en-US");
  if (token === "centre" || token === "centres" || token === "centers") return "center";
  if (token === "sports") return "sport";
  if (token === "gyms") return "gym";
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && token.length > 4) return token.slice(0, -1);
  return token;
}

function capabilityTokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[_./-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizedCapabilityToken);
}

function normalizedCapabilityPhrase(value: string): string {
  return capabilityTokens(value).join(" ");
}

type CapabilityCandidate = {
  categoryId: string;
  score: number;
  provenance: GeoapifyCapabilityProvenance;
};

type IndexedCapability = {
  categoryId: string;
  segments: string[];
  leafPhrase: string;
  pathPhrase: string;
  pathTokens: Set<string>;
  hasChildren: boolean;
};

const CAPABILITY_PARENT_IDS = new Set(
  GEOAPIFY_CATEGORY_IDS.flatMap((categoryId) => {
    const segments = categoryId.split(".");
    return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("."));
  }),
);
const CAPABILITY_INDEX: readonly IndexedCapability[] = GEOAPIFY_CATEGORY_IDS.map(
  (categoryId) => {
    const segments = categoryId.split(".");
    const pathPhrase = normalizedCapabilityPhrase(categoryId);
    return {
      categoryId,
      segments,
      leafPhrase: normalizedCapabilityPhrase(segments.at(-1) ?? ""),
      pathPhrase,
      pathTokens: new Set(pathPhrase.split(" ").filter(Boolean)),
      hasChildren: CAPABILITY_PARENT_IDS.has(categoryId),
    };
  },
);
const CAPABILITY_TERM_CACHE = new Map<
  string,
  Array<Omit<CapabilityCandidate, "provenance"> & { match: GeoapifyCapabilityProvenance["match"] }>
>();

function rememberTermCandidates(
  termPhrase: string,
  candidates: Array<Omit<CapabilityCandidate, "provenance"> & { match: GeoapifyCapabilityProvenance["match"] }>,
) {
  if (CAPABILITY_TERM_CACHE.size >= MAX_TERM_CACHE_ENTRIES) {
    const oldest = CAPABILITY_TERM_CACHE.keys().next().value;
    if (oldest) CAPABILITY_TERM_CACHE.delete(oldest);
  }
  CAPABILITY_TERM_CACHE.set(termPhrase, candidates);
}

function candidatesForTerm(
  semanticField: "precision" | "recall",
  semanticTerm: string,
): CapabilityCandidate[] {
  const termPhrase = normalizedCapabilityPhrase(semanticTerm);
  const termTokens = termPhrase.split(" ").filter(Boolean);
  if (!termPhrase || !termTokens.length) return [];
  const cached = CAPABILITY_TERM_CACHE.get(termPhrase);
  if (cached) {
    return cached.map((candidate) => ({
      categoryId: candidate.categoryId,
      score: candidate.score,
      provenance: {
        semanticField,
        semanticTerm,
        match: candidate.match,
        categoryId: candidate.categoryId,
      },
    }));
  }
  const baseCandidates: Array<
    Omit<CapabilityCandidate, "provenance"> & { match: GeoapifyCapabilityProvenance["match"] }
  > = [];
  const exactLeafMatches = CAPABILITY_INDEX.filter(
    (entry) => entry.leafPhrase === termPhrase,
  );
  const rootMatch = exactLeafMatches.find((entry) => entry.segments.length === 1);

  for (const entry of CAPABILITY_INDEX) {
    const { categoryId, segments, leafPhrase, pathPhrase, pathTokens, hasChildren } = entry;
    // Top-level provider roots are too broad to be actionable lead searches.
    if (segments.length === 1) continue;
    let match: GeoapifyCapabilityProvenance["match"] | null = null;
    let score = 0;
    if (termPhrase === leafPhrase) {
      if (termTokens.length === 1 && rootMatch) continue;
      match = hasChildren ? "parent" : "exact_leaf";
      score = hasChildren ? 100 - segments.length : 110 + segments.length;
    } else if (termPhrase === pathPhrase) {
      match = "exact_path";
      score = 105 + segments.length;
    } else if (
      termTokens.length >= 2 &&
      termTokens.every((token) => pathTokens.has(token))
    ) {
      match = segments.length <= 2 ? "parent" : "exact_path";
      score = 70 + termTokens.length * 5 + segments.length;
    }
    if (!match) continue;
    baseCandidates.push({
      categoryId,
      score,
      match,
    });
  }
  rememberTermCandidates(termPhrase, baseCandidates);
  return baseCandidates.map((candidate) => ({
    categoryId: candidate.categoryId,
    score: candidate.score,
    provenance: {
      semanticField,
      semanticTerm,
      match: candidate.match,
      categoryId: candidate.categoryId,
    },
  }));
}

function bestCapabilityCandidates(
  field: "precision" | "recall",
  terms: readonly string[],
): CapabilityCandidate[] {
  const bestByCategory = new Map<string, CapabilityCandidate>();
  for (const term of terms) {
    for (const candidate of candidatesForTerm(field, term)) {
      const current = bestByCategory.get(candidate.categoryId);
      if (!current || candidate.score > current.score) {
        bestByCategory.set(candidate.categoryId, candidate);
      }
    }
  }
  return [...bestByCategory.values()]
    .sort((left, right) => right.score - left.score || left.categoryId.localeCompare(right.categoryId))
    .slice(0, MAX_CATEGORIES_PER_BATCH);
}

/**
 * Deterministically compiles open semantic terms against the full provider
 * registry. Kimi supplies language, not provider IDs; every resulting ID is
 * looked up again in the pinned registry before it reaches the adapter.
 */
export function compileGeoapifySemanticIntent(
  semanticIntent: SemanticIntentV2,
): CompiledGeoapifyCapabilityPlan {
  const precisionTerms = [
    ...semanticIntent.retrievalTerms.precision,
    ...semanticIntent.coreBusinessTypes,
    ...semanticIntent.productsAndServices,
  ];
  const recallTerms = [
    ...semanticIntent.retrievalTerms.recall,
    ...semanticIntent.adjacentBusinessTypes,
    ...semanticIntent.industries,
  ];
  const exclusionTerms = [
    ...semanticIntent.retrievalTerms.exclude,
    ...semanticIntent.excludedBusinessTypes,
    ...semanticIntent.excludeSignals,
  ];
  const excludedCategoryIds = new Set(
    exclusionTerms.flatMap((term) =>
      candidatesForTerm("precision", term).map((candidate) => candidate.categoryId),
    ),
  );
  const conflictsWithExclusion = (categoryId: string) =>
    [...excludedCategoryIds].some(
      (excludedId) =>
        categoryId === excludedId ||
        categoryId.startsWith(`${excludedId}.`) ||
        excludedId.startsWith(`${categoryId}.`),
    );
  const precision = bestCapabilityCandidates("precision", precisionTerms)
    .filter((candidate) => !conflictsWithExclusion(candidate.categoryId));
  const precisionIds = new Set(precision.map((candidate) => candidate.categoryId));
  const broad = bestCapabilityCandidates("recall", recallTerms)
    .filter(
      (candidate) =>
        !precisionIds.has(candidate.categoryId) &&
        !conflictsWithExclusion(candidate.categoryId),
    );
  const batches: GeoapifyCapabilityBatch[] = [];
  if (precision.length) {
    batches.push({
      id: "precision",
      mode: "precision",
      categoryIds: precision.map((candidate) => candidate.categoryId),
      provenance: precision.map((candidate) => candidate.provenance),
    });
  }
  if (broad.length) {
    batches.push({
      id: "broad",
      mode: "broad",
      categoryIds: broad.map((candidate) => candidate.categoryId),
      provenance: broad.map((candidate) => candidate.provenance),
    });
  }
  const categoryIds = [...new Set(batches.flatMap((batch) => batch.categoryIds))];
  if (categoryIds.some((categoryId) => !isGeoapifyCategoryId(categoryId))) {
    throw new Error("Semantic compiler produced a category outside the provider registry");
  }
  return {
    provider: "geoapify",
    providerCatalogVersion: GEOAPIFY_PROVIDER_CATALOG_VERSION,
    registryChecksum: GEOAPIFY_CAPABILITY_REGISTRY.checksum,
    categoryIds,
    batches,
  };
}

export function validateGeoapifyCatalogCoverage(): {
  valid: boolean;
  missingConceptIds: string[];
  unknownBindingConceptIds: string[];
  unknownCategoryIds: string[];
} {
  const taxonomyIds = new Set<string>(CANONICAL_CONCEPT_IDS);
  const missingConceptIds = CANONICAL_CONCEPT_IDS.filter(
    (conceptId) => !BINDING_BY_CONCEPT.has(conceptId),
  );
  const unknownBindingConceptIds = GEOAPIFY_CONCEPT_BINDINGS
    .map((binding) => binding.conceptId)
    .filter((conceptId) => !taxonomyIds.has(conceptId));
  const unknownCategoryIds = GEOAPIFY_CONCEPT_BINDINGS
    .flatMap((binding) => binding.categoryIds)
    .filter((categoryId) => !ALLOWED_CATEGORY_IDS.has(categoryId));

  return {
    valid:
      missingConceptIds.length === 0 &&
      unknownBindingConceptIds.length === 0 &&
      unknownCategoryIds.length === 0,
    missingConceptIds,
    unknownBindingConceptIds,
    unknownCategoryIds,
  };
}
