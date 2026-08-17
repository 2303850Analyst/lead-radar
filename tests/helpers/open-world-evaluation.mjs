import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  GEOAPIFY_CAPABILITY_REGISTRY,
} from "../../lib/search-planner/catalogs/geoapify.ts";
import { createSearchPlan } from "../../lib/search-planner/planner.ts";
import {
  SEARCH_PLAN_SCHEMA_VERSION,
  SEMANTIC_INTENT_SCHEMA_VERSION,
} from "../../lib/search-planner/types.ts";
import { assertAggregateOnly, ratio, roundMetric } from "./evaluation-metrics.mjs";
import { normalizeForFixture } from "./query-intelligence-fixtures.mjs";

const fixtureUrl = new URL(
  "../fixtures/open-world-intents.cis.json",
  import.meta.url,
);
const annotationUrls = [
  new URL("../fixtures/open-world-annotations-a.json", import.meta.url),
  new URL("../fixtures/open-world-annotations-b.json", import.meta.url),
];
const FIXED_NOW = new Date("2026-08-17T12:00:00.000Z");
const SIGNING_SECRET = "open-world-evaluation-secret-32-bytes";
const ALLOWED_OUTCOMES = new Set([
  "ready",
  "needs_confirmation",
  "unsupported",
]);

export async function loadOpenWorldFixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

export async function loadOpenWorldAnnotationSets() {
  return Promise.all(
    annotationUrls.map(async (url) => JSON.parse(await readFile(url, "utf8"))),
  );
}

function providerTerm(categoryId) {
  return categoryId.replace(/[._]+/g, " ");
}

function physicalSemanticIntent(entry, semanticTerm) {
  const term = semanticTerm ?? providerTerm(entry.providerCategoryId);
  return {
    schemaVersion: SEMANTIC_INTENT_SCHEMA_VERSION,
    normalizedGoal: `найти ${entry.labelRu}`,
    entityKind: "physical_business",
    physicalLocationRequirement: "required",
    industries: [],
    coreBusinessTypes: [term],
    adjacentBusinessTypes: [],
    excludedBusinessTypes: [],
    productsAndServices: [],
    includeSignals: [entry.labelRu],
    excludeSignals: [],
    retrievalTerms: {
      precision: [term],
      recall: [term],
      exclude: [],
    },
    brandSearch: "include",
    confidence: "high",
    ambiguity: {
      isAmbiguous: false,
      reason: null,
      clarificationQuestion: null,
    },
  };
}

function ambiguousSemanticIntent() {
  return {
    schemaVersion: SEMANTIC_INTENT_SCHEMA_VERSION,
    normalizedGoal: "уточнить тип физической организации",
    entityKind: "physical_business",
    physicalLocationRequirement: "required",
    industries: [],
    coreBusinessTypes: ["business venue"],
    adjacentBusinessTypes: ["service location"],
    excludedBusinessTypes: [],
    productsAndServices: [],
    includeSignals: [],
    excludeSignals: [],
    retrievalTerms: {
      precision: ["business venue"],
      recall: ["service location"],
      exclude: [],
    },
    brandSearch: "include",
    confidence: "medium",
    ambiguity: {
      isAmbiguous: true,
      reason: "Формулировка допускает несколько существенно разных типов организаций",
      clarificationQuestion: "Какой именно тип организации нужно найти?",
    },
  };
}

function unsupportedSemanticIntent() {
  return {
    schemaVersion: SEMANTIC_INTENT_SCHEMA_VERSION,
    normalizedGoal: "непоисковая задача без физической организации",
    entityKind: "non_physical",
    physicalLocationRequirement: "not_applicable",
    industries: [],
    coreBusinessTypes: ["non place request"],
    adjacentBusinessTypes: [],
    excludedBusinessTypes: [],
    productsAndServices: [],
    includeSignals: [],
    excludeSignals: [],
    retrievalTerms: {
      precision: ["non place request"],
      recall: ["online task"],
      exclude: [],
    },
    brandSearch: "include",
    confidence: "high",
    ambiguity: {
      isAmbiguous: false,
      reason: null,
      clarificationQuestion: null,
    },
  };
}

