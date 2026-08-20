import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKimiComparisonDecision,
  evaluateProductionJourneyGate,
  evaluateKimiOutcomeContract,
  KIMI_COMPARISON_CASE_IDS,
  KIMI_MINIMUM_EXPECTED_OUTCOME_RATE,
  selectKimiProfile,
  summarizeKimiProfile,
} from "./helpers/kimi-model-comparison.mjs";
import {
  expandOpenWorldCases,
  loadOpenWorldFixture,
} from "./helpers/open-world-evaluation.mjs";
import {
  applySearchCanaryKimiProfileToEnv,
  resolveSearchCanaryKimiProfile,
  searchCanaryRuntimeProfile,
} from "../scripts/lib/search-canary-profile.mjs";

const pricing = Object.freeze({ cachedInput: 0.3, input: 3, output: 15 });

function attempts(
  count,
  {
    apiLatencyMs = 10_000,
    wallLatencyMs = apiLatencyMs + 100,
    expectedOutcome = true,
  } = {},
) {
  return Array.from({ length: count }, () => ({
    ok: true,
    schemaPassed: true,
    executionContractPassed: true,
    nonReadyExecutionLeak: false,
    expectedOutcome,
    firstSseEventLatencyMs: 400,
    apiLatencyMs,
    wallLatencyMs,
    inputTokens: 1_000,
    cachedInputTokens: 200,
    outputTokens: 100,
    errorCode: null,
    retryable: false,
  }));
}

function summary(id, profileAttempts, overrides = {}) {
  return summarizeKimiProfile({
    profile: { id, pricingUsdPerMillion: pricing },
    modelId: overrides.modelId ?? id,
    cacheIdentity: `policy:${id}`,
    modelCanary: {
      configuredModelAvailable: true,
      modelCount: 2,
      latencyMs: 50,
      errorCode: null,
    },
    attempts: profileAttempts,
    expectedAttemptCount: 30,
  });
}

test("selection picks a fast eligible candidate when the quality baseline is slow", () => {
  const slowBaseline = summary(
    "k3-low",
    attempts(30, { apiLatencyMs: 25_000 }),
  );
  const fastCandidate = summary(
    "k2.6-thinking-disabled",
    attempts(30, { apiLatencyMs: 9_000 }),
  );

  const result = selectKimiProfile([slowBaseline, fastCandidate]);

  assert.equal(result.baselineMeasured, true);
  assert.equal(KIMI_MINIMUM_EXPECTED_OUTCOME_RATE, 1);
  assert.equal(result.expectedOutcomeFloor, 1);
  assert.equal(result.selectedProfileId, "k2.6-thinking-disabled");
  assert.equal(result.profiles[0].eligible, false);
  assert.equal(result.profiles[1].eligible, true);
});

test("selection rejects a fast candidate that regresses open-world outcomes", () => {
  const slowBaseline = summary(
    "k3-low",
    attempts(30, { apiLatencyMs: 25_000 }),
  );
  const regressed = attempts(30, { apiLatencyMs: 9_000 });
  for (let index = 0; index < 4; index += 1) {
    regressed[index].expectedOutcome = false;
  }

  const result = selectKimiProfile([
    slowBaseline,
    summary("k2.6-thinking-disabled", regressed),
  ]);

  assert.equal(result.selectedProfileId, null);
  assert.equal(result.profiles[1].metrics.expectedOutcomeRate, 0.8667);
  assert.equal(result.profiles[1].gates.expectedOutcomeNonRegression, false);
});

test("degraded encoder outcomes are failures even when the planner returns", () => {
  const degraded = attempts(30);
  degraded[0] = {
    ...degraded[0],
    ok: false,
    schemaPassed: false,
    executionContractPassed: false,
    nonReadyExecutionLeak: false,
    expectedOutcome: false,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    errorCode: "KIMI_RATE_LIMITED",
    retryable: true,
  };

  const result = summary("k3-low", degraded);

  assert.equal(result.failedAttempts, 1);
  assert.equal(result.retryableFailures, 1);
  assert.deepEqual(result.failureCodes, { KIMI_RATE_LIMITED: 1 });
  assert.equal(result.baseGates.noEncoderFailures, false);
  assert.equal(result.baseGates.completeUsageAndCost, false);
});

