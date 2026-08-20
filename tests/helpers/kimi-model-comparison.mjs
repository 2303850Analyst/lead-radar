import {
  percentile,
  ratio,
  roundMetric,
} from "./evaluation-metrics.mjs";
import { GEOAPIFY_CAPABILITY_REGISTRY } from "../../lib/search-planner/catalogs/geoapify.ts";

export const KIMI_COMPARISON_CASE_IDS = Object.freeze([
  "physical-music-school-01",
  "physical-music-school-04",
  "physical-climbing-park-01",
  "physical-cardiology-clinic-04",
  "physical-pottery-workshop-01",
  "physical-fitness-gym-04",
  "amb-03",
  "amb-18",
  "non-11",
  "inj-14",
]);
export const KIMI_MINIMUM_EXPECTED_OUTCOME_RATE = 1;
const KIMI_OUTCOME_STATUSES = new Set([
  "ready",
  "needs_confirmation",
  "unsupported",
  "degraded",
]);
const GEOAPIFY_CATEGORY_ID_SET = new Set(
  GEOAPIFY_CAPABILITY_REGISTRY.categories,
);

export function nextKimiComparisonStartAt({
  now,
  lastGlobalStartAt,
  lastModelStartAt,
  minimumGlobalIntervalMs,
  minimumModelIntervalMs,
}) {
  for (const value of [
    now,
    lastGlobalStartAt,
    lastModelStartAt,
    minimumGlobalIntervalMs,
    minimumModelIntervalMs,
  ]) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Kimi comparison pacing values must be finite and non-negative");
    }
  }
  return Math.max(
    now,
    lastGlobalStartAt + minimumGlobalIntervalMs,
    lastModelStartAt + minimumModelIntervalMs,
  );
}