function physicalFamilyCases(family, index, legacyCategoryIds) {
  const isMixedFamily = index < 20;
  const cases = [
    {
      locale: "ru-RU",
      countryCode: "RU",
      query: family.labelRu,
      kind: "physical",
    },
    {
      locale: "ru-RU",
      countryCode: "RU",
      query: `${family.labelRu} рядом`,
      kind: "physical",
    },
    {
      locale: "ru-RU",
      countryCode: "RU",
      query: isMixedFamily
        ? `${family.labelRu} / ${providerTerm(family.providerCategoryId)}`
        : `где найти ${family.labelRu}`,
      kind: isMixedFamily ? "mixed_language" : "physical",
    },
  ];
  if (index < 50) {
    cases.push({
      locale: "ru-RU",
      countryCode: "RU",
      query: `${family.labelRu} для бизнеса`,
      kind: "physical",
    });
    cases.push({
      locale: "be-BY",
      countryCode: "BY",
      query: `${family.labelRu} у Мінску`,
      kind: "localized",
    });
  } else {
    cases.push({
      locale: "kk-KZ",
      countryCode: "KZ",
      query: `${family.labelRu} Алматыда`,
      kind: "localized",
    });
  }

  return cases.map((entry, caseIndex) => ({
    id: `physical-${family.familyId}-${String(caseIndex + 1).padStart(2, "0")}`,
    familyId: family.familyId,
    split: family.split,
    physicalTypeId: family.familyId,
    providerCategoryId: family.providerCategoryId,
    novel: !legacyCategoryIds.has(family.providerCategoryId),
    expectedOutcome: "ready",
    semanticIntent: physicalSemanticIntent(
      family,
      family.semanticTerms?.[caseIndex],
    ),
    ...entry,
  }));
}

function specialCases(entries, kind, expectedOutcome) {
  const semanticIntent = expectedOutcome === "needs_confirmation"
    ? ambiguousSemanticIntent()
    : unsupportedSemanticIntent();
  return entries.map((entry) => ({
    ...entry,
    kind,
    locale: "ru-RU",
    countryCode: "RU",
    physicalTypeId: null,
    providerCategoryId: null,
    novel: false,
    expectedOutcome,
    semanticIntent,
  }));
}

export function expandOpenWorldCases(fixture) {
  const legacyCategoryIds = new Set(fixture.legacyBaseline.categoryIds);
  return [
    ...fixture.physicalFamilies.flatMap((family, index) =>
      physicalFamilyCases(family, index, legacyCategoryIds),
    ),
    ...specialCases(
      fixture.ambiguousCases,
      "ambiguous",
      "needs_confirmation",
    ),
    ...specialCases(fixture.nonPlaceCases, "non_place", "unsupported"),
    ...specialCases(fixture.injectionCases, "injection", "unsupported"),
  ];
}

export function attachOpenWorldAnnotations(cases, annotationSets) {
  if (!Array.isArray(annotationSets) || annotationSets.length !== 2) {
    throw new Error("Open-world evaluation requires exactly two annotation sets");
  }
  const expectedIds = new Set(cases.map((entry) => entry.id));
  if (expectedIds.size !== cases.length) {
    throw new Error("Open-world corpus contains duplicate case IDs");
  }
  const annotatorIds = new Set();
  const labelMaps = annotationSets.map((set) => {
    if (
      !set ||
      typeof set.version !== "string" ||
      typeof set.annotatorId !== "string" ||
      set.blinded !== true ||
      !Array.isArray(set.labels)
    ) {
      throw new Error("Open-world annotation metadata is invalid");
    }
    annotatorIds.add(set.annotatorId);
    const labels = new Map();
    for (const label of set.labels) {
      if (
        !label ||
        typeof label.id !== "string" ||
        !ALLOWED_OUTCOMES.has(label.outcome) ||
        labels.has(label.id)
      ) {
        throw new Error(`Invalid annotation in ${set.version}`);
      }
      labels.set(label.id, label.outcome);
    }
    if (
      labels.size !== expectedIds.size ||
      [...expectedIds].some((id) => !labels.has(id)) ||
      [...labels.keys()].some((id) => !expectedIds.has(id))
    ) {
      throw new Error(`Annotation coverage mismatch in ${set.version}`);
    }
    return labels;
  });
  if (annotatorIds.size !== 2) {
    throw new Error("Open-world annotations must use distinct annotator IDs");
  }
  return cases.map((entry) => ({
    ...entry,
    annotations: {
      annotatorA: labelMaps[0].get(entry.id),
      annotatorB: labelMaps[1].get(entry.id),
      adjudicated: entry.expectedOutcome,
    },
  }));
}