test("invalid Kimi responses retain only bounded aggregate reason codes", () => {
  const invalid = attempts(30);
  invalid[0] = {
    ...invalid[0],
    ok: false,
    schemaPassed: false,
    executionContractPassed: false,
    expectedOutcome: false,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    errorCode: "KIMI_INVALID_RESPONSE",
    invalidResponseReason: "sse_missing_choices",
    semanticValidationIssueCodes: ["array_size"],
    retryable: true,
  };

  const result = summary("k3-low", invalid);

  assert.deepEqual(result.invalidResponseReasons, {
    sse_missing_choices: 1,
  });
  assert.deepEqual(result.semanticValidationIssues, { array_size: 1 });
});

test("deadline violations block eligibility", () => {
  const unsafe = attempts(30);
  unsafe[0].wallLatencyMs = 60_001;
  const summarized = summary("k3-low", unsafe);
  const result = selectKimiProfile([summarized]);

  assert.equal(summarized.attemptDeadlineViolations, 1);
  assert.equal(summarized.baseGates.everyAttemptAtMost60Seconds, false);
  assert.equal(result.selectedProfileId, null);
});

test("missing cached-token usage is priced conservatively without hiding it", () => {
  const withoutCachedUsage = attempts(30);
  for (const attempt of withoutCachedUsage) {
    attempt.cachedInputTokens = null;
  }

  const summarized = summary("k3-low", withoutCachedUsage);
  const result = selectKimiProfile([summarized]);

  assert.equal(summarized.attemptsWithUnknownUsage, 0);
  assert.equal(summarized.attemptsWithUnknownCachedUsage, 30);
  assert.equal(summarized.metrics.estimatedConservativeCostUsd, 0.135);
  assert.equal(summarized.baseGates.completeUsageAndCost, true);
  assert.equal(result.selectedProfileId, "k3-low");
});

test("a non-ready outcome with executable selectors is never eligible", () => {
  const unsafe = attempts(30);
  unsafe[0] = {
    ...unsafe[0],
    executionContractPassed: false,
    nonReadyExecutionLeak: true,
  };

  const summarized = summary("k3-low", unsafe);
  const result = selectKimiProfile([summarized]);

  assert.equal(summarized.nonReadyExecutionLeaks, 1);
  assert.equal(summarized.baseGates.noNonReadyExecutionLeaks, false);
  assert.equal(summarized.baseGates.exactExecutionContract, false);
  assert.equal(result.selectedProfileId, null);
});

test("frozen comparison corpus mixes six unseen physical and four safety outcomes", async () => {
  const fixture = await loadOpenWorldFixture();
  const entries = new Map(
    expandOpenWorldCases(fixture).map((entry) => [entry.id, entry]),
  );
  const cases = KIMI_COMPARISON_CASE_IDS.map((id) => entries.get(id));

  assert.equal(new Set(KIMI_COMPARISON_CASE_IDS).size, 10);
  assert.equal(cases.every(Boolean), true);
  const ready = cases.filter((entry) => entry.expectedOutcome === "ready");
  assert.equal(ready.length, 6);
  assert.equal(ready.every((entry) => entry.novel && entry.split === "holdout"), true);
  assert.equal(
    cases.filter((entry) => entry.expectedOutcome === "needs_confirmation").length,
    2,
  );
  assert.equal(cases.filter((entry) => entry.kind === "non_place").length, 1);
  assert.equal(cases.filter((entry) => entry.kind === "injection").length, 1);
});

test("outcome contract requires exact non-ready status with no top-level selectors", () => {
  const safe = evaluateKimiOutcomeContract(
    {
      status: "needs_confirmation",
      resolution: { selectedConceptIds: [] },
      executionPreview: null,
    },
    { expectedOutcome: "needs_confirmation", providerCategoryId: null },
  );
  const leaked = evaluateKimiOutcomeContract(
    {
      status: "needs_confirmation",
      resolution: { selectedConceptIds: ["unsafe.selector"] },
      executionPreview: { categoryLabels: ["unsafe.selector"], retrievalArms: [{}] },
    },
    { expectedOutcome: "needs_confirmation", providerCategoryId: null },
  );
  const wrongStatus = evaluateKimiOutcomeContract(
    {
      status: "unsupported",
      resolution: { selectedConceptIds: [] },
      executionPreview: null,
    },
    { expectedOutcome: "needs_confirmation", providerCategoryId: null },
  );

  assert.deepEqual(safe, {
    exactExpectedOutcome: true,
    executionContractPassed: true,
    nonReadyExecutionLeak: false,
  });
  assert.equal(leaked.executionContractPassed, false);
  assert.equal(leaked.nonReadyExecutionLeak, true);
  assert.equal(wrongStatus.executionContractPassed, false);
});

