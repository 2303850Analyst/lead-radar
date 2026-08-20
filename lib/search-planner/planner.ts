import "server-only";

import {
  ConfirmationTokenError,
  issueConfirmationToken,
  verifyConfirmationToken,
} from "./confirmation-token";
import {
  compileGeoapifySemanticIntent,
  compileGeoapifySelectors,
  GEOAPIFY_CAPABILITY_REGISTRY,
  GEOAPIFY_COMPILER_POLICY_VERSION,
  GEOAPIFY_PROVIDER_CATALOG_VERSION,
  geoapifyPlanGroundsProviderNeutralCategoryHeads,
  type CompiledGeoapifyCapabilityPlan,
} from "./catalogs/geoapify";
import { hashCanonicalJson, type CanonicalJsonValue } from "./hashing";
import {
  createKimiClientFromEnv,
  KIMI_MODEL_POLICY_VERSION,
  KimiClientError,
  type KimiClient,
} from "./kimi-client";
import {
  normalizePlannerInput,
  resolveDeterministically,
} from "./resolver";
import { validateKimiSemanticIntent } from "./schema";
import {
  KimiSchedulerError,
  createTier0KimiScheduler,
  type KimiSchedulerMetrics,
  type Tier0KimiScheduler,
} from "./scheduler";
import {
  CANONICAL_TAXONOMY_VERSION,
  canonicalConceptLabel,
  isCanonicalConceptId,
} from "./taxonomy";
import {
  SEARCH_PLAN_SCHEMA_VERSION,
  SEMANTIC_INTENT_SCHEMA_VERSION,
  type ConfirmedSemanticAlternative,
  type ConfidenceBand,
  type KimiEncodeResult,
  type NormalizedSearchIntent,
  type PlannerInput,
  type PlannerMode,
  type ResolutionReasonCode,
  type SearchPlan,
  type SearchPlanAiMetadata,
  type SearchPlanAlternative,
  type SearchPlanExecutionPreview,
  type SemanticIntentV2,
} from "./types";

export const DECISION_POLICY_VERSION = "2026-08-20.3";
export const KIMI_PROMPT_CONTENT_VERSION =
  "semantic-intent-v2/2026-08-20.7";
export const KIMI_PROMPT_VERSION =
  `${KIMI_PROMPT_CONTENT_VERSION}+${KIMI_MODEL_POLICY_VERSION}`;
export const SEARCH_PLAN_RUNTIME_CACHE_TTL_MS = 10 * 60 * 1_000;
export const SEARCH_PLAN_RUNTIME_CACHE_MAX_ENTRIES = 200;

const CURRENT_KIMI_PROMPT_VERSIONS = new Set([
  KIMI_PROMPT_VERSION,
  ...["low", "high", "max"].map(
    (effort) => `${KIMI_PROMPT_VERSION}:kimi-k3:k3-reasoning:${effort}`,
  ),
  `${KIMI_PROMPT_VERSION}:kimi-k2.6:k2.6-thinking-disabled:none`,
]);

export type PlannerKimiClient = Pick<KimiClient, "modelId" | "encode"> &
  Partial<Pick<KimiClient, "cacheIdentity">>;

export type CreateSearchPlanOptions = {
  mode?: PlannerMode;
  kimiClient?: PlannerKimiClient | null;
  signingSecret?: string | null;
  confirmationTtlSeconds?: number;
  signal?: AbortSignal;
  now?: Date;
};

export type CreateSearchPlanFromEnvOptions = Omit<
  CreateSearchPlanOptions,
  "mode" | "kimiClient" | "signingSecret"
> & {
  scheduler?: Tier0KimiScheduler;
};

export type ConfirmSearchPlanRequest = {
  input: PlannerInput;
  confirmationToken: string;
  selectedAlternative: ConfirmedSemanticAlternative;
};

export type ConfirmSearchPlanOptions = {
  signingSecret: string;
  now?: Date;
};

const PLANNER_INFRASTRUCTURE_FAILURE_REASONS = new Set<ResolutionReasonCode>([
  "KIMI_UNAVAILABLE",
  "KIMI_INVALID_RESPONSE",
  "KIMI_ADMISSION_TIMEOUT",
]);

/**
 * Distinguishes an unavailable semantic planner from a genuinely unsupported
 * business intent. API routes use this to return a retryable 503 instead of
 * incorrectly presenting an infrastructure failure as a taxonomy decision.
 */
export function isSearchPlannerInfrastructureFailure(plan: SearchPlan): boolean {
  const missingConfirmationCapability =
    plan.status === "needs_confirmation" &&
    plan.resolution.alternatives.length > 0 &&
    !plan.confirmation.token;
  return (
    missingConfirmationCapability ||
    (plan.status === "unsupported" &&
      plan.resolution.method === "fallback" &&
      plan.resolution.reasonCodes.some((reason) =>
        PLANNER_INFRASTRUCTURE_FAILURE_REASONS.has(reason),
      ))
  );
}

