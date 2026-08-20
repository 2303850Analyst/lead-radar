import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import {
  KIMI_INVALID_RESPONSE_REASONS,
  KIMI_MODEL_POLICY_VERSION,
  KIMI_SEMANTIC_VALIDATION_ISSUE_CODES,
  KIMI_TRANSPORT_SCHEMA_VERSION,
  createKimiClient,
} from "../lib/search-planner/kimi-client.ts";
import {
  DECISION_POLICY_VERSION,
  KIMI_PROMPT_CONTENT_VERSION,
  createSearchPlan,
} from "../lib/search-planner/planner.ts";
import {
  GEOAPIFY_CAPABILITY_REGISTRY,
  GEOAPIFY_COMPILER_POLICY_VERSION,
} from "../lib/search-planner/catalogs/geoapify.ts";
import {
  SEARCH_PLAN_SCHEMA_VERSION,
  SEMANTIC_INTENT_SCHEMA_VERSION,
} from "../lib/search-planner/types.ts";
import {
  SEARCH_CANARY_EVALUATION_POLICY_VERSION,
  SEARCH_CANARY_RUBRIC,
  SEARCH_CANARY_RUBRIC_VERSION,
  SEARCH_CANARY_THRESHOLDS,
  searchCanaryCaseSetChecksum,
} from "../scripts/lib/search-live-canary.mjs";
import {
  currentSearchCanaryArtifactFingerprints,
} from "../scripts/lib/search-canary-artifacts.mjs";
import {
  resolveSearchCanaryKimiProfile,
  searchCanaryRuntimeProfile,
} from "../scripts/lib/search-canary-profile.mjs";
import { assertAggregateOnly } from "./helpers/evaluation-metrics.mjs";
import {
  buildKimiComparisonDecision,
  evaluateKimiOutcomeContract,
  evaluateProductionJourneyGate,
  KIMI_COMPARISON_CASE_IDS,
  KIMI_MINIMUM_EXPECTED_OUTCOME_RATE,
  nextKimiComparisonStartAt,
  selectKimiProfile,
  summarizeKimiProfile,
} from "./helpers/kimi-model-comparison.mjs";
import {
  expandOpenWorldCases,
  stableCorpusChecksum,
} from "./helpers/open-world-evaluation.mjs";

const enabled = process.env.RUN_KIMI_MODEL_LATENCY_COMPARISON === "1";
if (!enabled) {
  process.stdout.write(
    "Kimi model latency comparison skipped. Set RUN_KIMI_MODEL_LATENCY_COMPARISON=1 explicitly to run it.\n",
  );
  process.exit(0);
}

const apiKey =
  process.env.MOONSHOT_API_KEY?.trim() || process.env.KIMI_API_KEY?.trim();
if (!apiKey) {
  process.stderr.write(
    "Kimi model latency comparison requires MOONSHOT_API_KEY or KIMI_API_KEY.\n",
  );
  process.exit(2);
}

function boundedInteger(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]?.trim() || fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function errorCode(error) {
  return typeof error === "object" && error && "code" in error
    ? String(error.code)
    : "UNCLASSIFIED_LIVE_ERROR";
}

const invalidResponseReasonSet = new Set(KIMI_INVALID_RESPONSE_REASONS);
const semanticValidationIssueCodeSet = new Set(
  KIMI_SEMANTIC_VALIDATION_ISSUE_CODES,
);
function invalidResponseReason(error) {
  if (
    typeof error !== "object" ||
    error === null ||
    !("reason" in error) ||
    typeof error.reason !== "string" ||
    !invalidResponseReasonSet.has(error.reason)
  ) {
    return null;
  }
  return error.reason;
}

function semanticValidationIssueCodes(error) {
  if (
    typeof error !== "object" ||
    error === null ||
    !("semanticValidationIssueCodes" in error) ||
    !Array.isArray(error.semanticValidationIssueCodes)
  ) {
    return [];
  }
  return [
    ...new Set(
      error.semanticValidationIssueCodes.filter(
        (value) =>
          typeof value === "string" &&
          semanticValidationIssueCodeSet.has(value),
      ),
    ),
  ];
}

