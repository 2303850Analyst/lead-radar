import type {
  CompiledGeoapifyCapabilityPlan,
  GeoapifyCapabilityBatch,
} from "./search-planner/catalogs/geoapify";
import {
  applyGeoapifyNativeResolution,
} from "./search-planner/catalogs/geoapify";
import type {
  SearchPlanExecutionPreview,
  SupportedCountryCode,
} from "./search-planner/types";
import type { CompiledGeoapifyPlan } from "./providers/types";
import { selectGeoapifyCategoryHints } from "./providers/geoapify-category-resolver";
import { canonicalJson, type CanonicalJsonValue } from "./search-planner/hashing";

const SOURCE_FALLBACK_ORIGINS = new Set([
  "source.primaryQuery",
  "source.relatedQueries",
]);

export type GeoapifyNativeRecoveryAuthorization = Readonly<{
  kind: "geoapify_source_native_v1";
  planArmId: string;
  capabilityPlan: GeoapifyNativeRecoveryCapabilityPlan;
  executionPreview: SearchPlanExecutionPreview;
}>;

export type GeoapifyNativeRecoveryCapabilityPlan = Readonly<{
  provider: "geoapify";
  providerCatalogVersion: string;
  registryChecksum: string;
  categoryIds: string[];
  batches: GeoapifyCapabilityBatch[];
  limits: {
    maxArms: number;
    maxUpstreamRequests: number;
    maxCards: number;
    maxDetails: number;
  };
  exclusionTerms: string[];
}>;

export type GeoapifyAutocompleteRequest = Readonly<{
  text: string;
  center: readonly [number, number];
  radiusMeters: number;
  countryCode: SupportedCountryCode;
  language: "ru" | "be" | "kk";
  limit: 5;
  timeoutMs: number;
  signal?: AbortSignal;
}>;

export type GeoapifyCategoryObservation = Readonly<{
  categoryId: string | null;
  countryCode: string | null;
  coordinates: readonly [number, number] | null;
  providerPlaceId: string | null;
}>;

export type GeoapifyAutocompleteFailureCode =
  | "forbidden"
  | "rate_limited"
  | "timeout"
  | "network"
  | "upstream"
  | "invalid_response";

export type GeoapifyAutocompleteResult =
  | Readonly<{
      kind: "observations";
      observations: readonly GeoapifyCategoryObservation[];
    }>
  | Readonly<{
      kind: "failure";
      code: GeoapifyAutocompleteFailureCode;
    }>;

export interface GeoapifyAutocompletePort {
  autocomplete(
    request: GeoapifyAutocompleteRequest,
  ): Promise<GeoapifyAutocompleteResult>;
}

export class GeoapifyNativeRecoveryError extends Error {
  constructor(
    readonly code:
      | "invalid_authorization"
      | "budget"
      | "no_match"
      | GeoapifyAutocompleteFailureCode,
    readonly requests: 0 | 1,
  ) {
    super("Geoapify native category recovery did not authorize retrieval");
    this.name = "GeoapifyNativeRecoveryError";
  }
}

function sourceFallbackArm(
  arm: CompiledGeoapifyPlan["batches"][number] | GeoapifyCapabilityBatch,
): boolean {
  return (
    arm.type === "fallback" &&
    arm.role === "fallback" &&
    typeof arm.nameQuery === "string" &&
    arm.nameQuery.length > 0 &&
    arm.categoryIds.length > 0 &&
    arm.provenance.length === arm.categoryIds.length &&
    arm.provenance.every(
      (item) =>
        item.semanticField === "fallback" &&
        item.match === "name_fallback" &&
        SOURCE_FALLBACK_ORIGINS.has(item.origin) &&
        item.semanticTerm === arm.nameQuery &&
        arm.categoryIds.includes(item.categoryId),
    )
  );
}

function isSourceFallbackOrigin(
  value: string,
): value is "source.primaryQuery" | "source.relatedQueries" {
  return SOURCE_FALLBACK_ORIGINS.has(value);
}

function copySourceFallbackArm(
  arm: CompiledGeoapifyPlan["batches"][number] | GeoapifyCapabilityBatch,
): GeoapifyCapabilityBatch {
  return {
    id: arm.id,
    type: "fallback",
    mode: "broad",
    role: "fallback",
    priority: arm.priority,
    resultBudget: arm.resultBudget,
    categoryIds: [...arm.categoryIds],
    nameQuery: arm.nameQuery,
    provenance: arm.provenance.map((item) => {
      if (!isSourceFallbackOrigin(item.origin)) {
        throw new Error("Native recovery projection received an invalid origin");
      }
      return {
        semanticField: "fallback",
        semanticTerm: item.semanticTerm,
        origin: item.origin,
        match: "name_fallback",
        categoryId: item.categoryId,
      };
    }),
  };
}