export function evaluateKimiOutcomeContract(plan, expectedCase) {
  const exactExpectedOutcome = plan?.status === expectedCase.expectedOutcome;
  const selectedConceptIds = plan?.resolution?.selectedConceptIds;
  const nonReadyExecutionLeak =
    expectedCase.expectedOutcome !== "ready" &&
    (plan?.executionPreview !== null ||
      !Array.isArray(selectedConceptIds) ||
      selectedConceptIds.length > 0);
  const executionContractPassed =
    expectedCase.expectedOutcome === "ready"
      ? exactExpectedOutcome &&
        Array.isArray(plan?.executionPreview?.retrievalArms) &&
        plan.executionPreview.retrievalArms.length > 0 &&
        Array.isArray(plan.executionPreview.categoryLabels) &&
        plan.executionPreview.categoryLabels.includes(
          expectedCase.providerCategoryId,
        )
      : exactExpectedOutcome && !nonReadyExecutionLeak;
  return {
    exactExpectedOutcome,
    executionContractPassed,
    nonReadyExecutionLeak,
  };
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function hasPromptAndOutputUsage(attempt) {
  return (
    Number.isFinite(attempt.inputTokens) &&
    attempt.inputTokens >= 0 &&
    Number.isFinite(attempt.outputTokens) &&
    attempt.outputTokens >= 0
  );
}

function hasReportedCachedUsage(attempt) {
  return (
    Number.isFinite(attempt.cachedInputTokens) &&
    attempt.cachedInputTokens >= 0 &&
    attempt.cachedInputTokens <= attempt.inputTokens
  );
}

function estimatedCostUsd(pricing, inputTokens, cachedInputTokens, outputTokens) {
  const nonCachedInputTokens = inputTokens - cachedInputTokens;
  return (
    (cachedInputTokens / 1_000_000) * pricing.cachedInput +
    (nonCachedInputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output
  );
}

export function summarizeKimiProfile({
  profile,
  modelId,
  cacheIdentity,
  modelCanary,
  attempts,
  expectedAttemptCount,
}) {
  const pricedUsageAttempts = attempts.filter(hasPromptAndOutputUsage);
  const inputTokens = pricedUsageAttempts.reduce(
    (sum, attempt) => sum + attempt.inputTokens,
    0,
  );
  const reportedCachedInputTokens = pricedUsageAttempts.reduce(
    (sum, attempt) =>
      sum + (hasReportedCachedUsage(attempt) ? attempt.cachedInputTokens : 0),
    0,
  );
  const outputTokens = pricedUsageAttempts.reduce(
    (sum, attempt) => sum + attempt.outputTokens,
    0,
  );
  const attemptsWithUnknownUsage = attempts.length - pricedUsageAttempts.length;
  const attemptsWithUnknownCachedUsage = pricedUsageAttempts.filter(
    (attempt) => !hasReportedCachedUsage(attempt),
  ).length;
  const conservativelyPricedAsUncachedInputTokens = pricedUsageAttempts.reduce(
    (sum, attempt) =>
      sum + (hasReportedCachedUsage(attempt) ? 0 : attempt.inputTokens),
    0,
  );
  const firstSseEventLatencies = attempts
    .map((attempt) => attempt.firstSseEventLatencyMs)
    .filter((value) => typeof value === "number");
  const apiLatencies = attempts
    .map((attempt) => attempt.apiLatencyMs)
    .filter((value) => typeof value === "number");
  const wallLatencies = attempts.map((attempt) => attempt.wallLatencyMs);
  const metrics = {
    schemaPassRate: roundMetric(
      ratio(
        attempts.filter((attempt) => attempt.schemaPassed).length,
        attempts.length,
      ),
    ),
    executionContractRate: roundMetric(
      ratio(
        attempts.filter((attempt) => attempt.executionContractPassed).length,
        attempts.length,
      ),
    ),
    expectedOutcomeRate: roundMetric(
      ratio(
        attempts.filter((attempt) => attempt.expectedOutcome).length,
        attempts.length,
      ),
    ),
    p50FirstSseEventLatencyMs: percentile(firstSseEventLatencies, 0.5),
    p95FirstSseEventLatencyMs: percentile(firstSseEventLatencies, 0.95),
    p50ApiLatencyMs: percentile(apiLatencies, 0.5),
    p95ApiLatencyMs: percentile(apiLatencies, 0.95),
    p50WallLatencyMs: percentile(wallLatencies, 0.5),
    p95WallLatencyMs: percentile(wallLatencies, 0.95),
    maxWallLatencyMs: wallLatencies.length ? Math.max(...wallLatencies) : null,
    inputTokens,
    reportedCachedInputTokens,
    conservativelyPricedAsUncachedInputTokens,
    outputTokens,
    knownUsageEstimatedConservativeCostUsd: roundMetric(
      estimatedCostUsd(
        profile.pricingUsdPerMillion,
        inputTokens,
        reportedCachedInputTokens,
        outputTokens,
      ),
      6,
    ),
    estimatedConservativeCostUsd:
      attemptsWithUnknownUsage === 0 && attempts.length > 0
        ? roundMetric(
            estimatedCostUsd(
              profile.pricingUsdPerMillion,
              inputTokens,
              reportedCachedInputTokens,
              outputTokens,
            ),
            6,
          )
        : null,
  };
  const failedAttempts = attempts.filter((attempt) => !attempt.ok).length;
  const nonReadyExecutionLeaks = attempts.filter(
    (attempt) => attempt.nonReadyExecutionLeak,
  ).length;
  const attemptDeadlineViolations = attempts.filter(
    (attempt) => attempt.wallLatencyMs > 60_000,
  ).length;
  const failureCodes = countBy(
    attempts
      .map((attempt) => attempt.errorCode)
      .filter((value) => typeof value === "string"),
  );
  const invalidResponseReasons = countBy(
    attempts
      .map((attempt) => attempt.invalidResponseReason)
      .filter((value) => typeof value === "string"),
  );
  const semanticValidationIssues = countBy(
    attempts.flatMap((attempt) =>
      Array.isArray(attempt.semanticValidationIssueCodes)
        ? attempt.semanticValidationIssueCodes.filter(
            (value) => typeof value === "string",
          )
        : [],
    ),
  );
  const unclassifiedInvalidResponses = attempts.filter(
    (attempt) =>
      attempt.errorCode === "KIMI_INVALID_RESPONSE" &&
      typeof attempt.invalidResponseReason !== "string",
  ).length;
  const caseResults = Object.fromEntries(
    [
      ...new Set(
        attempts
          .map((attempt) => attempt.caseId)
          .filter((value) => KIMI_COMPARISON_CASE_IDS.includes(value)),
      ),
    ]
      .sort()
      .map((caseId) => {
        const caseAttempts = attempts.filter(
          (attempt) => attempt.caseId === caseId,
        );
        return [
          caseId,
          {
            attemptCount: caseAttempts.length,
            schemaPassed: caseAttempts.filter((attempt) => attempt.schemaPassed)
              .length,
            expectedOutcomePassed: caseAttempts.filter(
              (attempt) => attempt.expectedOutcome,
            ).length,
            executionContractPassed: caseAttempts.filter(
              (attempt) => attempt.executionContractPassed,
            ).length,
            failureCodes: countBy(
              caseAttempts
                .map((attempt) => attempt.errorCode)
                .filter((value) => typeof value === "string"),
            ),
            invalidResponseReasons: countBy(
              caseAttempts
                .map((attempt) => attempt.invalidResponseReason)
                .filter((value) => typeof value === "string"),
            ),
            semanticValidationIssues: countBy(
              caseAttempts.flatMap((attempt) =>
                Array.isArray(attempt.semanticValidationIssueCodes)
                  ? attempt.semanticValidationIssueCodes.filter(
                      (value) => typeof value === "string",
                    )
                  : [],
              ),
            ),
            statusCounts: countBy(
              caseAttempts
                .map((attempt) => attempt.actualOutcome)
                .filter((value) => KIMI_OUTCOME_STATUSES.has(value)),
            ),
            compiledProviderCategories: countBy(
              caseAttempts.flatMap((attempt) =>
                Array.isArray(attempt.compiledProviderCategoryIds)
                  ? [
                      ...new Set(
                        attempt.compiledProviderCategoryIds.filter((value) =>
                          GEOAPIFY_CATEGORY_ID_SET.has(value),
                        ),
                      ),
                    ].slice(0, 32)
                  : [],
              ),
            ),
          },
        ];
      }),
  );
  const baseGates = {
    completeSample: attempts.length === expectedAttemptCount,
    modelAvailable: modelCanary.configuredModelAvailable === true,
    noEncoderFailures: failedAttempts === 0,
    schemaPassAtLeast95Percent: (metrics.schemaPassRate ?? 0) >= 0.95,
    exactExpectedOutcomes: metrics.expectedOutcomeRate === 1,
    exactExecutionContract: metrics.executionContractRate === 1,
    noNonReadyExecutionLeaks: nonReadyExecutionLeaks === 0,
    p95ApiLatencyAtMost20Seconds:
      typeof metrics.p95ApiLatencyMs === "number" &&
      metrics.p95ApiLatencyMs <= 20_000,
    p95EncoderWallLatencyAtMost55Seconds:
      typeof metrics.p95WallLatencyMs === "number" &&
      metrics.p95WallLatencyMs <= 55_000,
    everyAttemptAtMost60Seconds: attemptDeadlineViolations === 0,
    completeUsageAndCost:
      attemptsWithUnknownUsage === 0 &&
      typeof metrics.estimatedConservativeCostUsd === "number",
    noUnclassifiedErrors:
      !Object.hasOwn(failureCodes, "UNCLASSIFIED_LIVE_ERROR") &&
      unclassifiedInvalidResponses === 0,
  };

  return {
    profileId: profile.id,
    modelId,
    cacheIdentity,
    modelCanary,
    pricingUsdPerMillion: profile.pricingUsdPerMillion,
    expectedAttemptCount,
    attemptCount: attempts.length,
    successfulAttempts: attempts.length - failedAttempts,
    failedAttempts,
    retryableFailures: attempts.filter(
      (attempt) => !attempt.ok && attempt.retryable,
    ).length,
    nonReadyExecutionLeaks,
    attemptsWithUnknownUsage,
    attemptsWithUnknownCachedUsage,
    attemptDeadlineViolations,
    failureCodes,
    invalidResponseReasons,
    semanticValidationIssues,
    caseResults,
    unclassifiedInvalidResponses,
    metrics,
    baseGates,
  };
}

export function selectKimiProfile(
  summaries,
  {
    baselineProfileId = "k3-low",
    minimumExpectedOutcomeRate = KIMI_MINIMUM_EXPECTED_OUTCOME_RATE,
  } = {},
) {
  const baseline = summaries.find(
    (profile) => profile.profileId === baselineProfileId,
  );
  const baselineRate = baseline?.metrics.expectedOutcomeRate;
  const baselineMeasured =
    baseline?.baseGates.completeSample === true &&
    typeof baselineRate === "number";
  const expectedOutcomeFloor = baselineMeasured
    ? Math.max(minimumExpectedOutcomeRate, baselineRate)
    : null;
  const profiles = summaries.map((profile) => {
    const expectedOutcomeNonRegression =
      expectedOutcomeFloor !== null &&
      typeof profile.metrics.expectedOutcomeRate === "number" &&
      profile.metrics.expectedOutcomeRate >= expectedOutcomeFloor;
    const gates = {
      ...profile.baseGates,
      expectedOutcomeNonRegression,
    };
    return {
      ...profile,
      gates,
      eligible: Object.values(gates).every(Boolean),
    };
  });
  const eligible = profiles
    .filter((profile) => profile.eligible)
    .sort(
      (left, right) =>
        right.metrics.expectedOutcomeRate - left.metrics.expectedOutcomeRate ||
        left.metrics.p95ApiLatencyMs - right.metrics.p95ApiLatencyMs ||
        left.metrics.estimatedConservativeCostUsd -
          right.metrics.estimatedConservativeCostUsd ||
        left.profileId.localeCompare(right.profileId),
    );

  return {
    baselineProfileId,
    baselineMeasured,
    expectedOutcomeFloor,
    selectedProfileId: eligible[0]?.profileId ?? null,
    profiles,
  };
}

const PRODUCTION_JOURNEY_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const PRODUCTION_JOURNEY_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const REQUIRED_PRODUCTION_VERSION_FIELDS = Object.freeze([
  "app",
  "model",
  "modelPolicy",
  "transportSchema",
  "prompt",
  "semanticIntentSchema",
  "searchPlanSchema",
  "decisionPolicy",
  "compilerPolicy",
  "providerCatalog",
  "providerCatalogChecksum",
  "productionBundleSha256",
  "canaryHarnessSha256",
  "evaluationPolicy",
  "caseSetChecksum",
  "rubric",
  "rubricChecksum",
  "thresholds",
  "runtimeProfile",
  "pricingUsdPerMillion",
]);

function canonicalComparable(value) {
  if (Array.isArray(value)) return value.map(canonicalComparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalComparable(value[key])]),
    );
  }
  return value;
}

