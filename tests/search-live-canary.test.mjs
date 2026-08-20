import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import * as searchLiveCanary from "../scripts/lib/search-live-canary.mjs";

const {
  SEARCH_CANARY_CASES,
  SEARCH_CANARY_EVALUATION_POLICY_VERSION,
  SEARCH_CANARY_ATTAINABLE_POLICY,
  SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS,
  SEARCH_CANARY_RUBRIC_VERSION,
  SEARCH_CANARY_THRESHOLDS,
  collectGeoapifyProviderFacts,
  countGeoapifyProviderFactViolations,
  isRetryableSearchCanaryCode,
  readBoundedJsonResponse,
  runCanaryAttemptWithWatchdog,
  searchCanaryCaseSetChecksum,
  summarizeSearchCanary,
  validateSearchCanaryCoverage,
} = searchLiveCanary;

function identityHash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identityGroups(prefix, count) {
  return Array.from({ length: count }, (_, index) => [
    identityHash(`${prefix}-${index}`),
  ]);
}

function attemptTiming({ succeeded = true, first = 100, encoder = 5_000, terminal = 10_000 } = {}) {
  return {
    succeeded,
    firstProgressMs: first,
    encoderMs: encoder,
    terminalMs: terminal,
  };
}

function providerCoverageRecord({ cardsAccepted = 10 } = {}) {
  return {
    plannedRetrievalArms: 2,
    completedRetrievalArms: 2,
    retrievalRequests: 2,
    cardsAccepted,
    detailsRequests: 3,
    categoryResolutionRequests: 0,
    totalProviderRequests: 5,
  };
}

const attainableVersionInput = Object.freeze({
  appVersion: "0.4.0-alpha.1",
  modelId: "kimi-k3",
  modelPolicyVersion: "model-policy-v1",
  transportSchemaVersion: "transport-schema-v2",
  promptVersion: "prompt-v2",
  semanticIntentSchemaVersion: "2.2",
  searchPlanSchemaVersion: "2.2",
  decisionPolicyVersion: "policy-v4",
  compilerPolicyVersion: "compiler-v5",
  providerCatalogVersion: "catalog-v1",
  providerCatalogChecksum: "a".repeat(64),
  productionBundleSha256: "b".repeat(64),
  canaryHarnessSha256: "c".repeat(64),
  inputUsdPerMillion: 3,
  outputUsdPerMillion: 15,
});

function attainableRecords({
  poolCandidateCount = 12,
  poolRelevant = 10,
  top10Relevant = 9,
  baselineRelevant = 6,
} = {}) {
  return SEARCH_CANARY_CASES.map((entry, index) => ({
    id: entry.id,
    semanticSucceeded: true,
    baselineSucceeded: true,
    usageReported: true,
    kimiUsed: true,
    schemaPassed: true,
    executablePlan: true,
    firstProgressMs: 100 + index,
    encoderMs: 5_000 + index,
    terminalMs: 10_000 + index,
    inputTokens: 2_000,
    outputTokens: 200,
    geographyLeaks: 0,
    secretLeaks: 0,
    inventedFactViolations: 0,
    rawResponsesStored: false,
    providerCoverage: providerCoverageRecord({ cardsAccepted: poolCandidateCount }),
    categoryResolutionStatus: "not_needed",
    categoryResolutionRequests: 0,
    attemptCount: 1,
    firstAttemptSucceeded: true,
    failedAttemptCodes: [],
    attemptTimings: [
      attemptTiming({
        first: 100 + index,
        encoder: 5_000 + index,
        terminal: 10_000 + index,
      }),
    ],
    semanticJourneyMs: 10_000 + index,
    semanticCandidateCount: Math.min(10, poolCandidateCount),
    semanticReviewed: Math.min(10, poolCandidateCount),
    semanticRelevant: top10Relevant,
    semanticRelevantIdentityGroups: identityGroups(
      `${entry.id}-attainable-semantic`,
      top10Relevant,
    ),
    attainablePoolCandidateCount: poolCandidateCount,
    attainablePoolReviewed: poolCandidateCount,
    attainablePoolRelevant: poolRelevant,
    baselineCandidateCount: 10,
    baselineReviewed: 10,
    baselineRelevant,
    baselineRelevantIdentityGroups: identityGroups(
      `${entry.id}-attainable-baseline`,
      baselineRelevant,
    ),
  }));
}

test("live search canary retries only transient production terminal codes", () => {
  for (const code of [
    "SEARCH_PLANNER_UNAVAILABLE",
    "SEARCH_DEADLINE_EXCEEDED",
    "GEOAPIFY_TIMEOUT",
    "GEOAPIFY_RATE_LIMIT",
    "GEOAPIFY_NETWORK_ERROR",
    "GEOAPIFY_UPSTREAM_ERROR",
  ]) {
    assert.equal(isRetryableSearchCanaryCode(code), true, code);
  }
  for (const code of [
    "INVALID_SEARCH_PAYLOAD",
    "SEARCH_PLAN_CONFIRMATION_REQUIRED",
    "GEOAPIFY_INVALID_COMPILED_PLAN",
    "SEARCH_UNKNOWN_ERROR",
    null,
  ]) {
    assert.equal(isRetryableSearchCanaryCode(code), false, String(code));
  }
});