type PlanDraft = Omit<SearchPlan, "planHash" | "confirmation">;

type CachedSearchPlan = {
  plan: SearchPlan;
  expiresAtMs: number;
};

const runtimePlanCache = new Map<string, CachedSearchPlan>();
let runtimeKimiScheduler: Tier0KimiScheduler | null = null;
let runtimeKimiSchedulerConfigKey = "";
const runtimeCacheMetrics = {
  hits: 0,
  misses: 0,
  evictions: 0,
};

const AI_NOT_USED: SearchPlanAiMetadata = {
  used: false,
  modelId: null,
  latencyMs: null,
  inputTokens: null,
  outputTokens: null,
  finishReason: null,
  validation: "not_used",
  cacheHit: false,
};

function plannerModeFromValue(value: string | undefined): PlannerMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === "kimi" ? "kimi" : "deterministic";
}

export function plannerModeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PlannerMode {
  return plannerModeFromValue(env.QUERY_INTELLIGENCE_MODE);
}

export function plannerInputCacheMaterial(
  intent: NormalizedSearchIntent,
): CanonicalJsonValue {
  return {
    schemaVersion: SEARCH_PLAN_SCHEMA_VERSION,
    taxonomyVersion: CANONICAL_TAXONOMY_VERSION,
    providerCatalogVersion: GEOAPIFY_PROVIDER_CATALOG_VERSION,
    providerCatalogChecksum: GEOAPIFY_CAPABILITY_REGISTRY.checksum,
    compilerPolicyVersion: GEOAPIFY_COMPILER_POLICY_VERSION,
    decisionPolicyVersion: DECISION_POLICY_VERSION,
    intent: intent as unknown as CanonicalJsonValue,
  };
}

export async function createRequestCacheKey(
  intent: NormalizedSearchIntent,
): Promise<string> {
  return hashCanonicalJson(plannerInputCacheMaterial(intent));
}

function semanticIntentForConcept(
  conceptId: string,
  intent: NormalizedSearchIntent,
): SemanticIntentV2 {
  const selectors = compileGeoapifySelectors([conceptId]);
  const label = canonicalConceptLabel(conceptId, intent.locale);
  const capabilityTerms = selectors.categoryIds.map((categoryId) =>
    categoryId.replaceAll(".", " ").replaceAll("_", " "),
  );
  const conceptTerm = conceptId.split(".").at(-1)?.replaceAll("_", " ") ?? conceptId;
  const englishTerms = [...new Set([conceptTerm, ...capabilityTerms])];
  return {
    schemaVersion: SEMANTIC_INTENT_SCHEMA_VERSION,
    normalizedGoal: `найти ${label}`,
    entityKind: "physical_business",
    physicalLocationRequirement: "required",
    industries: [...new Set(capabilityTerms.map((term) => term.split(" ")[0]))],
    coreBusinessTypes: [label, conceptTerm],
    adjacentBusinessTypes: [],
    excludedBusinessTypes: [...intent.excludeQueries],
    productsAndServices: [],
    includeSignals: [label, conceptTerm],
    excludeSignals: [...intent.excludeQueries],
    retrievalTerms: {
      precision: englishTerms,
      recall: englishTerms,
      exclude: [...intent.excludeQueries],
    },
    brandSearch: "include",
    confidence: "medium",
    ambiguity: {
      isAmbiguous: false,
      reason: null,
      clarificationQuestion: null,
    },
  };
}

export async function createSemanticAlternativeHash(
  semanticIntent: SemanticIntentV2,
): Promise<string> {
  return hashCanonicalJson({
    semanticIntentSchemaVersion: SEMANTIC_INTENT_SCHEMA_VERSION,
    providerCatalogVersion: GEOAPIFY_PROVIDER_CATALOG_VERSION,
    providerCatalogChecksum: GEOAPIFY_CAPABILITY_REGISTRY.checksum,
    compilerPolicyVersion: GEOAPIFY_COMPILER_POLICY_VERSION,
    decisionPolicyVersion: DECISION_POLICY_VERSION,
    semanticIntent: semanticIntent as unknown as CanonicalJsonValue,
  });
}

async function alternativesFromIds(
  ids: readonly string[],
  intent: NormalizedSearchIntent,
  reasonCodes: readonly ResolutionReasonCode[],
): Promise<SearchPlanAlternative[]> {
  const alternatives = [...new Set(ids)]
    .filter(isCanonicalConceptId)
    .slice(0, 3)
    .map(async (conceptId) => {
      const semanticIntent = semanticIntentForConcept(conceptId, intent);
      const capabilityPlan = compileGeoapifySemanticIntent(semanticIntent, intent);
      const preview = semanticExecutionPreview(capabilityPlan);
      if (!preview) return null;
      const alternativeHash = await createSemanticAlternativeHash(semanticIntent);
      const label = canonicalConceptLabel(conceptId, intent.locale);
      return {
        alternativeId: `alt-${alternativeHash.slice(0, 16)}`,
        alternativeHash,
        label,
        explanation: `Искать физические организации формата «${label}»`,
        semanticIntent,
        executionPreview: preview,
        reasonCodes: [...reasonCodes],
      } satisfies SearchPlanAlternative;
    });
  const resolved = (await Promise.all(alternatives)).filter(
    (alternative): alternative is SearchPlanAlternative => Boolean(alternative),
  );
  const seenPreviews = new Set<string>();
  return resolved.filter((alternative) => {
    const signature = JSON.stringify(
      [...alternative.executionPreview.categoryLabels].sort(),
    );
    if (seenPreviews.has(signature)) return false;
    seenPreviews.add(signature);
    return true;
  });
}