function productionVersionMismatches(actual, expected) {
  return REQUIRED_PRODUCTION_VERSION_FIELDS.filter(
    (field) =>
      !actual ||
      !expected ||
      !Object.hasOwn(actual, field) ||
      !Object.hasOwn(expected, field) ||
      JSON.stringify(canonicalComparable(actual[field])) !==
        JSON.stringify(canonicalComparable(expected[field])),
  );
}

function productionCanaryProfileId(report) {
  const runtimeProfile = report?.versions?.runtimeProfile;
  if (runtimeProfile?.model === "kimi-k2.6") {
    return runtimeProfile.reasoningEffort === null ||
      runtimeProfile.reasoningEffort === undefined
      ? "k2.6-thinking-disabled"
      : null;
  }
  if (
    runtimeProfile?.model === "kimi-k3" &&
    ["low", "high", "max"].includes(runtimeProfile.reasoningEffort)
  ) {
    return `k3-${runtimeProfile.reasoningEffort}`;
  }
  return null;
}

export function evaluateProductionJourneyGate(
  report,
  {
    now = new Date(),
    selectedProfileId = null,
    expectedVersions = null,
    maxAgeMs = PRODUCTION_JOURNEY_MAX_AGE_MS,
  } = {},
) {
  const finishedAtMs = Date.parse(report?.finishedAt ?? "");
  const nowMs = now.getTime();
  const ageMs = Number.isFinite(finishedAtMs) ? nowMs - finishedAtMs : null;
  const measuredProfileId = productionCanaryProfileId(report);
  const firstProgressP95Ms = report?.metrics?.firstProgressP95Ms;
  const terminalP95Ms = report?.metrics?.terminalP95Ms;
  const versionMismatches = productionVersionMismatches(
    report?.versions,
    expectedVersions,
  );
  const gates = {
    aggregateProductionCanary:
      report?.evaluation ===
        "LeadRadar production search Kimi + Geoapify canary" &&
      report?.aggregateOnly === true,
    productionCanaryDecisionPass: report?.decision === "PASS",
    current:
      typeof ageMs === "number" &&
      ageMs >= -PRODUCTION_JOURNEY_FUTURE_SKEW_MS &&
      ageMs <= maxAgeMs,
    selectedProfileMeasured:
      typeof selectedProfileId === "string" &&
      measuredProfileId === selectedProfileId,
    currentVersionsAndArtifacts: versionMismatches.length === 0,
    completeSample:
      Number.isInteger(report?.sampleCounts?.cases) &&
      report.sampleCounts.cases >= 12,
    firstProgressP95AtMost500Ms:
      typeof firstProgressP95Ms === "number" &&
      firstProgressP95Ms <= 500 &&
      report?.sloObservations?.firstProgressP95TargetMet === true,
    terminalP95AtMost55Seconds:
      typeof terminalP95Ms === "number" &&
      terminalP95Ms <= 55_000 &&
      report?.sloObservations?.terminalP95TargetMet === true,
    everyAttemptAtMost60Seconds:
      report?.hardGates?.deadline === true &&
      report?.sloObservations?.globalDeadlineMet === true,
  };

  return {
    source: "production-search-canary",
    supplied: report !== null && report !== undefined,
    measuredProfileId,
    selectedProfileId,
    finishedAt: Number.isFinite(finishedAtMs)
      ? new Date(finishedAtMs).toISOString()
      : null,
    ageMs,
    metrics: {
      firstProgressP95Ms:
        typeof firstProgressP95Ms === "number" ? firstProgressP95Ms : null,
      terminalP95Ms:
        typeof terminalP95Ms === "number" ? terminalP95Ms : null,
    },
    versionMismatches,
    gates,
    passed: Object.values(gates).every(Boolean),
  };
}

export function buildKimiComparisonDecision(
  selection,
  productionJourneyGate,
  { encoderHardGates = null } = {},
) {
  const encoderComparisonComplete =
    encoderHardGates === null ||
    Object.values(encoderHardGates).every(Boolean);
  const encoderDecision =
    selection.selectedProfileId && encoderComparisonComplete ? "PASS" : "FAIL";
  const journeyPassed = productionJourneyGate?.passed === true;
  return {
    encoderDecision,
    releaseDecision:
      encoderDecision === "FAIL"
        ? "FAIL"
        : journeyPassed
          ? "PASS"
          : "INCOMPLETE",
    evaluationStatus: journeyPassed ? "COMPLETE" : "PARTIAL",
    gateMode: journeyPassed ? "BLOCKING" : "NON_BLOCKING",
    canUnblockIssue14: encoderDecision === "PASS" && journeyPassed,
  };
}