export function cohenKappa(left, right) {
  if (left.length !== right.length || left.length === 0) return 0;
  const labels = [...new Set([...left, ...right])];
  const observed = ratio(
    left.filter((label, index) => label === right[index]).length,
    left.length,
  );
  const expected = labels.reduce((sum, label) => {
    const leftRate = left.filter((item) => item === label).length / left.length;
    const rightRate = right.filter((item) => item === label).length / right.length;
    return sum + leftRate * rightRate;
  }, 0);
  if (expected === 1) return observed === 1 ? 1 : 0;
  return (observed - expected) / (1 - expected);
}

function lookupKey(intent) {
  return JSON.stringify([
    intent.locale,
    intent.countryCodes[0],
    normalizeForFixture(intent.primaryQuery),
  ]);
}

function createOpenWorldGoldenClient(cases) {
  const byIntent = new Map(
    cases.map((entry) => [
      lookupKey({
        locale: entry.locale,
        countryCodes: [entry.countryCode],
        primaryQuery: entry.query,
      }),
      entry,
    ]),
  );
  const calls = [];
  return {
    modelId: "mock-kimi-open-world-v2",
    calls,
    async encode(request) {
      const entry = byIntent.get(lookupKey(request.intent));
      if (!entry) throw new Error("Open-world mock received an unknown intent");
      const serializedRequest = JSON.stringify(request);
      const openVocabularyViolation =
        /candidates|conceptId|providerCategoryId|executionPreview/i.test(
          serializedRequest,
        );
      calls.push({ id: entry.id, openVocabularyViolation });
      return {
        semanticIntent: entry.semanticIntent,
        modelId: this.modelId,
        finishReason: "stop",
        latencyMs: 1,
        usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
      };
    },
  };
}

function plannerInput(entry) {
  return {
    description: "",
    primaryQuery: entry.query,
    relatedQueries: [],
    excludeQueries: [],
    locale: entry.locale,
    countryCodes: [entry.countryCode],
  };
}

function semanticOwnsNoGeography(intent) {
  const forbiddenKeys = new Set([
    "address",
    "center",
    "city",
    "coordinates",
    "countryCode",
    "countryCodes",
    "location",
    "radius",
    "radiusKm",
  ]);
  const visit = (value) => {
    if (!value || typeof value !== "object") return true;
    if (Array.isArray(value)) return value.every(visit);
    return Object.entries(value).every(
      ([key, child]) => !forbiddenKeys.has(key) && visit(child),
    );
  };
  return visit(intent);
}

function compiledPlanIsSafe(plan) {
  if (!plan.executionPreview) return true;
  const known = new Set(GEOAPIFY_CAPABILITY_REGISTRY.categories);
  return (
    plan.executionPreview.provider === "geoapify" &&
    plan.executionPreview.retrievalArms.length <= 4 &&
    plan.executionPreview.retrievalArms.every(
      (arm) =>
        arm.categoryLabels.length > 0 &&
        arm.categoryLabels.length <= 8 &&
        arm.categoryLabels.every((categoryId) => known.has(categoryId)) &&
        arm.provenance.every((item) => known.has(item.categoryId)),
    )
  );
}