test("live search canary watchdog waits for abort settlement before returning", async () => {
  const controller = new AbortController();
  let cleanedUp = false;
  const attempt = new Promise((resolve) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        setTimeout(() => {
          cleanedUp = true;
          resolve("late-result");
        }, 15);
      },
      { once: true },
    );
  });
  await assert.rejects(
    runCanaryAttemptWithWatchdog(attempt, controller, {
      timeoutMs: 5,
      settleTimeoutMs: 100,
    }),
    (error) => error?.code === "CANARY_HARNESS_TIMEOUT",
  );
  assert.equal(cleanedUp, true);
});

test("live search canary watchdog fails closed when an attempt ignores abort", async () => {
  const controller = new AbortController();
  await assert.rejects(
    runCanaryAttemptWithWatchdog(new Promise(() => {}), controller, {
      timeoutMs: 5,
      settleTimeoutMs: 10,
    }),
    (error) => error?.code === "CANARY_ATTEMPT_DID_NOT_SETTLE",
  );
  assert.equal(controller.signal.aborted, true);
});

test("live search canary defines 12 bounded CIS cases with eight novel types", () => {
  const coverage = validateSearchCanaryCoverage(SEARCH_CANARY_CASES);
  assert.equal(coverage.cases, 12);
  assert.ok(coverage.novelBusinessTypes >= 8);
  assert.deepEqual(coverage.cities.sort(), [
    "Алматы",
    "Екатеринбург",
    "Минск",
    "Москва",
    "Новосибирск",
  ]);
  assert.deepEqual(coverage.countryCodes.sort(), ["BY", "KZ", "RU"]);
  assert.ok(coverage.mixedLanguageCases >= 2);
  assert.ok(
    SEARCH_CANARY_CASES.every(
      (entry) =>
        typeof entry.literalBaselineQuery === "string" &&
        entry.literalBaselineQuery.length >= 2 &&
        entry.literalBaselineQuery.length <= 80,
    ),
  );
});

test("live search canary verifies normalized lead facts against transient Geoapify facts", () => {
  const facts = new Map();
  collectGeoapifyProviderFacts(facts, [
    {
      externalId: "place-1",
      name: "Книжный мир",
      address: "Москва, Тверская улица, 1",
      coordinates: [37.62, 55.75],
      categories: ["commercial.books"],
      categoryLabel: "Книжный магазин",
      phone: null,
      email: null,
      website: null,
      telegram: null,
      vk: null,
      detailsObserved: false,
    },
  ]);
  collectGeoapifyProviderFacts(facts, [
    {
      externalId: "place-1",
      name: null,
      address: "Адрес не указан",
      coordinates: [37.62, 55.75],
      categories: [],
      categoryLabel: "Организация",
      phone: "+7 495 000-00-00",
      email: "books@example.test",
      website: "books.example.test",
      telegram: "https://t.me/book_world",
      vk: "https://vk.com/book_world",
      detailsObserved: true,
    },
  ]);
  const lead = {
    id: "geoapify-place-1",
    name: "Книжный мир",
    location: {
      address: "Москва, Тверская улица, 1",
      coordinates: [37.62, 55.75],
    },
    phone: "+7 495 000-00-00",
    email: "books@example.test",
    website: {
      sourceStatus: "listed",
      verifiedStatus: "not_checked",
      url: "https://books.example.test/",
    },
    category: "Книжный магазин",
    tags: ["commercial.books"],
    discovery: { source: "geoapify" },
    socials: {
      telegram: "https://t.me/book_world",
      vk: "https://vk.com/book_world",
    },
    sources: [
      { provider: "geoapify", externalId: "place-1" },
    ],
  };

  assert.equal(countGeoapifyProviderFactViolations([lead], facts), 0);
  for (const mutation of [
    { ...lead, name: "Выдуманная компания" },
    { ...lead, location: { ...lead.location, address: "Выдуманный адрес" } },
    { ...lead, phone: "+7 999 999-99-99" },
    { ...lead, email: "invented@example.test" },
    { ...lead, website: { sourceStatus: "listed", url: "https://evil.example/" } },
    {
      ...lead,
      sources: [{ provider: "geoapify", externalId: "unknown-place" }],
    },
    {
      ...lead,
      sources: [
        ...lead.sources,
        { provider: "yandex", externalId: "foreign-place" },
      ],
    },
    { ...lead, discovery: { source: "yandex" } },
    { ...lead, tags: ["commercial.books", "airport"] },
    { ...lead, category: "Выдуманная категория" },
    { ...lead, socials: { ...lead.socials, telegram: "https://t.me/evil" } },
    { ...lead, socials: { ...lead.socials, telegram: "javascript:alert(1)" } },
    {
      ...lead,
      website: {
        sourceStatus: "not_checked",
        verifiedStatus: "not_checked",
        url: "https://evil.example/",
      },
    },
    {
      ...lead,
      website: {
        sourceStatus: "unknown",
        verifiedStatus: "not_checked",
        url: null,
      },
    },
    { ...lead, website: { ...lead.website, verifiedStatus: "verified" } },
  ]) {
    assert.ok(countGeoapifyProviderFactViolations([mutation], facts) > 0);
  }
});

test("live search canary bounds chunked baseline responses", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"features":['));
        controller.enqueue(new Uint8Array(1_024));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(
    readBoundedJsonResponse(response, 128),
    /byte limit/,
  );
  assert.equal(cancelled, true);
});