export function projectGeoapifyNativeRecovery(
  capabilityPlan:
    | CompiledGeoapifyCapabilityPlan
    | CompiledGeoapifyPlan
    | GeoapifyNativeRecoveryCapabilityPlan,
): GeoapifyNativeRecoveryAuthorization | null {
  const arm = [...capabilityPlan.batches]
    .sort((left, right) => left.priority - right.priority)
    .find(sourceFallbackArm);
  if (!arm) return null;

  const projectedArm = copySourceFallbackArm(arm);
  const projectedPlan: GeoapifyNativeRecoveryCapabilityPlan = {
    provider: "geoapify",
    providerCatalogVersion: capabilityPlan.providerCatalogVersion,
    registryChecksum: capabilityPlan.registryChecksum,
    categoryIds: [...projectedArm.categoryIds],
    batches: [projectedArm],
    limits: { ...capabilityPlan.limits },
    exclusionTerms: [...capabilityPlan.exclusionTerms],
  };
  const executionPreview: SearchPlanExecutionPreview = {
    provider: "geoapify",
    categoryLabels: [...projectedArm.categoryIds],
    batches: 1,
    retrievalArms: [{
      id: projectedArm.id,
      type: projectedArm.type,
      role: projectedArm.role,
      priority: projectedArm.priority,
      resultBudget: projectedArm.resultBudget,
      categoryLabels: [...projectedArm.categoryIds],
      usesNameFallback: true,
      provenance: projectedArm.provenance.map((item) => ({ ...item })),
    }],
  };
  return {
    kind: "geoapify_source_native_v1",
    planArmId: projectedArm.id,
    capabilityPlan: projectedPlan,
    executionPreview,
  };
}

export async function resolveGeoapifyNativeRecovery(
  input: Readonly<{
    authorization: GeoapifyNativeRecoveryAuthorization;
    center: readonly [number, number];
    radiusMeters: number;
    countryCode: SupportedCountryCode;
    language: "ru" | "be" | "kk";
    timeoutMs: number;
    signal?: AbortSignal;
  }>,
  port: GeoapifyAutocompletePort,
) {
  const projected = projectGeoapifyNativeRecovery(
    input.authorization.capabilityPlan,
  );
  if (
    !projected ||
    canonicalJson(projected as unknown as CanonicalJsonValue) !==
      canonicalJson(input.authorization as unknown as CanonicalJsonValue)
  ) {
    throw new GeoapifyNativeRecoveryError("invalid_authorization", 0);
  }
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 300) {
    throw new GeoapifyNativeRecoveryError("budget", 0);
  }
  const fallback = input.authorization.capabilityPlan.batches[0];
  const result = await port.autocomplete({
    text: fallback.nameQuery!,
    center: input.center,
    radiusMeters: input.radiusMeters,
    countryCode: input.countryCode,
    language: input.language,
    limit: 5,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  if (result.kind === "failure") {
    throw new GeoapifyNativeRecoveryError(result.code, 1);
  }
  const categoryIds = selectGeoapifyCategoryHints(
    result.observations.slice(0, 5).map((observation) => ({
      properties: {
        category: observation.categoryId,
        country_code: observation.countryCode,
        place_id: observation.providerPlaceId,
      },
      geometry: {
        type: "Point",
        coordinates: observation.coordinates,
      },
    })),
    {
      center: input.center,
      radiusMeters: input.radiusMeters,
      countryCode: input.countryCode,
    },
  );
  const categoryPlan = applyGeoapifyNativeResolution(
    input.authorization.capabilityPlan,
    categoryIds,
  );
  const runtimeArm = categoryPlan.batches[0];
  if (!categoryIds.length || runtimeArm.id === input.authorization.planArmId) {
    throw new GeoapifyNativeRecoveryError("no_match", 1);
  }
  return {
    categoryPlan,
    armBinding: {
      planArmId: input.authorization.planArmId,
      runtimeArmId: runtimeArm.id,
    },
    categoryResolution: {
      status: "resolved" as const,
      requests: 1 as const,
    },
  };
}