function executionPreview(selectedConceptIds: readonly string[]): SearchPlan["executionPreview"] {
  if (!selectedConceptIds.length) return null;
  const selectors = compileGeoapifySelectors(selectedConceptIds);
  return {
    provider: "geoapify",
    categoryLabels: [...selectors.categoryIds],
    batches: selectors.categoryIds.length ? 1 : 0,
    retrievalArms: [{
      id: "arm-legacy-00000000",
      type: "legacy",
      role: "primary",
      priority: 1,
      resultBudget: 80,
      categoryLabels: [...selectors.categoryIds],
      usesNameFallback: false,
      provenance: selectors.categoryIds.map((categoryId) => ({
        semanticField: "legacy",
        semanticTerm: categoryId,
        origin: "legacy",
        match: "legacy_binding",
        categoryId,
      })),
    }],
  };
}

function semanticExecutionPreview(
  capabilityPlan: CompiledGeoapifyCapabilityPlan,
): SearchPlan["executionPreview"] {
  if (!capabilityPlan.categoryIds.length || !capabilityPlan.batches.length) return null;
  return {
    provider: "geoapify",
    categoryLabels: [...capabilityPlan.categoryIds],
    batches: capabilityPlan.batches.length,
    retrievalArms: capabilityPlan.batches.map((arm) => ({
      id: arm.id,
      type: arm.type,
      role: arm.role,
      priority: arm.priority,
      resultBudget: arm.resultBudget,
      categoryLabels: [...arm.categoryIds],
      usesNameFallback: Boolean(arm.nameQuery),
      provenance: arm.provenance.map((item) => ({ ...item })),
    })),
  };
}

function providerNeutralCategoryHeadIsGrounded(
  result: KimiEncodeResult,
  capabilityPlan: CompiledGeoapifyCapabilityPlan,
): boolean {
  const heads = result.providerNeutralCategoryHeads;
  // Scenario adapters produce an already validated internal SemanticIntentV2
  // and remain usable without depending on the production wire contract.
  if (heads === undefined) return true;
  return geoapifyPlanGroundsProviderNeutralCategoryHeads(
    capabilityPlan,
    heads,
  );
}

function aiMetadata(result: KimiEncodeResult): SearchPlanAiMetadata {
  return {
    used: true,
    modelId: result.modelId,
    latencyMs: result.latencyMs,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    finishReason: result.finishReason,
    validation: "passed",
    cacheHit: false,
  };
}

function failedAiMetadata(modelId: string | null): SearchPlanAiMetadata {
  return {
    used: true,
    modelId,
    latencyMs: null,
    inputTokens: null,
    outputTokens: null,
    finishReason: null,
    validation: "failed",
    cacheHit: false,
  };
}

function reasonForKimiFailure(error: unknown): ResolutionReasonCode {
  if (error instanceof KimiSchedulerError) {
    return error.code === "KIMI_ADMISSION_TIMEOUT"
      ? "KIMI_ADMISSION_TIMEOUT"
      : "KIMI_UNAVAILABLE";
  }
  if (error instanceof KimiClientError) {
    if (error.code === "KIMI_TIMEOUT") return "KIMI_ADMISSION_TIMEOUT";
    if (error.code === "KIMI_INVALID_RESPONSE") return "KIMI_INVALID_RESPONSE";
  }
  return "KIMI_UNAVAILABLE";
}

function planHashMaterial(draft: PlanDraft): CanonicalJsonValue {
  return {
    schemaVersion: draft.schemaVersion,
    taxonomyVersion: draft.taxonomyVersion,
    providerCatalogVersion: draft.providerCatalogVersion,
    providerCatalogChecksum: GEOAPIFY_CAPABILITY_REGISTRY.checksum,
    compilerPolicyVersion: GEOAPIFY_COMPILER_POLICY_VERSION,
    decisionPolicyVersion: draft.decisionPolicyVersion,
    promptVersion: draft.promptVersion,
    requestCacheKey: draft.requestCacheKey,
    parentPlanHash: draft.parentPlanHash,
    status: draft.status,
    intent: draft.intent as unknown as CanonicalJsonValue,
    semanticIntent: draft.semanticIntent as unknown as CanonicalJsonValue,
    confidence: draft.confidence as unknown as CanonicalJsonValue,
    resolution: draft.resolution as unknown as CanonicalJsonValue,
    executionPreview: draft.executionPreview as unknown as CanonicalJsonValue,
    ai: {
      used: draft.ai.used,
      modelId: draft.ai.modelId,
      finishReason: draft.ai.finishReason,
      validation: draft.ai.validation,
    },
  };
}