test("live search canary summary enforces fixed-k, unique identity, provider and safety gates", () => {
  const bridgeIdentity = identityHash("same-provider-organization");
  const records = SEARCH_CANARY_CASES.map((entry, index) => {
    const semanticRelevantIdentityGroups = identityGroups(`${entry.id}-semantic`, 9);
    if (index === 0) semanticRelevantIdentityGroups[0].push(bridgeIdentity);
    if (index === 1) semanticRelevantIdentityGroups[0] = [bridgeIdentity];
    return {
    id: entry.id,
    semanticSucceeded: true,
    baselineSucceeded: true,
    usageReported: true,
    kimiUsed: true,
    schemaPassed: true,
    executablePlan: true,
    firstProgressMs: 100 + index,
    encoderMs: 5_000 + index,
    terminalMs: 10_000 + index,
    inputTokens: 2_000,
    outputTokens: 200,
    geographyLeaks: 0,
    secretLeaks: 0,
    inventedFactViolations: 0,
    rawResponsesStored: false,
    providerCoverage: providerCoverageRecord(),
    categoryResolutionStatus: "not_needed",
    categoryResolutionRequests: 0,
    attemptCount: 1,
    firstAttemptSucceeded: true,
    failedAttemptCodes: [],
    attemptTimings: [attemptTiming({ first: 100 + index, encoder: 5_000 + index, terminal: 10_000 + index })],
    semanticJourneyMs: 10_000 + index,
    semanticCandidateCount: 10,
    semanticReviewed: 10,
    semanticRelevant: 9,
    semanticRelevantIdentityGroups,
    attainablePoolCandidateCount: 10,
    attainablePoolReviewed: 10,
    attainablePoolRelevant: 9,
    baselineCandidateCount: 8,
    baselineReviewed: 8,
    baselineRelevant: 6,
    baselineRelevantIdentityGroups: identityGroups(`${entry.id}-baseline`, 6),
    };
  });
  const versionInput = {
    appVersion: "0.4.0-alpha.1",
    modelId: "kimi-k3",
    modelPolicyVersion: "model-policy-v1",
    transportSchemaVersion: "transport-schema-v2",
    promptVersion: "prompt-v2",
    semanticIntentSchemaVersion: "2.2",
    searchPlanSchemaVersion: "2.2",
    decisionPolicyVersion: "policy-v4",
    compilerPolicyVersion: "compiler-v5",
    providerCatalogVersion: "catalog-v1",
    providerCatalogChecksum: "a".repeat(64),
    productionBundleSha256: "b".repeat(64),
    canaryHarnessSha256: "c".repeat(64),
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
  };
  const report = summarizeSearchCanary(records, versionInput);

  assert.equal(report.sampleCounts.cases, 12);
  assert.equal(report.sampleCounts.attainablePoolReviewed, 120);
  assert.equal(report.sampleCounts.attainablePoolRelevant, 108);
  assert.equal(
    report.versions.evaluationPolicy,
    SEARCH_CANARY_EVALUATION_POLICY_VERSION,
  );
  assert.deepEqual(
    report.versions.attainablePolicy,
    SEARCH_CANARY_ATTAINABLE_POLICY,
  );
  assert.equal(report.versions.rubric, SEARCH_CANARY_RUBRIC_VERSION);
  assert.equal(report.versions.caseSetChecksum, searchCanaryCaseSetChecksum());
  assert.deepEqual(report.versions.thresholds, SEARCH_CANARY_THRESHOLDS);
  assert.equal(report.versions.productionBundleSha256, "b".repeat(64));
  assert.equal(report.versions.canaryHarnessSha256, "c".repeat(64));
  assert.equal(report.versions.modelPolicy, "model-policy-v1");
  assert.equal(report.versions.transportSchema, "transport-schema-v2");
  assert.equal(report.metrics.schemaPassRate, 1);
  assert.equal(report.metrics.executablePlanRate, 1);
  assert.equal(report.metrics.precisionAt10, 0.9);
  assert.equal(report.metrics.baselinePrecisionAt10, 0.6);
  assert.equal(report.metrics.precisionAmongRetrieved, 0.9);
  assert.equal(report.metrics.baselinePrecisionAmongRetrieved, 0.75);
  assert.equal(report.metrics.relevantUniqueLeads, 107);
  assert.equal(report.metrics.baselineRelevantUniqueLeads, 72);
  assert.equal(report.metrics.relevantLeadGain, 0.4861);
  assert.equal(report.metrics.precisionDelta, 0.3);
  assert.equal(report.metrics.estimatedCostUsd, 0.108);
  assert.equal(report.metrics.firstAttemptSuccessRate, 1);
  assert.equal(report.metrics.retriedCases, 0);
  assert.deepEqual(report.decisionSupport.executedArmPool, {
    scope: "executed_production_candidate_pool",
    maxCandidatesPerCase: 50,
    attainableAt10Threshold: 0.95,
    measurementValid: true,
    qualityGapClassification: "retrieval_or_source_gap",
    rankerOnlyTuningEligible: false,
    addedProviderWork: { requests: 0, cards: 0, details: 0 },
    providerCoverageLimits: SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS,
    observedFinalResponseProviderWork: {
      reportedCases: 12,
      totals: {
        completedRetrievalArms: 24,
        retrievalRequests: 24,
        cardsAccepted: 120,
        detailsRequests: 36,
        categoryResolutionRequests: 0,
        totalProviderRequests: 60,
      },
    },
    plannedFinalResponseRetrievalArms: {
      reportedCases: 12,
      total: 24,
    },
  });
  assert.equal(report.caseMetrics.length, SEARCH_CANARY_CASES.length);
  assert.deepEqual(report.caseMetrics[0], {
    id: SEARCH_CANARY_CASES[0].id,
    semanticReviewed: 10,
    semanticRelevant: 9,
    semanticPrecisionAt10: 0.9,
    attainablePoolReviewed: 10,
    attainablePoolRelevant: 9,
    attainableRelevantAt10: 9,
    conditionalRankerRecallAt10: 1,
    providerCoverage: providerCoverageRecord(),
    baselineReviewed: 8,
    baselineRelevant: 6,
    baselinePrecisionAt10: 0.6,
  });
  assert.equal(report.hardGates.safetyViolations, 0);
  assert.equal(report.hardGates.baselineComparable, true);
  assert.equal(report.decision, "PASS");
  assert.equal(JSON.stringify(report).includes("primaryQuery"), false);
  assert.equal(JSON.stringify(report).includes('"name"'), false);
  assert.equal(JSON.stringify(report).includes('"address"'), false);
  assert.equal(JSON.stringify(report).includes('"phone"'), false);
  assert.equal(JSON.stringify(report).includes("identity"), false);

  const oneFailedAttempt = structuredClone(records);
  oneFailedAttempt[0] = {
    ...oneFailedAttempt[0],
    semanticSucceeded: false,
    kimiUsed: false,
    schemaPassed: false,
    executablePlan: false,
    providerCoverage: undefined,
    categoryResolutionStatus: "unreported",
    categoryResolutionRequests: 0,
    firstAttemptSucceeded: false,
    failedAttemptCodes: ["INVALID_SEARCH_PAYLOAD"],
    attemptTimings: [
      attemptTiming({ succeeded: false, encoder: null, terminal: 1_000 }),
    ],
    semanticCandidateCount: 0,
    semanticReviewed: 0,
    semanticRelevant: 0,
    semanticRelevantIdentityGroups: [],
    attainablePoolCandidateCount: 0,
    attainablePoolReviewed: 0,
    attainablePoolRelevant: 0,
  };
  const failedReport = summarizeSearchCanary(oneFailedAttempt, versionInput);
  assert.equal(failedReport.metrics.unpricedFailedAttempts, 1);
  assert.equal(failedReport.metrics.estimatedCostUsdIsLowerBound, true);
  assert.throws(
    () => summarizeSearchCanary(records, {
      ...versionInput,
      inputUsdPerMillion: Number.NaN,
    }),
    /finite non-negative/,
  );
  assert.throws(
    () => summarizeSearchCanary(records, {
      ...versionInput,
      canaryHarnessSha256: "not-a-checksum",
    }),
    /fingerprints/,
  );
});