function retryable(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "retryable" in error &&
    error.retryable === true
  );
}

const repeats = boundedInteger("KIMI_COMPARISON_REPEATS", 3, 1, 10);
const minStartIntervalMs = boundedInteger(
  "KIMI_COMPARISON_MIN_START_INTERVAL_MS",
  35_000,
  0,
  120_000,
);
const modelMinStartIntervalMs = boundedInteger(
  "KIMI_COMPARISON_MODEL_MIN_START_INTERVAL_MS",
  70_000,
  0,
  180_000,
);
const timeoutMs = boundedInteger(
  "KIMI_REQUEST_TIMEOUT_MS",
  30_000,
  1,
  60_000,
);
const caseLimit = boundedInteger(
  "KIMI_COMPARISON_CASE_LIMIT",
  KIMI_COMPARISON_CASE_IDS.length,
  1,
  KIMI_COMPARISON_CASE_IDS.length,
);
const KIMI_PRICING_POLICY_VERSION = "kimi-pricing-usd/2026-08-20.1";

const MODEL_PROFILES = Object.freeze(
  ["k3-low", "k2.6-thinking-disabled"].map((profileId) => {
    const profile = resolveSearchCanaryKimiProfile(profileId);
    return Object.freeze({
      id: profile.id,
      model: profile.model,
      reasoningEffort: profile.reasoningEffort,
      pricingUsdPerMillion: profile.pricingUsdPerMillion,
    });
  }),
);

const fixture = JSON.parse(
  await readFile(
    new URL("./fixtures/open-world-intents.cis.json", import.meta.url),
    "utf8",
  ),
);
if (fixture.version !== "open-world-cis-v0.4.0-1") {
  throw new Error("Frozen Kimi comparison corpus version changed unexpectedly");
}
const fixtureEntries = expandOpenWorldCases(fixture);
const expandedCorpusChecksum = stableCorpusChecksum(fixtureEntries);
if (expandedCorpusChecksum !== fixture.expansionContract.expandedChecksum) {
  throw new Error("Frozen Kimi comparison corpus checksum changed unexpectedly");
}
const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const entryById = new Map(fixtureEntries.map((entry) => [entry.id, entry]));
const cases = KIMI_COMPARISON_CASE_IDS.slice(0, caseLimit).map((id) => {
  const entry = entryById.get(id);
  if (!entry) throw new Error(`Frozen Kimi comparison case ${id} is missing`);
  return entry;
});

let lastStartAt = 0;
const lastStartAtByProfile = new Map();
async function waitForTierZeroSlot(profileId) {
  const now = Date.now();
  const startAt = nextKimiComparisonStartAt({
    now,
    lastGlobalStartAt: lastStartAt,
    lastModelStartAt: lastStartAtByProfile.get(profileId) ?? 0,
    minimumGlobalIntervalMs: minStartIntervalMs,
    minimumModelIntervalMs: modelMinStartIntervalMs,
  });
  const remaining = startAt - now;
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  lastStartAt = Date.now();
  lastStartAtByProfile.set(profileId, lastStartAt);
}

const states = MODEL_PROFILES.map((profile) => ({
  profile,
  client: createKimiClient({
    apiKey,
    baseUrl: process.env.KIMI_BASE_URL,
    model: profile.model,
    ...(profile.reasoningEffort
      ? { reasoningEffort: profile.reasoningEffort }
      : {}),
    timeoutMs,
  }),
  modelCanary: null,
  attempts: [],
}));

const startedAt = new Date();
for (const state of states) {
  await waitForTierZeroSlot(state.profile.id);
  try {
    const canary = await state.client.listModels();
    state.modelCanary = {
      configuredModelAvailable: canary.configuredModelAvailable,
      modelCount: canary.modelIds.length,
      latencyMs: canary.latencyMs,
      errorCode: null,
    };
  } catch (error) {
    state.modelCanary = {
      configuredModelAvailable: false,
      modelCount: null,
      latencyMs: null,
      errorCode: errorCode(error),
    };
  }
}