export async function createPlanHash(draft: PlanDraft): Promise<string> {
  return hashCanonicalJson(planHashMaterial(draft));
}

async function finalizePlan(
  draft: PlanDraft,
  options: {
    signingSecret?: string | null;
    confirmationTtlSeconds?: number;
    now?: Date;
  },
): Promise<SearchPlan> {
  const planHash = await createPlanHash(draft);
  let confirmation: SearchPlan["confirmation"] = {
    token: null,
    expiresAt: null,
  };
  if (
    draft.status === "needs_confirmation" &&
    draft.resolution.alternatives.length > 0 &&
    options.signingSecret
  ) {
    const issued = await issueConfirmationToken({
      secret: options.signingSecret,
      requestCacheKey: draft.requestCacheKey,
      sourcePlanHash: planHash,
      allowedAlternativeHashes: draft.resolution.alternatives.map(
        (alternative) => alternative.alternativeHash,
      ),
      searchPlanSchemaVersion: draft.schemaVersion,
      semanticIntentSchemaVersion: draft.semanticIntent.schemaVersion,
      providerCatalogVersion: draft.providerCatalogVersion,
      decisionPolicyVersion: draft.decisionPolicyVersion,
      promptVersion: draft.promptVersion,
      ttlSeconds: options.confirmationTtlSeconds,
      now: options.now,
    });
    confirmation = { token: issued.token, expiresAt: issued.expiresAt };
  }
  return { ...draft, planHash, confirmation };
}

function baseDraft(
  intent: NormalizedSearchIntent,
  requestCacheKey: string,
  semanticIntent: SemanticIntentV2,
  providerCoverage: ConfidenceBand | "unknown" = "unknown",
  promptVersion = KIMI_PROMPT_VERSION,
): Pick<
  PlanDraft,
  | "schemaVersion"
  | "taxonomyVersion"
  | "providerCatalogVersion"
  | "decisionPolicyVersion"
  | "promptVersion"
  | "requestCacheKey"
  | "parentPlanHash"
  | "intent"
  | "semanticIntent"
  | "confidence"
> {
  return {
    schemaVersion: SEARCH_PLAN_SCHEMA_VERSION,
    taxonomyVersion: CANONICAL_TAXONOMY_VERSION,
    providerCatalogVersion: GEOAPIFY_PROVIDER_CATALOG_VERSION,
    decisionPolicyVersion: DECISION_POLICY_VERSION,
    promptVersion,
    requestCacheKey,
    parentPlanHash: null,
    intent,
    semanticIntent,
    confidence: {
      intent: semanticIntent.confidence,
      providerCoverage,
    },
  };
}

function synthesizedSemanticIntent(
  intent: NormalizedSearchIntent,
  confidence: ConfidenceBand = "low",
): SemanticIntentV2 {
  return {
    schemaVersion: SEMANTIC_INTENT_SCHEMA_VERSION,
    normalizedGoal: intent.description || intent.primaryQuery,
    entityKind: "physical_business",
    physicalLocationRequirement: "required",
    industries: [],
    coreBusinessTypes: [intent.primaryQuery],
    adjacentBusinessTypes: [...intent.relatedQueries],
    excludedBusinessTypes: [...intent.excludeQueries],
    productsAndServices: [],
    includeSignals: [intent.primaryQuery, ...intent.relatedQueries],
    excludeSignals: [...intent.excludeQueries],
    retrievalTerms: {
      precision: [intent.primaryQuery],
      recall: [...new Set([intent.primaryQuery, ...intent.relatedQueries])],
      exclude: [...intent.excludeQueries],
    },
    brandSearch: "include",
    confidence,
    ambiguity: {
      isAmbiguous: false,
      reason: null,
      clarificationQuestion: null,
    },
  };
}

function compatibilityIntent(
  source: NormalizedSearchIntent,
  semantic: SemanticIntentV2,
): NormalizedSearchIntent {
  const core = semantic.coreBusinessTypes[0] ?? source.primaryQuery;
  return normalizePlannerInput({
    ...source,
    description: semantic.normalizedGoal,
    primaryQuery: core,
    relatedQueries: [...new Set([
        ...semantic.coreBusinessTypes.slice(1),
        ...semantic.adjacentBusinessTypes,
        ...semantic.productsAndServices,
        ...semantic.retrievalTerms.precision,
        ...semantic.retrievalTerms.recall,
      ])].slice(0, 20),
    excludeQueries: [...new Set([
        ...source.excludeQueries,
        ...semantic.excludedBusinessTypes,
        ...semantic.excludeSignals,
        ...semantic.retrievalTerms.exclude,
      ])].slice(0, 20),
  });
}