function compiledPlanIsGrounded(entry, plan) {
  if (!plan.executionPreview) return false;
  if (
    entry.providerCategoryId &&
    plan.executionPreview.categoryLabels.includes(entry.providerCategoryId)
  ) {
    return true;
  }
  const precisionTerm = entry.semanticIntent.retrievalTerms.precision[0];
  return plan.executionPreview.retrievalArms.some(
    (arm) =>
      arm.type === "fallback" &&
      arm.role === "fallback" &&
      arm.usesNameFallback === true &&
      arm.provenance.length > 0 &&
      arm.provenance.every(
        (item) =>
          item.semanticField === "fallback" &&
          item.semanticTerm === precisionTerm &&
          item.match === "name_fallback",
      ),
  );
}

export function stableCorpusChecksum(cases) {
  return createHash("sha256")
    .update(JSON.stringify(cases))
    .digest("hex");
}

export async function evaluateOpenWorldCorpus() {
  const fixture = await loadOpenWorldFixture();
  const expandedCases = expandOpenWorldCases(fixture);
  const annotationSets = await loadOpenWorldAnnotationSets();
  const cases = attachOpenWorldAnnotations(expandedCases, annotationSets);
  const corpusChecksum = stableCorpusChecksum(expandedCases);
  const annotationChecksum = stableCorpusChecksum(annotationSets);
  const client = createOpenWorldGoldenClient(cases);
  const results = [];

  for (const entry of cases) {
    const options = {
      mode: "kimi",
      kimiClient: client,
      signingSecret: SIGNING_SECRET,
      now: FIXED_NOW,
    };
    const first = await createSearchPlan(plannerInput(entry), options);
    const second = await createSearchPlan(plannerInput(entry), options);
    const categoryLabels = first.executionPreview?.categoryLabels ?? [];
    results.push({
      id: entry.id,
      split: entry.split,
      expectedOutcome: entry.expectedOutcome,
      actualOutcome: first.status,
      physical: Boolean(entry.physicalTypeId),
      novel: entry.novel,
      providerExecutable: Boolean(first.executionPreview?.retrievalArms.length),
      expectedCategoryFound:
        !entry.providerCategoryId || categoryLabels.includes(entry.providerCategoryId),
      geographySafe: semanticOwnsNoGeography(first.semanticIntent),
      compilerSafe: compiledPlanIsSafe(first),
      compilerGrounded: compiledPlanIsGrounded(entry, first),
      cacheVersioned:
        first.schemaVersion === SEARCH_PLAN_SCHEMA_VERSION &&
        first.semanticIntent.schemaVersion === SEMANTIC_INTENT_SCHEMA_VERSION &&
        Boolean(
          first.providerCatalogVersion &&
            first.decisionPolicyVersion &&
            first.promptVersion,
        ) &&
        first.requestCacheKey === second.requestCacheKey &&
        first.planHash === second.planHash,
    });
  }

  const physical = results.filter((entry) => entry.physical);
  const novel = physical.filter((entry) => entry.novel);
  const holdoutPhysical = physical.filter((entry) => entry.split === "holdout");
  const actualUnsupported = results.filter(
    (entry) => entry.actualOutcome === "unsupported",
  );
  const trueUnsupported = actualUnsupported.filter(
    (entry) => entry.expectedOutcome === "unsupported",
  );
  const localeCounts = cases.reduce((counts, entry) => {
    counts[entry.countryCode] = (counts[entry.countryCode] ?? 0) + 1;
    return counts;
  }, {});
  const splitCounts = cases.reduce((counts, entry) => {
    counts[entry.split] = (counts[entry.split] ?? 0) + 1;
    return counts;
  }, {});
  const familySplitCounts = [...new Map(
    cases.map((entry) => [entry.familyId, entry.split]),
  ).values()].reduce((counts, split) => {
    counts[split] = (counts[split] ?? 0) + 1;
    return counts;
  }, {});
  const familyCounts = new Set(cases.map((entry) => entry.familyId)).size;
  const physicalTypeCount = new Set(
    cases.filter((entry) => entry.physicalTypeId).map((entry) => entry.physicalTypeId),
  ).size;
  const metrics = {
    novelProviderCompilation: ratio(
      novel.filter(
        (entry) =>
          entry.actualOutcome === "ready" &&
          entry.providerExecutable &&
          entry.compilerGrounded,
      ).length,
      novel.length,
    ),
    holdoutProviderCompilation: ratio(
      holdoutPhysical.filter(
        (entry) =>
          entry.actualOutcome === "ready" &&
          entry.providerExecutable &&
          entry.compilerGrounded,
      ).length,
      holdoutPhysical.length,
    ),
    falseUnsupported: ratio(
      physical.filter((entry) => entry.actualOutcome === "unsupported").length,
      physical.length,
    ),
    unsupportedPrecision: ratio(
      trueUnsupported.length,
      actualUnsupported.length,
    ),
    semanticOutcomeAccuracy: ratio(
      results.filter((entry) => entry.actualOutcome === entry.expectedOutcome).length,
      results.length,
    ),
    exactExpectedCategoryCoverage: ratio(
      physical.filter((entry) => entry.expectedCategoryFound).length,
      physical.length,
    ),
    cohensKappa: cohenKappa(
      cases.map((entry) => entry.annotations.annotatorA),
      cases.map((entry) => entry.annotations.annotatorB),
    ),
  };
  const hardGates = {
    openVocabularyRequestViolations: client.calls.filter(
      (call) => call.openVocabularyViolation,
    ).length,
    geographyOwnershipViolations: results.filter((entry) => !entry.geographySafe)
      .length,
    compilerSafetyViolations: results.filter((entry) => !entry.compilerSafe).length,
    providerGroundingViolations: physical.filter(
      (entry) => entry.actualOutcome === "ready" && !entry.compilerGrounded,
    ).length,
    cacheVersioningViolations: results.filter((entry) => !entry.cacheVersioned)
      .length,
    corpusIntegrityViolations:
      corpusChecksum === fixture.expansionContract.expandedChecksum ? 0 : 1,
    annotationAdjudicationViolations: cases.filter(
      (entry) =>
        entry.annotations.annotatorA !== entry.annotations.adjudicated ||
        entry.annotations.annotatorB !== entry.annotations.adjudicated,
    ).length,
  };
  const coveragePass =
    cases.length >= 500 &&
    physicalTypeCount >= 100 &&
    novel.filter((entry) => entry.physical).length >= 80 &&
    localeCounts.RU >= 350 &&
    localeCounts.BY >= 50 &&
    localeCounts.KZ >= 50;
  const pass =
    coveragePass &&
    metrics.novelProviderCompilation >= 0.95 &&
    metrics.holdoutProviderCompilation === 1 &&
    metrics.falseUnsupported <= 0.02 &&
    metrics.unsupportedPrecision >= 0.95 &&
    metrics.cohensKappa >= 0.8 &&
    Object.values(hardGates).every((count) => count === 0);
  const report = {
    evaluation: "LeadRadar open-world CIS intent evaluation",
    fixtureVersion: fixture.version,
    corpusChecksum,
    annotationVersions: annotationSets.map((set) => set.version),
    annotationChecksum,
    sampleCounts: {
      intentCases: cases.length,
      businessFamilies: familyCounts,
      physicalTypes: physicalTypeCount,
      novelPhysicalCases: novel.length,
      mixedLanguage: cases.filter((entry) => entry.kind === "mixed_language").length,
      ambiguous: cases.filter((entry) => entry.kind === "ambiguous").length,
      nonPlace: cases.filter((entry) => entry.kind === "non_place").length,
      injection: cases.filter((entry) => entry.kind === "injection").length,
      byCountry: localeCounts,
      bySplit: splitCounts,
      familiesBySplit: familySplitCounts,
    },
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([key, value]) => [key, roundMetric(value)]),
    ),
    hardGates,
    aggregateOnly: true,
    decision: pass ? "PASS" : "FAIL",
  };
  if (!assertAggregateOnly(report)) {
    throw new Error("Open-world evaluation report is not aggregate-only");
  }
  return report;
}