test("live search canary summary fails closed on weak quality or safety", () => {
  const records = SEARCH_CANARY_CASES.map((entry, index) => ({
    id: entry.id,
    semanticSucceeded: index !== 0,
    baselineSucceeded: true,
    usageReported: true,
    kimiUsed: index !== 0,
    schemaPassed: index !== 0,
    executablePlan: index !== 0,
    firstProgressMs: 700,
    encoderMs: 25_000,
    terminalMs: 59_000,
    inputTokens: 1_000,
    outputTokens: 100,
    geographyLeaks: index === 0 ? 1 : 0,
    secretLeaks: 0,
    inventedFactViolations: 0,
    rawResponsesStored: false,
    providerCoverage: index === 0 ? undefined : providerCoverageRecord(),
    categoryResolutionStatus: index === 0 ? "unreported" : "not_needed",
    categoryResolutionRequests: 0,
    attemptCount: index === 0 ? 2 : 1,
    firstAttemptSucceeded: index !== 0,
    failedAttemptCodes: index === 0
      ? ["SEARCH_PLANNER_UNAVAILABLE", "SEARCH_PLANNER_UNAVAILABLE"]
      : [],
    attemptTimings: index === 0
      ? [
          attemptTiming({ succeeded: false, first: 700, encoder: null, terminal: 65_000 }),
          attemptTiming({ succeeded: false, first: 700, encoder: null, terminal: 65_000 }),
        ]
      : [attemptTiming({ first: 700, encoder: 25_000, terminal: 59_000 })],
    semanticJourneyMs: index === 0 ? 132_000 : 59_000,
    semanticCandidateCount: 10,
    semanticReviewed: 10,
    semanticRelevant: 7,
    semanticRelevantIdentityGroups: identityGroups(`${entry.id}-weak-semantic`, 7),
    attainablePoolCandidateCount: 10,
    attainablePoolReviewed: 10,
    attainablePoolRelevant: 7,
    baselineCandidateCount: 10,
    baselineReviewed: 10,
    baselineRelevant: 8,
    baselineRelevantIdentityGroups: identityGroups(`${entry.id}-weak-baseline`, 8),
  }));
  const report = summarizeSearchCanary(records, {
    appVersion: "test",
    modelId: "kimi-k3",
    modelPolicyVersion: "model-policy-test",
    promptVersion: "test",
    semanticIntentSchemaVersion: "2.2",
    searchPlanSchemaVersion: "2.2",
    decisionPolicyVersion: "test",
    compilerPolicyVersion: "test",
    providerCatalogVersion: "test",
    providerCatalogChecksum: "b".repeat(64),
    productionBundleSha256: "d".repeat(64),
    canaryHarnessSha256: "e".repeat(64),
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
  });

  assert.ok(report.metrics.schemaPassRate < 0.95);
  assert.ok(report.metrics.precisionAt10 < 0.85);
  assert.ok(report.hardGates.safetyViolations > 0);
  assert.ok(report.metrics.firstAttemptSuccessRate < 1);
  assert.equal(report.metrics.totalProductionAttempts, 13);
  assert.equal(report.metrics.unpricedFailedAttempts, 2);
  assert.equal(report.metrics.estimatedCostUsdIsLowerBound, true);
  assert.equal(report.metrics.terminalP95Ms, 65_000);
  assert.equal(report.hardGates.deadline, false);
  assert.equal(
    report.decisionSupport.executedArmPool.measurementValid,
    false,
  );
  assert.equal(
    report.decisionSupport.executedArmPool.rankerOnlyTuningEligible,
    false,
  );
  assert.equal(report.decision, "FAIL");
});