async function runAttempt(state, entry) {
  let encodeResult = null;
  let encodeFailure = null;
  const observingClient = {
    modelId: state.client.modelId,
    cacheIdentity: state.client.cacheIdentity,
    async encode(request) {
      try {
        encodeResult = await state.client.encode(request);
        return encodeResult;
      } catch (error) {
        encodeFailure = error;
        throw error;
      }
    },
  };

  await waitForTierZeroSlot(state.profile.id);
  const wallStartedAt = Date.now();
  try {
    const plan = await createSearchPlan(
      {
        primaryQuery: entry.query,
        locale: entry.locale,
        countryCodes: [entry.countryCode],
      },
      { mode: "kimi", kimiClient: observingClient },
    );
    const encoderOk =
      encodeResult !== null && plan.ai.validation === "passed";
    const {
      exactExpectedOutcome,
      executionContractPassed,
      nonReadyExecutionLeak,
    } = evaluateKimiOutcomeContract(plan, entry);
    const degradedCode = plan.resolution.reasonCodes.find((code) =>
      code.startsWith("KIMI_"),
    );
    state.attempts.push({
      caseId: entry.id,
      actualOutcome: plan.status,
      compiledProviderCategoryIds:
        plan.executionPreview?.categoryLabels ?? [],
      ok: encoderOk,
      schemaPassed: encoderOk,
      executionContractPassed: encoderOk && executionContractPassed,
      nonReadyExecutionLeak,
      expectedOutcome: encoderOk && exactExpectedOutcome,
      firstSseEventLatencyMs: encodeResult?.firstSseEventLatencyMs ?? null,
      apiLatencyMs: encodeResult?.latencyMs ?? null,
      wallLatencyMs: Date.now() - wallStartedAt,
      inputTokens: encodeResult?.usage.inputTokens ?? null,
      cachedInputTokens: encodeResult?.usage.cachedInputTokens ?? null,
      outputTokens: encodeResult?.usage.outputTokens ?? null,
      errorCode: encoderOk
        ? null
        : encodeFailure
          ? errorCode(encodeFailure)
          : degradedCode ?? "KIMI_DEGRADED_OUTCOME",
      invalidResponseReason: encodeFailure
        ? invalidResponseReason(encodeFailure)
        : null,
      semanticValidationIssueCodes: encodeFailure
        ? semanticValidationIssueCodes(encodeFailure)
        : [],
      retryable: encodeFailure ? retryable(encodeFailure) : false,
    });
  } catch (error) {
    state.attempts.push({
      caseId: entry.id,
      actualOutcome: null,
      compiledProviderCategoryIds: [],
      ok: false,
      schemaPassed: false,
      executionContractPassed: false,
      nonReadyExecutionLeak: false,
      expectedOutcome: false,
      firstSseEventLatencyMs: encodeResult?.firstSseEventLatencyMs ?? null,
      apiLatencyMs: encodeResult?.latencyMs ?? null,
      wallLatencyMs: Date.now() - wallStartedAt,
      inputTokens: encodeResult?.usage.inputTokens ?? null,
      cachedInputTokens: encodeResult?.usage.cachedInputTokens ?? null,
      outputTokens: encodeResult?.usage.outputTokens ?? null,
      errorCode: errorCode(error),
      invalidResponseReason: invalidResponseReason(error),
      semanticValidationIssueCodes: semanticValidationIssueCodes(error),
      retryable: retryable(error),
    });
  }
}

// Alternate the profile order for each blocked case/repeat pair so provider
// load drift does not systematically favor the profile that always runs first.
for (let repeat = 0; repeat < repeats; repeat += 1) {
  for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
    const entry = cases[caseIndex];
    const orderedStates =
      (repeat + caseIndex) % 2 === 0 ? states : [...states].reverse();
    for (const state of orderedStates) {
      if (state.modelCanary?.configuredModelAvailable) {
        await runAttempt(state, entry);
      }
    }
  }
}