const expectedCanaryVersions = Object.freeze({
  app: "0.4.0-alpha.1",
  model: "kimi-k2.6",
  modelPolicy: "kimi-model-policy/2026-08-20.4",
  prompt:
    "semantic-intent-v2/2026-08-20.4+kimi-model-policy/2026-08-20.4:kimi-k2.6:k2.6-thinking-disabled:none",
  semanticIntentSchema: "2.1",
  searchPlanSchema: "2.2",
  decisionPolicy: "decision-current",
  compilerPolicy: "compiler-current",
  providerCatalog: "catalog-current",
  providerCatalogChecksum: "a".repeat(64),
  productionBundleSha256: "b".repeat(64),
  canaryHarnessSha256: "c".repeat(64),
  evaluationPolicy: "evaluation-current",
  caseSetChecksum: "d".repeat(64),
  rubric: "rubric-current",
  rubricChecksum: "e".repeat(64),
  thresholds: {
    firstProgressP95Ms: 500,
    terminalP95Ms: 55_000,
    requestDeadlineMs: 60_000,
  },
  runtimeProfile: {
    profileId: "k2.6-thinking-disabled",
    model: "kimi-k2.6",
    modelMode: "k2.6-thinking-disabled",
    reasoningEffort: null,
    cacheIdentity:
      "kimi-model-policy/2026-08-20.4:kimi-k2.6:k2.6-thinking-disabled:none",
  },
  pricingUsdPerMillion: { input: 0.95, output: 4 },
});

function productionCanary({ versions = {}, ...overrides } = {}) {
  return {
    evaluation: "LeadRadar production search Kimi + Geoapify canary",
    aggregateOnly: true,
    decision: "PASS",
    finishedAt: "2026-08-20T09:30:00.000Z",
    versions: { ...structuredClone(expectedCanaryVersions), ...versions },
    sampleCounts: { cases: 12 },
    metrics: {
      firstProgressP95Ms: 450,
      terminalP95Ms: 54_000,
    },
    hardGates: { deadline: true },
    sloObservations: {
      firstProgressP95TargetMet: true,
      terminalP95TargetMet: true,
      globalDeadlineMet: true,
    },
    ...overrides,
  };
}

function productionGateOptions(selectedProfileId = "k2.6-thinking-disabled") {
  return {
    now: new Date("2026-08-20T10:00:00.000Z"),
    selectedProfileId,
    expectedVersions: expectedCanaryVersions,
  };
}

test("server-owned canary profile allowlist resolves K3 and K2.6 exactly", () => {
  const k3 = resolveSearchCanaryKimiProfile(undefined);
  const k26 = resolveSearchCanaryKimiProfile("k2.6-thinking-disabled");

  assert.deepEqual(
    {
      id: k3.id,
      model: k3.model,
      modelMode: k3.modelMode,
      reasoningEffort: k3.reasoningEffort,
      cacheIdentity: k3.cacheIdentity,
    },
    {
      id: "k3-low",
      model: "kimi-k3",
      modelMode: "k3-reasoning",
      reasoningEffort: "low",
      cacheIdentity:
        "kimi-model-policy/2026-08-20.4:kimi-k3:k3-reasoning:low",
    },
  );
  assert.equal(k26.id, "k2.6-thinking-disabled");
  assert.equal(k26.model, "kimi-k2.6");
  assert.equal(k26.reasoningEffort, null);
  assert.equal(k26.modelMode, "k2.6-thinking-disabled");
  assert.throws(
    () => resolveSearchCanaryKimiProfile("kimi-k3-from-client"),
    /server-owned Kimi profile/,
  );

  const env = { KIMI_PLANNER_REASONING_EFFORT: "client-value" };
  applySearchCanaryKimiProfileToEnv(k26, env);
  assert.equal(env.KIMI_PLANNER_MODEL, "kimi-k2.6");
  assert.equal(Object.hasOwn(env, "KIMI_PLANNER_REASONING_EFFORT"), false);
  assert.equal(searchCanaryRuntimeProfile(k26).cacheIdentity, k26.cacheIdentity);
  applySearchCanaryKimiProfileToEnv(k3, env);
  assert.equal(env.KIMI_PLANNER_MODEL, "kimi-k3");
  assert.equal(env.KIMI_PLANNER_REASONING_EFFORT, "low");
  assert.deepEqual(k26.pricingUsdPerMillion, {
    cachedInput: 0.16,
    input: 0.95,
    output: 4,
  });
  applySearchCanaryKimiProfileToEnv(
    { ...k3, model: "client-supplied-model", reasoningEffort: "max" },
    env,
  );
  assert.equal(env.KIMI_PLANNER_MODEL, "kimi-k3");
  assert.equal(env.KIMI_PLANNER_REASONING_EFFORT, "low");
});