test("live search canary fails closed when the literal baseline has no comparable results", () => {
  const records = SEARCH_CANARY_CASES.map((entry) => ({
    id: entry.id,
    semanticSucceeded: true,
    baselineSucceeded: true,
    usageReported: true,
    kimiUsed: true,
    schemaPassed: true,
    executablePlan: true,
    firstProgressMs: 100,
    encoderMs: 5_000,
    terminalMs: 10_000,
    inputTokens: 1_000,
    outputTokens: 100,
    geographyLeaks: 0,
    secretLeaks: 0,
    inventedFactViolations: 0,
    rawResponsesStored: false,
    providerCoverage: providerCoverageRecord(),
    categoryResolutionStatus: "not_needed",
    categoryResolutionRequests: 0,
    attemptCount: 1,
    firstAttemptSucceeded: true,
    failedAttemptCodes: [],
    attemptTimings: [attemptTiming()],
    semanticJourneyMs: 10_000,
    semanticCandidateCount: 10,
    semanticReviewed: 10,
    semanticRelevant: 9,
    semanticRelevantIdentityGroups: identityGroups(`${entry.id}-empty-semantic`, 9),
    attainablePoolCandidateCount: 10,
    attainablePoolReviewed: 10,
    attainablePoolRelevant: 9,
    baselineCandidateCount: 0,
    baselineReviewed: 0,
    baselineRelevant: 0,
    baselineRelevantIdentityGroups: [],
  }));
  const report = summarizeSearchCanary(records, {
    appVersion: "test",
    modelId: "kimi-k3",
    modelPolicyVersion: "model-policy-test",
    promptVersion: "test",
    semanticIntentSchemaVersion: "2.2",
    searchPlanSchemaVersion: "2.2",
    decisionPolicyVersion: "test",
    compilerPolicyVersion: "test",
    providerCatalogVersion: "test",
    providerCatalogChecksum: "c".repeat(64),
    productionBundleSha256: "f".repeat(64),
    canaryHarnessSha256: "0".repeat(64),
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
  });

  assert.equal(report.metrics.baselineComparableCases, 0);
  assert.equal(report.metrics.baselinePrecisionAt10, 0);
  assert.equal(report.metrics.precisionDelta, 0.9);
  assert.equal(report.hardGates.baselineComparable, false);
  assert.equal(report.hardGates.precisionDelta, true);
  assert.equal(report.decision, "FAIL");
});

test("live search canary derives frozen top-10 counts from one bounded production-pool review", () => {
  assert.equal(
    typeof searchLiveCanary.resolveSearchCanaryPoolReview,
    "function",
  );
  assert.deepEqual(
    searchLiveCanary.resolveSearchCanaryPoolReview(15, [2, 9, 12]),
    {
      poolCandidateCount: 15,
      poolReviewed: 15,
      poolRelevant: 3,
      top10CandidateCount: 10,
      top10Reviewed: 10,
      top10Relevant: 2,
    },
  );
  assert.deepEqual(
    searchLiveCanary.resolveSearchCanaryPoolReview(0, []),
    {
      poolCandidateCount: 0,
      poolReviewed: 0,
      poolRelevant: 0,
      top10CandidateCount: 0,
      top10Reviewed: 0,
      top10Relevant: 0,
    },
  );
});

test("live search canary rejects malformed or overflowing production-pool ranks", () => {
  assert.equal(
    typeof searchLiveCanary.resolveSearchCanaryPoolReview,
    "function",
  );
  for (const [candidateCount, relevantRanks] of [
    [15, undefined],
    [15, [1, 1]],
    [15, [0]],
    [15, [16]],
    [15, [1.5]],
    [51, []],
  ]) {
    assert.throws(
      () => searchLiveCanary.resolveSearchCanaryPoolReview(
        candidateCount,
        relevantRanks,
      ),
      /pool|candidate|rank|review/i,
    );
  }
});