function clarificationQuestion(locale: NormalizedSearchIntent["locale"]): string {
  if (locale === "be-BY") return "Удакладніце, якую катэгорыю бізнесу трэба шукаць.";
  if (locale === "kk-KZ") return "Қай бизнес санатын іздеу керегін нақтылаңыз.";
  return "Уточните, какую категорию бизнеса нужно искать.";
}

export async function createSearchPlan(
  input: PlannerInput,
  options: CreateSearchPlanOptions = {},
): Promise<SearchPlan> {
  const intent = normalizePlannerInput(input);
  const requestCacheKey = await createRequestCacheKey(intent);
  const deterministic = resolveDeterministically(intent);
  const mode = options.mode ?? "deterministic";
  const kimiClient = options.kimiClient;
  const promptVersion =
    mode === "kimi" && kimiClient?.cacheIdentity
      ? `${KIMI_PROMPT_CONTENT_VERSION}+${kimiClient.cacheIdentity}`
      : KIMI_PROMPT_VERSION;
  const common = baseDraft(
    intent,
    requestCacheKey,
    synthesizedSemanticIntent(
      intent,
      deterministic.decision === "ready" ? "high" : "low",
    ),
    deterministic.decision === "ready" ? "high" : "unknown",
    promptVersion,
  );
  const signingOptions = {
    signingSecret: options.signingSecret,
    confirmationTtlSeconds: options.confirmationTtlSeconds,
    now: options.now,
  };

  if (
    mode === "deterministic" &&
    deterministic.decision === "ready" &&
    deterministic.selectedConceptId
  ) {
    const selectedConceptIds = [deterministic.selectedConceptId];
    return finalizePlan(
      {
        ...common,
        status: "ready",
        resolution: {
          method: deterministic.method === "exact" ? "exact" : "semantic",
          selectedConceptIds,
          alternatives: [],
          confidenceBand: "high",
          reasonCodes: [
            deterministic.method === "exact" ? "EXACT_ALIAS" : "FUZZY_MATCH",
          ],
          clarificationQuestion: null,
        },
        executionPreview: executionPreview(selectedConceptIds),
        ai: AI_NOT_USED,
      },
      signingOptions,
    );
  }

  const deterministicAlternatives = await alternativesFromIds(
    deterministic.candidates
      .filter((candidate) => !candidate.negativeConflict)
      .map((candidate) => candidate.conceptId),
    intent,
    ["AMBIGUOUS_SCOPE"],
  );
  if (mode === "deterministic") {
    const hasAlternatives = deterministicAlternatives.length > 0;
    return finalizePlan(
      {
        ...common,
        status: hasAlternatives ? "needs_confirmation" : "unsupported",
        resolution: {
          method: "fallback",
          selectedConceptIds: [],
          alternatives: deterministicAlternatives,
          confidenceBand: "unknown",
          reasonCodes: hasAlternatives
            ? ["AMBIGUOUS_SCOPE"]
            : ["NO_SUPPORTED_CONCEPT"],
          clarificationQuestion: hasAlternatives
            ? clarificationQuestion(intent.locale)
            : null,
        },
        executionPreview: null,
        ai: AI_NOT_USED,
      },
      signingOptions,
    );
  }

  if (!kimiClient) {
    if (deterministic.decision === "ready" && deterministic.selectedConceptId) {
      const selectedConceptIds = [deterministic.selectedConceptId];
      return finalizePlan(
        {
          ...common,
          status: "degraded",
          resolution: {
            method: "fallback",
            selectedConceptIds,
            alternatives: [],
            confidenceBand: "high",
            reasonCodes: ["KIMI_UNAVAILABLE"],
            clarificationQuestion: null,
          },
          executionPreview: executionPreview(selectedConceptIds),
          ai: failedAiMetadata(null),
        },
        signingOptions,
      );
    }
    return finalizePlan(
      {
        ...common,
        status: "unsupported",
        resolution: {
          method: "fallback",
          selectedConceptIds: [],
          alternatives: [],
          confidenceBand: "unknown",
          reasonCodes: ["KIMI_UNAVAILABLE"],
          clarificationQuestion: null,
        },
        executionPreview: null,
        ai: failedAiMetadata(null),
      },
      signingOptions,
    );
  }

  try {
    const result = await kimiClient.encode({
      intent,
      signal: options.signal,
    });
    // Revalidate even injected/scenario Kimi adapters so no alternate encoder
    // can bypass the same semantic trust boundary as the production client.
    const semanticIntent = validateKimiSemanticIntent(result.semanticIntent);
    const capabilityPlan = compileGeoapifySemanticIntent(semanticIntent, intent);
    const categoryHeadIsGrounded = providerNeutralCategoryHeadIsGrounded(
      result,
      capabilityPlan,
    );
    const semanticResolution = resolveDeterministically(
      compatibilityIntent(intent, semanticIntent),
    );
    const policyRequiresConfirmation = semanticIntent.ambiguity.isAmbiguous || deterministic.candidates.some(
      (candidate) => candidate.reasonCodes.includes("AMBIGUOUS_SCOPE"),
    );
    const semanticCommon = baseDraft(
      intent,
      requestCacheKey,
      semanticIntent,
      categoryHeadIsGrounded
        ? capabilityPlan.batches.some((batch) => batch.mode === "precision")
          ? "high"
          : capabilityPlan.categoryIds.length
            ? "medium"
            : semanticResolution.decision === "ready"
              ? semanticResolution.method === "exact" ? "high" : "medium"
              : "unknown"
        : "unknown",
      promptVersion,
    );

    if (
      semanticIntent.entityKind === "non_physical" ||
      semanticIntent.physicalLocationRequirement === "not_applicable"
    ) {
      return finalizePlan(
        {
          ...semanticCommon,
          status: "unsupported",
          resolution: {
            method: "kimi",
            selectedConceptIds: [],
            alternatives: [],
            confidenceBand: semanticIntent.confidence,
            reasonCodes: ["PHYSICAL_PLACE_UNCLEAR"],
            clarificationQuestion: semanticIntent.ambiguity.clarificationQuestion,
          },
          executionPreview: null,
          ai: aiMetadata(result),
        },
        signingOptions,
      );
    }

    if (policyRequiresConfirmation) {
      const candidateIds = [
        ...deterministic.candidates.map((candidate) => candidate.conceptId),
        ...semanticResolution.candidates.map((candidate) => candidate.conceptId),
      ];
      return finalizePlan(
        {
          ...semanticCommon,
          status: "needs_confirmation",
          resolution: {
            method: "kimi",
            selectedConceptIds: [],
            alternatives: await alternativesFromIds(
              candidateIds,
              intent,
              ["AMBIGUOUS_SCOPE"],
            ),
            confidenceBand: semanticIntent.confidence,
            reasonCodes: ["AMBIGUOUS_SCOPE"],
            clarificationQuestion:
              semanticIntent.ambiguity.clarificationQuestion ??
              clarificationQuestion(intent.locale),
          },
          executionPreview: null,
          ai: aiMetadata(result),
        },
        signingOptions,
      );
    }

    if (categoryHeadIsGrounded && capabilityPlan.categoryIds.length) {
      const selectedConceptIds =
        semanticResolution.decision === "ready" && semanticResolution.selectedConceptId
          ? [semanticResolution.selectedConceptId]
          : [];
      return finalizePlan(
        {
          ...semanticCommon,
          status: "ready",
          resolution: {
            method: "kimi",
            selectedConceptIds,
            alternatives: [],
            confidenceBand: semanticIntent.confidence,
            reasonCodes: ["SEMANTIC_MATCH"],
            clarificationQuestion: null,
          },
          executionPreview: semanticExecutionPreview(capabilityPlan),
          ai: aiMetadata(result),
        },
        signingOptions,
      );
    }

    const executableResolution =
      semanticResolution.decision === "ready" && semanticResolution.selectedConceptId
        ? semanticResolution
        : null;
    if (
      executableResolution?.selectedConceptId &&
      (result.providerNeutralCategoryHeads === undefined ||
        categoryHeadIsGrounded)
    ) {
      const selectedConceptIds = [executableResolution.selectedConceptId];
      const executableCommon = baseDraft(
        intent,
        requestCacheKey,
        semanticIntent,
        executableResolution.method === "exact" ? "high" : "medium",
        promptVersion,
      );
      return finalizePlan(
        {
          ...executableCommon,
          status: "ready",
          resolution: {
            method: "kimi",
            selectedConceptIds,
            alternatives: [],
            confidenceBand: semanticIntent.confidence,
            reasonCodes: ["SEMANTIC_MATCH"],
            clarificationQuestion: null,
          },
          executionPreview: executionPreview(selectedConceptIds),
          ai: aiMetadata(result),
        },
        signingOptions,
      );
    }
    return finalizePlan(
      {
        ...semanticCommon,
        status: "unsupported",
        resolution: {
          method: "kimi",
          selectedConceptIds: [],
          alternatives: [],
          confidenceBand: semanticIntent.confidence,
          reasonCodes: ["PROVIDER_COVERAGE_GAP"],
          clarificationQuestion: null,
        },
        executionPreview: null,
        ai: aiMetadata(result),
      },
      signingOptions,
    );
  } catch (error) {
    if (
      (error instanceof KimiClientError && error.code === "KIMI_ABORTED") ||
      (error instanceof KimiSchedulerError && error.code === "KIMI_ABORTED")
    ) throw error;
    if (deterministic.decision === "ready" && deterministic.selectedConceptId) {
      const selectedConceptIds = [deterministic.selectedConceptId];
      return finalizePlan(
        {
          ...common,
          status: "degraded",
          resolution: {
            method: "fallback",
            selectedConceptIds,
            alternatives: [],
            confidenceBand: "high",
            reasonCodes: [reasonForKimiFailure(error)],
            clarificationQuestion: null,
          },
          executionPreview: executionPreview(selectedConceptIds),
          ai: failedAiMetadata(kimiClient.modelId),
        },
        signingOptions,
      );
    }
    return finalizePlan(
      {
        ...common,
        status: "unsupported",
        resolution: {
          method: "fallback",
          selectedConceptIds: [],
          alternatives: [],
          confidenceBand: "unknown",
          reasonCodes: [reasonForKimiFailure(error)],
          clarificationQuestion: null,
        },
        executionPreview: null,
        ai: failedAiMetadata(kimiClient.modelId),
      },
      signingOptions,
    );
  }
}