test("encoder PASS remains an incomplete non-blocking release decision without a production journey", () => {
  const selection = selectKimiProfile([
    summary("k2.6-thinking-disabled", attempts(30)),
  ], { baselineProfileId: "k2.6-thinking-disabled" });
  const journeyGate = evaluateProductionJourneyGate(null, {
    now: new Date("2026-08-20T10:00:00.000Z"),
    selectedProfileId: selection.selectedProfileId,
    expectedVersions: expectedCanaryVersions,
  });

  const decision = buildKimiComparisonDecision(selection, journeyGate);

  assert.equal(decision.encoderDecision, "PASS");
  assert.equal(decision.releaseDecision, "INCOMPLETE");
  assert.equal(decision.evaluationStatus, "PARTIAL");
  assert.equal(decision.gateMode, "NON_BLOCKING");
  assert.equal(decision.canUnblockIssue14, false);
});

test("an incomplete A/B sample cannot report encoder PASS", () => {
  const selection = selectKimiProfile([
    summary("k2.6-thinking-disabled", attempts(30)),
  ], { baselineProfileId: "k2.6-thinking-disabled" });

  const decision = buildKimiComparisonDecision(selection, null, {
    encoderHardGates: { allProfilesMeasured: false },
  });

  assert.equal(decision.encoderDecision, "FAIL");
  assert.equal(decision.releaseDecision, "FAIL");
  assert.equal(decision.canUnblockIssue14, false);
});

test("a current matching production canary can complete the release decision", () => {
  const selection = selectKimiProfile([
    summary("k2.6-thinking-disabled", attempts(30)),
  ], { baselineProfileId: "k2.6-thinking-disabled" });
  const journeyGate = evaluateProductionJourneyGate(
    productionCanary(),
    productionGateOptions(selection.selectedProfileId),
  );

  const decision = buildKimiComparisonDecision(selection, journeyGate);

  assert.equal(journeyGate.passed, true);
  assert.equal(decision.releaseDecision, "PASS");
  assert.equal(decision.canUnblockIssue14, true);
});

test("production journey fails closed on stale, mismatched, or slow reports", () => {
  const now = new Date("2026-08-20T10:00:00.000Z");
  const cases = [
    productionCanary({ decision: "FAIL" }),
    productionCanary({ finishedAt: "2026-08-18T09:30:00.000Z" }),
    productionCanary({
      versions: {
        runtimeProfile: {
          ...expectedCanaryVersions.runtimeProfile,
          profileId: "k3-low",
          model: "kimi-k3",
          modelMode: "k3-reasoning",
          reasoningEffort: "low",
        },
      },
    }),
    productionCanary({
      metrics: { firstProgressP95Ms: 501, terminalP95Ms: 54_000 },
    }),
    productionCanary({
      metrics: { firstProgressP95Ms: 450, terminalP95Ms: 55_001 },
    }),
    productionCanary({ hardGates: { deadline: false } }),
  ];

  for (const report of cases) {
    assert.equal(
      evaluateProductionJourneyGate(report, {
        ...productionGateOptions(),
        now,
      }).passed,
      false,
    );
  }
});

test("production journey rejects obsolete behavior and artifact versions", () => {
  for (const versions of [
    { modelPolicy: "obsolete-model-policy" },
    { prompt: "obsolete-prompt" },
    { semanticIntentSchema: "obsolete-semantic-schema" },
    { searchPlanSchema: "obsolete-plan-schema" },
    { decisionPolicy: "obsolete-policy" },
    { compilerPolicy: "obsolete-compiler" },
    { providerCatalog: "obsolete-catalog" },
    { providerCatalogChecksum: "f".repeat(64) },
    { productionBundleSha256: "0".repeat(64) },
    { canaryHarnessSha256: "1".repeat(64) },
    { evaluationPolicy: "obsolete-evaluation" },
    { caseSetChecksum: "2".repeat(64) },
    { rubric: "obsolete-rubric" },
    { rubricChecksum: "3".repeat(64) },
    {
      runtimeProfile: {
        ...expectedCanaryVersions.runtimeProfile,
        cacheIdentity: "obsolete-cache-identity",
      },
    },
  ]) {
    const gate = evaluateProductionJourneyGate(
      productionCanary({ versions }),
      productionGateOptions(),
    );
    assert.equal(gate.passed, false, Object.keys(versions)[0]);
    assert.equal(gate.gates.currentVersionsAndArtifacts, false);
  }
});