test("live search canary projects complete bounded provider work without arm IDs", () => {
  assert.equal(
    typeof searchLiveCanary.resolveSearchCanaryProviderObservation,
    "function",
  );
  const effectiveArm = {
    id: "arm-precision-11111111",
    planArmId: "arm-precision-11111111",
    type: "precision",
    role: "primary",
  };
  const rawCoverage = {
    retrievalArms: 2,
    completedRetrievalArms: 1,
    executedRetrievalArms: [effectiveArm],
    upstreamRequests: 1,
    cardsAccepted: 10,
    detailsRequested: 3,
    categoryResolution: { status: "not_needed", requests: 0 },
  };
  assert.deepEqual(
    searchLiveCanary.resolveSearchCanaryProviderObservation(rawCoverage, {
      required: true,
    }),
    {
      counts: {
        plannedRetrievalArms: 2,
        completedRetrievalArms: 1,
        retrievalRequests: 1,
        cardsAccepted: 10,
        detailsRequests: 3,
        categoryResolutionRequests: 0,
        totalProviderRequests: 4,
      },
      executedArms: [effectiveArm],
      categoryResolutionStatus: "not_needed",
    },
  );
  assert.deepEqual(
    searchLiveCanary.resolveSearchCanaryProviderObservation(undefined),
    {
      counts: {},
      executedArms: [],
      categoryResolutionStatus: "unreported",
    },
  );

  for (const mutate of [
    (coverage) => {
      coverage.completedRetrievalArms = 2;
    },
    (coverage) => {
      coverage.upstreamRequests = 0;
    },
    (coverage) => {
      coverage.detailsRequested = 11;
    },
    (coverage) => {
      coverage.categoryResolution = { status: "resolved", requests: 0 };
    },
    (coverage) => {
      coverage.executedRetrievalArms = [];
    },
  ]) {
    const invalid = structuredClone(rawCoverage);
    mutate(invalid);
    assert.throws(
      () => searchLiveCanary.resolveSearchCanaryProviderObservation(invalid, {
        required: true,
      }),
      /provider|coverage|bounded/i,
    );
  }
});

test("live search canary requires unique provider identities and bounded retrieval-arm provenance", () => {
  assert.equal(
    typeof searchLiveCanary.validateSearchCanaryExecutedArms,
    "function",
  );
  assert.equal(
    typeof searchLiveCanary.validateSearchCanaryPoolProvenance,
    "function",
  );
  const firstIdentity = identityHash("pool-first");
  const secondIdentity = identityHash("pool-second");
  const valid = [
    {
      identityHashes: [firstIdentity],
      retrievalArms: [{
        id: "arm-precision-11111111",
        type: "precision",
        role: "primary",
      }],
    },
    {
      identityHashes: [secondIdentity],
      retrievalArms: [{
        id: "arm-fallback-22222222",
        type: "fallback",
        role: "fallback",
      }],
    },
  ];
  const plannedArms = valid.flatMap((candidate) => candidate.retrievalArms);
  const executedArms = plannedArms.map((arm) => ({
    ...arm,
    planArmId: arm.id,
  }));
  assert.deepEqual(
    searchLiveCanary.validateSearchCanaryExecutedArms(
      executedArms,
      plannedArms,
      {
        categoryResolutionStatus: "not_needed",
        categoryResolutionRequests: 0,
        plannedRetrievalArms: 2,
        completedRetrievalArms: 2,
      },
    ),
    plannedArms,
  );
  assert.equal(
    searchLiveCanary.validateSearchCanaryPoolProvenance(valid, plannedArms),
    true,
  );
  for (const candidates of [
    [valid[0], { ...valid[1], identityHashes: [firstIdentity] }],
    [{ ...valid[0], identityHashes: [] }],
    [{ ...valid[0], retrievalArms: [] }],
    [{
      ...valid[0],
      retrievalArms: [{
        id: "unsafe-arm",
        type: "precision",
        role: "primary",
      }],
    }],
  ]) {
    assert.throws(
      () => searchLiveCanary.validateSearchCanaryPoolProvenance(
        candidates,
        plannedArms,
      ),
      /identity|provenance|arm|pool/i,
    );
  }
  assert.throws(
    () => searchLiveCanary.validateSearchCanaryPoolProvenance(
      [{
        ...valid[0],
        retrievalArms: [{
          id: "arm-precision-33333333",
          type: "fallback",
          role: "fallback",
        }],
      }],
      [{
        id: "arm-fallback-33333333",
        type: "fallback",
        role: "fallback",
      }],
    ),
    /arm|provenance/i,
  );

  const originalFallback = [{
    id: "arm-fallback-b8cb9a7f",
    type: "fallback",
    role: "fallback",
  }];
  const resolvedFallbackCandidate = [{
    identityHashes: [identityHash("resolved-fallback")],
    retrievalArms: [{
      id: "arm-fallback-60c40b19",
      type: "fallback",
      role: "fallback",
    }],
  }];
  const resolvedExecutedArms = [{
    ...resolvedFallbackCandidate[0].retrievalArms[0],
    planArmId: originalFallback[0].id,
  }];
  assert.throws(
    () => searchLiveCanary.validateSearchCanaryExecutedArms(
      resolvedExecutedArms,
      originalFallback,
      {
        categoryResolutionStatus: "degraded",
        categoryResolutionRequests: 0,
        plannedRetrievalArms: 1,
        completedRetrievalArms: 1,
      },
    ),
    /arm|replacement|provenance/i,
  );
  assert.throws(
    () => searchLiveCanary.validateSearchCanaryPoolProvenance(
      resolvedFallbackCandidate,
      originalFallback,
    ),
    /arm|provenance/i,
  );
  assert.deepEqual(
    searchLiveCanary.validateSearchCanaryExecutedArms(
      resolvedExecutedArms,
      originalFallback,
      {
        categoryResolutionStatus: "resolved",
        categoryResolutionRequests: 1,
        plannedRetrievalArms: 1,
        completedRetrievalArms: 1,
      },
    ),
    resolvedFallbackCandidate[0].retrievalArms,
  );
  assert.deepEqual(
    searchLiveCanary.validateSearchCanaryExecutedArms(
      resolvedExecutedArms,
      originalFallback,
      {
        categoryResolutionStatus: "degraded",
        categoryResolutionRequests: 1,
        plannedRetrievalArms: 1,
        completedRetrievalArms: 1,
      },
    ),
    resolvedFallbackCandidate[0].retrievalArms,
  );
  assert.equal(
    searchLiveCanary.validateSearchCanaryPoolProvenance(
      resolvedFallbackCandidate,
      resolvedFallbackCandidate[0].retrievalArms,
    ),
    true,
  );
  for (const invalidExecutedArms of [
    [{ ...resolvedExecutedArms[0], planArmId: "arm-fallback-ffffffff" }],
    [{ ...resolvedExecutedArms[0], type: "precision", role: "primary" }],
    [{ ...resolvedExecutedArms[0], planArmId: originalFallback[0].id }, {
      id: "arm-fallback-70d50c2a",
      planArmId: originalFallback[0].id,
      type: "fallback",
      role: "fallback",
    }],
  ]) {
    assert.throws(
      () => searchLiveCanary.validateSearchCanaryExecutedArms(
        invalidExecutedArms,
        originalFallback,
        {
          categoryResolutionStatus: "resolved",
          categoryResolutionRequests: 1,
          plannedRetrievalArms: 1,
          completedRetrievalArms: invalidExecutedArms.length,
        },
      ),
      /arm|provenance|executed|plan/i,
    );
  }
});