export async function createSearchPlanFromEnv(
  input: PlannerInput,
  options: CreateSearchPlanFromEnvOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<SearchPlan> {
  const intent = normalizePlannerInput(input);
  const requestCacheKey = await createRequestCacheKey(intent);
  const mode = plannerModeFromEnv(env);
  const kimiClient = createKimiClientFromEnv(env);
  const signingSecret = env.SEARCH_PLAN_SIGNING_SECRET?.trim() || null;
  const signingKeyId = signingSecret
    ? (await hashCanonicalJson(signingSecret)).slice(0, 16)
    : "unsigned";
  const runtimeCacheKey = [
    requestCacheKey,
    mode,
    kimiClient?.cacheIdentity ?? "no-model-policy",
    SEARCH_PLAN_SCHEMA_VERSION,
    DECISION_POLICY_VERSION,
    GEOAPIFY_PROVIDER_CATALOG_VERSION,
    GEOAPIFY_CAPABILITY_REGISTRY.checksum,
    GEOAPIFY_COMPILER_POLICY_VERSION,
    KIMI_PROMPT_VERSION,
    signingKeyId,
    options.confirmationTtlSeconds ?? "default-ttl",
  ].join(":");
  const nowMs = (options.now ?? new Date()).getTime();
  const cached = runtimePlanCache.get(runtimeCacheKey);
  if (cached && cached.expiresAtMs > nowMs) {
    runtimeCacheMetrics.hits += 1;
    runtimePlanCache.delete(runtimeCacheKey);
    runtimePlanCache.set(runtimeCacheKey, cached);
    return {
      ...cached.plan,
      ai: { ...cached.plan.ai, cacheHit: true },
      confirmation: { ...cached.plan.confirmation },
    };
  }
  runtimeCacheMetrics.misses += 1;
  if (cached) {
    runtimePlanCache.delete(runtimeCacheKey);
    runtimeCacheMetrics.evictions += 1;
  }

  const scheduler = options.scheduler ?? runtimeSchedulerFromEnv(env);
  const scheduledKimiClient = kimiClient
    ? {
        modelId: kimiClient.modelId,
        cacheIdentity: kimiClient.cacheIdentity,
        encode: (request: Parameters<PlannerKimiClient["encode"]>[0]) =>
          scheduler.run(() => kimiClient.encode(request), {
            signal: request.signal,
          }),
      }
    : null;
  const planOptions = {
    ...(options.confirmationTtlSeconds === undefined
      ? {}
      : { confirmationTtlSeconds: options.confirmationTtlSeconds }),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  const plan = await createSearchPlan(input, {
    ...planOptions,
    mode,
    kimiClient: scheduledKimiClient,
    signingSecret,
  });
  const confirmationExpiresAt = plan.confirmation.expiresAt
    ? Date.parse(plan.confirmation.expiresAt)
    : Number.POSITIVE_INFINITY;
  const expiresAtMs = Math.min(
    nowMs + SEARCH_PLAN_RUNTIME_CACHE_TTL_MS,
    Number.isFinite(confirmationExpiresAt)
      ? confirmationExpiresAt
      : Number.POSITIVE_INFINITY,
  );
  if (
    expiresAtMs > nowMs &&
    plan.ai.validation !== "failed" &&
    !isSearchPlannerInfrastructureFailure(plan)
  ) {
    for (const [key, entry] of runtimePlanCache) {
      if (entry.expiresAtMs <= nowMs) {
        runtimePlanCache.delete(key);
        runtimeCacheMetrics.evictions += 1;
      }
    }
    runtimePlanCache.set(runtimeCacheKey, { plan, expiresAtMs });
    while (runtimePlanCache.size > SEARCH_PLAN_RUNTIME_CACHE_MAX_ENTRIES) {
      const oldestKey = runtimePlanCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      runtimePlanCache.delete(oldestKey);
      runtimeCacheMetrics.evictions += 1;
    }
  }
  return plan;
}

export function clearSearchPlanRuntimeCache(): void {
  runtimePlanCache.clear();
  runtimeCacheMetrics.hits = 0;
  runtimeCacheMetrics.misses = 0;
  runtimeCacheMetrics.evictions = 0;
}

export function searchPlanRuntimeCacheSize(): number {
  return runtimePlanCache.size;
}

function schedulerInteger(
  value: string | undefined,
  fallback: number,
  minimum = 0,
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function runtimeSchedulerFromEnv(env: NodeJS.ProcessEnv): Tier0KimiScheduler {
  const config = {
    minStartIntervalMs: schedulerInteger(
      env.KIMI_MIN_START_INTERVAL_MS,
      20_000,
    ),
    admissionTimeoutMs: schedulerInteger(
      env.KIMI_ADMISSION_TIMEOUT_MS,
      20_000,
      1,
    ),
    circuitFailureThreshold: schedulerInteger(
      env.KIMI_CIRCUIT_FAILURE_THRESHOLD,
      3,
      1,
    ),
  };
  const key = `${config.minStartIntervalMs}:${config.admissionTimeoutMs}:${config.circuitFailureThreshold}`;
  if (!runtimeKimiScheduler || runtimeKimiSchedulerConfigKey !== key) {
    runtimeKimiScheduler = createTier0KimiScheduler(config);
    runtimeKimiSchedulerConfigKey = key;
  }
  return runtimeKimiScheduler;
}

export function searchPlannerRuntimeMetrics(): {
  cache: {
    entries: number;
    hits: number;
    misses: number;
    evictions: number;
  };
  kimiAdmission: KimiSchedulerMetrics;
} {
  return {
    cache: {
      entries: runtimePlanCache.size,
      ...runtimeCacheMetrics,
    },
    kimiAdmission: runtimeSchedulerFromEnv(process.env).metrics(),
  };
}

export async function confirmSearchPlan(
  request: ConfirmSearchPlanRequest,
  options: ConfirmSearchPlanOptions,
): Promise<SearchPlan> {
  const intent = normalizePlannerInput(request.input);
  const requestCacheKey = await createRequestCacheKey(intent);
  const claims = await verifyConfirmationToken(request.confirmationToken, {
    secret: options.signingSecret,
    now: options.now,
    expectedRequestCacheKey: requestCacheKey,
    expectedSearchPlanSchemaVersion: SEARCH_PLAN_SCHEMA_VERSION,
    expectedSemanticIntentSchemaVersion: SEMANTIC_INTENT_SCHEMA_VERSION,
    expectedProviderCatalogVersion: GEOAPIFY_PROVIDER_CATALOG_VERSION,
    expectedDecisionPolicyVersion: DECISION_POLICY_VERSION,
  });
  if (!CURRENT_KIMI_PROMPT_VERSIONS.has(claims.promptVersion)) {
    throw new ConfirmationTokenError(
      "CONFIRMATION_CONTEXT_MISMATCH",
      "Confirmation token prompt policy does not match the current planner",
    );
  }
  const selected = request.selectedAlternative;
  if (
    !selected ||
    typeof selected.alternativeId !== "string" ||
    typeof selected.alternativeHash !== "string"
  ) {
    throw new ConfirmationTokenError(
      "CONFIRMATION_CONTEXT_MISMATCH",
      "Exactly one semantic alternative is required",
    );
  }
  let semanticIntent: SemanticIntentV2;
  try {
    semanticIntent = validateKimiSemanticIntent(selected.semanticIntent);
  } catch {
    throw new ConfirmationTokenError(
      "CONFIRMATION_CONTEXT_MISMATCH",
      "Selected semantic alternative is invalid",
    );
  }
  const alternativeHash = await createSemanticAlternativeHash(semanticIntent);
  if (
    selected.alternativeHash !== alternativeHash ||
    selected.alternativeId !== `alt-${alternativeHash.slice(0, 16)}` ||
    !claims.allowedAlternativeHashes.includes(alternativeHash)
  ) {
    throw new ConfirmationTokenError(
      "CONFIRMATION_CONTEXT_MISMATCH",
      "Selected semantic alternative was not offered by the signed plan",
    );
  }
  const executionPreview: SearchPlanExecutionPreview | null =
    semanticExecutionPreview(compileGeoapifySemanticIntent(semanticIntent, intent));
  if (!executionPreview) {
    throw new ConfirmationTokenError(
      "CONFIRMATION_CONTEXT_MISMATCH",
      "Selected semantic alternative is not executable",
    );
  }
  const common = baseDraft(
    intent,
    requestCacheKey,
    semanticIntent,
    "high",
    claims.promptVersion,
  );
  return finalizePlan(
    {
      ...common,
      parentPlanHash: claims.sourcePlanHash,
      status: "ready",
      resolution: {
        method: "user_confirmed",
        selectedConceptIds: [],
        alternatives: [],
        confidenceBand: "high",
        reasonCodes: ["USER_CONFIRMED"],
        clarificationQuestion: null,
      },
      executionPreview,
      ai: AI_NOT_USED,
    },
    {},
  );
}

export function searchPlannerOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<CreateSearchPlanOptions, "mode" | "kimiClient" | "signingSecret"> {
  return {
    mode: plannerModeFromEnv(env),
    kimiClient: createKimiClientFromEnv(env),
    signingSecret: env.SEARCH_PLAN_SIGNING_SECRET?.trim() || null,
  };
}
