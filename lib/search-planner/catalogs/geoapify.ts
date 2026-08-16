import {
  CANONICAL_CONCEPT_IDS,
  type CanonicalConceptId,
  getCanonicalConcept,
} from "../taxonomy";

export const GEOAPIFY_PROVIDER_CATALOG_VERSION = "2026-08-16.1";

/**
 * IDs verified against Geoapify's official Places category catalog on
 * 2026-08-16. Keep this allowlist provider-specific and code-reviewed.
 */
export const GEOAPIFY_CATEGORY_IDS = [
  "office.logistics",
  "rental.storage",
  "service.beauty.hairdresser",
  "service.beauty",
  "healthcare.dentist",
  "healthcare.clinic_or_praxis",
  "healthcare.pharmacy",
  "service.vehicle.repair",
  "service.vehicle.car_wash",
  "service.vehicle.fuel",
  "service.vehicle.charging_station",
  "commercial.supermarket",
  "commercial.convenience",
  "commercial.food_and_drink.bakery",
  "commercial.food_and_drink.butcher",
  "commercial.florist",
  "commercial.clothing.clothes",
  "commercial.clothing.shoes",
  "commercial.furniture_and_interior",
  "commercial.houseware_and_hardware.building_materials",
  "commercial.elektronics",
  "commercial.pet",
  "catering.restaurant",
  "catering.cafe",
  "catering.fast_food",
  "accommodation.hotel",
  "accommodation.hostel",
  "office.coworking",
  "office.estate_agent",
  "service.estate_agent",
  "office.lawyer",
  "office.accountant",
  "office.it",
  "office.advertising_agency",
  "service.cleaning",
  "service.cleaning.laundry",
  "service.cleaning.dry_cleaning",
  "service.photographer",
  "office.travel_agent",
  "service.travel_agency",
  "rental.car",
  "education.driving_school",
  "education.language_school",
] as const;

export type GeoapifyCategoryId = (typeof GEOAPIFY_CATEGORY_IDS)[number];

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