test("live search canary attainable@10 keeps the frozen 120-slot denominator", () => {
  const report = summarizeSearchCanary(
    attainableRecords({
      poolCandidateCount: 4,
      poolRelevant: 4,
      top10Relevant: 4,
    }),
    attainableVersionInput,
  );

  assert.equal(report.metrics.precisionAt10, 0.4);
  assert.equal(report.metrics.attainableAt10, 0.4);
  assert.equal(report.metrics.conditionalRankerRecallAt10, 1);
  assert.equal(report.sampleCounts.attainablePoolReviewed, 48);
});

test("live search canary attainable@10 caps every case at ten relevant pool candidates", () => {
  const report = summarizeSearchCanary(
    attainableRecords({
      poolCandidateCount: 20,
      poolRelevant: 12,
      top10Relevant: 8,
    }),
    attainableVersionInput,
  );

  assert.equal(report.metrics.precisionAt10, 0.8);
  assert.equal(report.metrics.attainableAt10, 1);
  assert.equal(report.metrics.conditionalRankerRecallAt10, 0.8);
  assert.equal(report.sampleCounts.attainablePoolReviewed, 240);
});

test("live search canary keeps old quality metrics and decision independent of attainable headroom", () => {
  const report = summarizeSearchCanary(
    attainableRecords({
      poolCandidateCount: 20,
      poolRelevant: 12,
      top10Relevant: 8,
      baselineRelevant: 6,
    }),
    attainableVersionInput,
  );

  assert.equal(report.metrics.schemaPassRate, 1);
  assert.equal(report.metrics.executablePlanRate, 1);
  assert.equal(report.metrics.precisionAt10, 0.8);
  assert.equal(report.metrics.baselinePrecisionAt10, 0.6);
  assert.equal(report.metrics.precisionDelta, 0.2);
  assert.equal(report.hardGates.precisionAt10, false);
  assert.equal(Object.hasOwn(report.hardGates, "attainableAt10"), false);
  assert.equal(Object.hasOwn(SEARCH_CANARY_THRESHOLDS, "attainableAt10"), false);
  assert.equal(report.decision, "FAIL");
});

test("live search canary classifies an invalid attainable measurement", () => {
  const records = attainableRecords({
    poolCandidateCount: 20,
    poolRelevant: 20,
    top10Relevant: 10,
  });
  records[0].inventedFactViolations = 1;

  const report = summarizeSearchCanary(records, attainableVersionInput);

  assert.equal(
    report.decisionSupport.executedArmPool.qualityGapClassification,
    "invalid_measurement",
  );
});

test("live search canary routes a valid low attainable ceiling to retrieval or source work", () => {
  const report = summarizeSearchCanary(
    attainableRecords({
      poolCandidateCount: 10,
      poolRelevant: 9,
      top10Relevant: 9,
    }),
    attainableVersionInput,
  );

  assert.equal(report.metrics.attainableAt10, 0.9);
  assert.equal(
    report.decisionSupport.executedArmPool.qualityGapClassification,
    "retrieval_or_source_gap",
  );
});

test("live search canary routes sufficient attainable headroom and low fixed-k quality to ranking", () => {
  const report = summarizeSearchCanary(
    attainableRecords({
      poolCandidateCount: 12,
      poolRelevant: 10,
      top10Relevant: 8,
    }),
    attainableVersionInput,
  );

  assert.equal(report.metrics.attainableAt10, 1);
  assert.equal(report.metrics.precisionAt10, 0.8);
  assert.equal(
    report.decisionSupport.executedArmPool.qualityGapClassification,
    "ranking_or_fusion_gap",
  );
});

