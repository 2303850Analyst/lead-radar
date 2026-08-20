import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  SEARCH_CANARY_CASES,
  SEARCH_CANARY_EVALUATION_POLICY_VERSION,
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
} from "../scripts/lib/search-live-canary.mjs";

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
    attemptCount: 1,
    firstAttemptSucceeded: true,
    failedAttemptCodes: [],
    attemptTimings: [attemptTiming({ first: 100 + index, encoder: 5_000 + index, terminal: 10_000 + index })],
    semanticJourneyMs: 10_000 + index,
    semanticCandidateCount: 10,
    semanticReviewed: 10,
    semanticRelevant: 9,
    semanticRelevantIdentityGroups,
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
  assert.equal(
    report.versions.evaluationPolicy,
    SEARCH_CANARY_EVALUATION_POLICY_VERSION,
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
  assert.equal(report.caseMetrics.length, SEARCH_CANARY_CASES.length);
  assert.deepEqual(report.caseMetrics[0], {
    id: SEARCH_CANARY_CASES[0].id,
    semanticReviewed: 10,
    semanticRelevant: 9,
    semanticPrecisionAt10: 0.9,
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
    firstAttemptSucceeded: false,
    failedAttemptCodes: ["INVALID_SEARCH_PAYLOAD"],
    attemptTimings: [
      attemptTiming({ succeeded: false, encoder: null, terminal: 1_000 }),
    ],
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
    attemptCount: 1,
    firstAttemptSucceeded: true,
    failedAttemptCodes: [],
    attemptTimings: [attemptTiming()],
    semanticJourneyMs: 10_000,
    semanticCandidateCount: 10,
    semanticReviewed: 10,
    semanticRelevant: 9,
    semanticRelevantIdentityGroups: identityGroups(`${entry.id}-empty-semantic`, 9),
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