const expectedAttemptCount = cases.length * repeats;
const summaries = states.map((state) =>
  summarizeKimiProfile({
    profile: state.profile,
    modelId: state.client.modelId,
    cacheIdentity: state.client.cacheIdentity,
    modelCanary: state.modelCanary,
    attempts: state.attempts,
    expectedAttemptCount,
  }),
);
const selection = selectKimiProfile(summaries, {
  minimumExpectedOutcomeRate: KIMI_MINIMUM_EXPECTED_OUTCOME_RATE,
});
const totalAttempts = selection.profiles.reduce(
  (sum, profile) => sum + profile.attemptCount,
  0,
);
const encoderHardGates = {
  fullFrozenCorpus: cases.length === KIMI_COMPARISON_CASE_IDS.length,
  minimumFiftyCalls: totalAttempts >= 50,
  allProfilesMeasured: selection.profiles.every(
    (profile) => profile.baseGates.completeSample,
  ),
  baselineQualityMeasured: selection.baselineMeasured,
  atLeastOneEligibleProfile: selection.selectedProfileId !== null,
  everyAttemptAtMost60Seconds: selection.profiles.every(
    (profile) => profile.baseGates.everyAttemptAtMost60Seconds,
  ),
  noUnclassifiedErrors: selection.profiles.every(
    (profile) =>
      profile.modelCanary.errorCode !== "UNCLASSIFIED_LIVE_ERROR" &&
      profile.baseGates.noUnclassifiedErrors,
  ),
};
const productionCanaryReportPath =
  process.env.KIMI_COMPARISON_PRODUCTION_CANARY_REPORT?.trim();
let productionCanaryReport = null;
let expectedProductionVersions = null;
if (productionCanaryReportPath) {
  try {
    productionCanaryReport = JSON.parse(
      await readFile(productionCanaryReportPath, "utf8"),
    );
  } catch (error) {
    throw new Error(
      "KIMI_COMPARISON_PRODUCTION_CANARY_REPORT must reference a readable JSON report",
      { cause: error },
    );
  }
  if (selection.selectedProfileId) {
    const selectedCanaryProfile = resolveSearchCanaryKimiProfile(
      selection.selectedProfileId,
    );
    const artifactFingerprints =
      await currentSearchCanaryArtifactFingerprints();
    expectedProductionVersions = {
      app: packageMetadata.version,
      model: selectedCanaryProfile.model,
      modelPolicy: KIMI_MODEL_POLICY_VERSION,
      transportSchema: KIMI_TRANSPORT_SCHEMA_VERSION,
      prompt:
        `${KIMI_PROMPT_CONTENT_VERSION}+${selectedCanaryProfile.cacheIdentity}`,
      semanticIntentSchema: SEMANTIC_INTENT_SCHEMA_VERSION,
      searchPlanSchema: SEARCH_PLAN_SCHEMA_VERSION,
      decisionPolicy: DECISION_POLICY_VERSION,
      compilerPolicy: GEOAPIFY_COMPILER_POLICY_VERSION,
      providerCatalog: GEOAPIFY_CAPABILITY_REGISTRY.version,
      providerCatalogChecksum: GEOAPIFY_CAPABILITY_REGISTRY.checksum,
      ...artifactFingerprints,
      evaluationPolicy: SEARCH_CANARY_EVALUATION_POLICY_VERSION,
      caseSetChecksum: searchCanaryCaseSetChecksum(),
      rubric: SEARCH_CANARY_RUBRIC_VERSION,
      rubricChecksum: createHash("sha256")
        .update(JSON.stringify(SEARCH_CANARY_RUBRIC))
        .digest("hex"),
      thresholds: SEARCH_CANARY_THRESHOLDS,
      runtimeProfile: searchCanaryRuntimeProfile(selectedCanaryProfile),
      pricingUsdPerMillion: {
        input: selectedCanaryProfile.pricingUsdPerMillion.input,
        output: selectedCanaryProfile.pricingUsdPerMillion.output,
      },
    };
  }
}
const productionJourneyGate = evaluateProductionJourneyGate(
  productionCanaryReport,
  {
    now: new Date(),
    selectedProfileId: selection.selectedProfileId,
    expectedVersions: expectedProductionVersions,
  },
);
const comparisonDecision = buildKimiComparisonDecision(
  selection,
  productionJourneyGate,
  { encoderHardGates },
);
const report = {
  evaluation: "LeadRadar Kimi model latency comparison",
  aggregateOnly: true,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  versions: {
    app: packageMetadata.version,
    modelPolicy: KIMI_MODEL_POLICY_VERSION,
    promptContent: KIMI_PROMPT_CONTENT_VERSION,
    transportSchema: KIMI_TRANSPORT_SCHEMA_VERSION,
    semanticIntentSchema: SEMANTIC_INTENT_SCHEMA_VERSION,
    searchPlanSchema: SEARCH_PLAN_SCHEMA_VERSION,
    decisionPolicy: DECISION_POLICY_VERSION,
    compilerPolicy: GEOAPIFY_COMPILER_POLICY_VERSION,
    providerCatalog: GEOAPIFY_CAPABILITY_REGISTRY.version,
    providerCatalogChecksum: GEOAPIFY_CAPABILITY_REGISTRY.checksum,
  },
  pricingPolicy: {
    version: KIMI_PRICING_POLICY_VERSION,
    currency: "USD",
    unit: "per_million_tokens",
  },
  corpus: {
    version: fixture.version,
    expandedChecksum: expandedCorpusChecksum,
    selectionVersion: "kimi-latency-open-world-cis/2026-08-20.4",
    caseCount: cases.length,
    repeats,
    composition: {
      ready: cases.filter((entry) => entry.expectedOutcome === "ready").length,
      needsConfirmation: cases.filter(
        (entry) => entry.expectedOutcome === "needs_confirmation",
      ).length,
      unsupported: cases.filter(
        (entry) => entry.expectedOutcome === "unsupported",
      ).length,
      ambiguous: cases.filter((entry) => entry.kind === "ambiguous").length,
      nonPlace: cases.filter((entry) => entry.kind === "non_place").length,
      injection: cases.filter((entry) => entry.kind === "injection").length,
      novelPhysical: cases.filter(
        (entry) => entry.expectedOutcome === "ready" && entry.novel,
      ).length,
    },
  },
  tierProfile: {
    concurrency: 1,
    ordering: "alternating-blocked-case-repeat",
    minStartIntervalMs,
    modelMinStartIntervalMs,
    timeoutMs,
    caseLimit,
    transportRetries: 0,
  },
  productionJourneyGate,
  selectionPolicy: {
    baselineProfileId: selection.baselineProfileId,
    minimumExpectedOutcomeRate: KIMI_MINIMUM_EXPECTED_OUTCOME_RATE,
    measuredExpectedOutcomeFloor: selection.expectedOutcomeFloor,
    order: [
      "expectedOutcomeRate",
      "p95ApiLatencyMs",
      "estimatedConservativeCostUsd",
    ],
  },
  selectedProfileId: selection.selectedProfileId,
  totalAttempts,
  profiles: selection.profiles,
  encoderHardGates,
  ...comparisonDecision,
  decision: comparisonDecision.releaseDecision,
};