test("live search canary reports when the fixed-k precision target is already met", () => {
  const report = summarizeSearchCanary(
    attainableRecords({
      poolCandidateCount: 12,
      poolRelevant: 10,
      top10Relevant: 9,
    }),
    attainableVersionInput,
  );

  assert.equal(report.metrics.precisionAt10, 0.9);
  assert.equal(
    report.decisionSupport.executedArmPool.qualityGapClassification,
    "fixed_k_precision_target_met",
  );
});

test("live search canary treats the exact attainable threshold as ranking headroom", () => {
  const records = attainableRecords({
    poolCandidateCount: 12,
    poolRelevant: 10,
    top10Relevant: 8,
  });
  for (let index = 0; index < records.length / 2; index += 1) {
    records[index].attainablePoolRelevant = 9;
  }

  const report = summarizeSearchCanary(records, attainableVersionInput);

  assert.equal(report.metrics.attainableAt10, 0.95);
  assert.equal(
    report.decisionSupport.executedArmPool.qualityGapClassification,
    "ranking_or_fusion_gap",
  );
});

test("live search canary never approves ranker tuning on unsafe pool evidence", () => {
  const records = attainableRecords({
    poolCandidateCount: 20,
    poolRelevant: 20,
    top10Relevant: 10,
  });
  for (const record of records) record.inventedFactViolations = 1;
  const report = summarizeSearchCanary(records, attainableVersionInput);

  assert.equal(report.metrics.attainableAt10, 1);
  assert.equal(report.hardGates.safetyViolations, 12);
  assert.equal(report.decisionSupport.executedArmPool.measurementValid, false);
  assert.equal(
    report.decisionSupport.executedArmPool.rankerOnlyTuningEligible,
    false,
  );
});

test("live search canary requires Kimi schema and executable plans before ranker tuning", () => {
  const records = attainableRecords({
    poolCandidateCount: 20,
    poolRelevant: 20,
    top10Relevant: 10,
  });
  for (const record of records) {
    record.kimiUsed = false;
    record.schemaPassed = false;
    record.executablePlan = false;
  }
  const report = summarizeSearchCanary(records, attainableVersionInput);

  assert.equal(report.metrics.attainableAt10, 1);
  assert.equal(report.hardGates.allCasesUsedKimi, false);
  assert.equal(report.hardGates.schemaPass, false);
  assert.equal(report.hardGates.executablePlans, false);
  assert.equal(report.decisionSupport.executedArmPool.measurementValid, false);
  assert.equal(
    report.decisionSupport.executedArmPool.rankerOnlyTuningEligible,
    false,
  );
});

test("live search canary attainable aggregates never persist identities or review ranks", () => {
  const records = attainableRecords();
  const privateIdentity = records[0].semanticRelevantIdentityGroups[0][0];
  const report = summarizeSearchCanary(records, attainableVersionInput);
  const serialized = JSON.stringify(report);

  assert.equal(serialized.includes(privateIdentity), false);
  assert.equal(serialized.includes("identity"), false);
  assert.equal(serialized.includes("relevantRanks"), false);
  assert.equal(serialized.includes('"name"'), false);
  assert.equal(serialized.includes('"address"'), false);
  assert.equal(serialized.includes('"phone"'), false);
  assert.equal(serialized.includes("arm-"), false);
});

test("live search canary fails closed on missing, inconsistent or overflowing pool aggregates", () => {
  const mutations = [
    (record) => {
      delete record.attainablePoolRelevant;
    },
    (record) => {
      record.attainablePoolCandidateCount = 51;
      record.attainablePoolReviewed = 51;
    },
    (record) => {
      record.attainablePoolReviewed = record.attainablePoolCandidateCount - 1;
    },
    (record) => {
      record.attainablePoolRelevant = record.attainablePoolCandidateCount + 1;
    },
    (record) => {
      record.semanticCandidateCount = 9;
      record.semanticReviewed = 9;
    },
    (record) => {
      record.attainablePoolRelevant = 12;
      record.semanticRelevant = 0;
      record.semanticRelevantIdentityGroups = [];
    },
    (record) => {
      delete record.providerCoverage;
    },
    (record) => {
      record.providerCoverage = { retrievalRequests: 5 };
    },
    (record) => {
      record.providerCoverage = { rawLeadName: 1 };
    },
    (record) => {
      record.providerCoverage.completedRetrievalArms = 3;
    },
    (record) => {
      record.providerCoverage.retrievalRequests = 1;
      record.providerCoverage.totalProviderRequests = 4;
    },
    (record) => {
      record.providerCoverage.totalProviderRequests = 4;
    },
    (record) => {
      record.providerCoverage.cardsAccepted = 11;
    },
    (record) => {
      record.providerCoverage.detailsRequests = 11;
      record.providerCoverage.totalProviderRequests = 13;
    },
    (record) => {
      record.providerCoverage.categoryResolutionRequests = 1;
      record.providerCoverage.totalProviderRequests = 6;
    },
    (record) => {
      record.categoryResolutionStatus = "resolved";
    },
  ];

  for (const mutate of mutations) {
    const records = structuredClone(attainableRecords());
    mutate(records[0]);
    assert.throws(
      () => summarizeSearchCanary(records, attainableVersionInput),
      /pool|review|candidate|incomplete|invalid/i,
    );
  }
});