if (!assertAggregateOnly(report)) {
  throw new Error("Kimi model comparison report failed aggregate-only validation");
}
const serializedReport = JSON.stringify(report);
if (cases.some((entry) => serializedReport.includes(entry.query))) {
  throw new Error("Kimi model comparison report leaked frozen input text");
}

const outputDirectory = new URL("../work/evaluations/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
const timestamp = startedAt.toISOString().replace(/[:.]/g, "-");
const outputUrl = new URL(
  `kimi-model-latency-summary-${timestamp}.json`,
  outputDirectory,
);
await writeFile(outputUrl, `${JSON.stringify(report, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});

process.stdout.write(
  `${JSON.stringify({
    decision: report.decision,
    encoderDecision: report.encoderDecision,
    releaseDecision: report.releaseDecision,
    evaluationStatus: report.evaluationStatus,
    gateMode: report.gateMode,
    canUnblockIssue14: report.canUnblockIssue14,
    selectedProfileId: report.selectedProfileId,
    totalAttempts: report.totalAttempts,
    profiles: report.profiles.map((profile) => ({
      profileId: profile.profileId,
      eligible: profile.eligible,
      attemptCount: profile.attemptCount,
      metrics: profile.metrics,
    })),
    reportFile: outputUrl.pathname,
  }, null, 2)}\n`,
);
if (report.encoderDecision === "FAIL") process.exitCode = 1;
