import { GEOAPIFY_CATEGORY_IDS } from "../lib/search-planner/catalogs/geoapify.ts";
import { createSearchPlan } from "../lib/search-planner/planner.ts";

import { createGoldenKimiClient } from "./helpers/golden-kimi-client.mjs";
import {
  confusionMetrics,
  roundMetric,
  ratio,
} from "./helpers/evaluation-metrics.mjs";
import {
  expandPlannerCases,
  loadClassifierFixture,
  loadPlannerFixture,
} from "./helpers/query-intelligence-fixtures.mjs";

const PROFILE = process.env.EVAL_PROFILE === "release" ? "release" : "initial";
const FIXED_NOW = new Date("2026-08-16T12:00:00.000Z");
const SIGNING_SECRET = "offline-evaluation-secret-32-bytes-minimum";

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

function semanticOutput(plan) {
  return JSON.stringify({
    status: plan.status,
    resolution: plan.resolution,
    executionPreview: plan.executionPreview,
  });
}

function expectedConceptIsVisible(entry, plan) {
  if (!entry.expectedConceptId) return true;
  return [
    ...plan.resolution.selectedConceptIds,
    ...plan.resolution.alternatives.map((alternative) => alternative.conceptId),
  ].includes(entry.expectedConceptId);
}

async function evaluate() {
  const [plannerFixture, classifierFixture] = await Promise.all([
    loadPlannerFixture(),
    loadClassifierFixture(),
  ]);
  const cases = expandPlannerCases(plannerFixture);
  const mock = createGoldenKimiClient(plannerFixture);
  const providerAllowlist = new Set(GEOAPIFY_CATEGORY_IDS);
  const results = [];

  for (const entry of cases) {
    const options = {
      mode: "kimi",
      kimiClient: mock,
      signingSecret: SIGNING_SECRET,
      now: FIXED_NOW,
    };
    const first = await createSearchPlan(plannerInput(entry), options);
    const second = await createSearchPlan(plannerInput(entry), options);
    const selectedConceptId = first.resolution.selectedConceptIds[0] ?? null;
    const expectedReady = entry.expectedStatus === "ready";
    const providerIds = first.executionPreview?.categoryLabels ?? [];
    const forbiddenLeak = (entry.forbiddenFragments ?? []).some((fragment) =>
      semanticOutput(first).toLocaleLowerCase("ru-RU").includes(
        fragment.toLocaleLowerCase("ru-RU"),
      ),
    );

    results.push({
      id: entry.id,
      kind: entry.kind,
      expectedStatus: entry.expectedStatus,
      actualStatus: first.status,
      expectedConceptId: entry.expectedConceptId ?? null,
      selectedConceptId,
      statusCorrect: first.status === entry.expectedStatus,
      conceptCorrect:
        !expectedReady || selectedConceptId === entry.expectedConceptId,
      expectedConceptVisible: expectedConceptIsVisible(entry, first),
      deterministic: first.planHash === second.planHash,
      executableInvariant:
        first.status === "ready"
          ? first.resolution.selectedConceptIds.length === 1 &&
            first.executionPreview !== null
          : first.resolution.selectedConceptIds.length === 0 &&
            first.executionPreview === null,
      providerAllowlistSafe: providerIds.every((id) => providerAllowlist.has(id)),
      forbiddenLeak,
    });
  }

  const expectedReady = results.filter((entry) => entry.expectedStatus === "ready");
  const actualReady = results.filter((entry) => entry.actualStatus === "ready");
  const correctReady = actualReady.filter(
    (entry) =>
      entry.expectedStatus === "ready" &&
      entry.selectedConceptId === entry.expectedConceptId,
  );
  const expectedSemanticOutcomes = results.filter(
    (entry) =>
      entry.expectedStatus === "needs_confirmation" ||
      entry.expectedStatus === "unsupported",
  );
  const correctSemanticOutcomes = expectedSemanticOutcomes.filter(
    (entry) => entry.statusCorrect,
  );
  const fullCatalogCalls = mock.calls.filter(
    (entry) => entry.candidateMode === "full_catalog",
  );
  const zeroOverlapIds = new Set(
    plannerFixture.zeroOverlapCases.map((entry) => entry.id),
  );
  const zeroOverlapFullCatalog = new Set(
    fullCatalogCalls
      .filter((entry) => zeroOverlapIds.has(entry.caseId))
      .map((entry) => entry.caseId),
  );
  const canonicalConceptLabels = [
    ...new Set(expectedReady.map((entry) => entry.expectedConceptId)),
  ].sort();
  const canonicalClassification = confusionMetrics(
    expectedReady.map((entry) => entry.expectedConceptId),
    expectedReady.map(
      (entry) => entry.selectedConceptId ?? "__not_ready__",
    ),
    canonicalConceptLabels,
  );

  const metrics = {
    top1Accuracy: ratio(
      expectedReady.filter((entry) => entry.conceptCorrect).length,
      expectedReady.length,
    ),
    canonicalMacroF1: canonicalClassification.macroF1,
    autoResolvedPrecision: ratio(correctReady.length, actualReady.length),
    readyCoverage: ratio(actualReady.length, expectedReady.length),
    correctConceptTop3: ratio(
      expectedReady.filter((entry) => entry.expectedConceptVisible).length,
      expectedReady.length,
    ),
    semanticOutcomeRecall: ratio(
      correctSemanticOutcomes.length,
      expectedSemanticOutcomes.length,
    ),
    planHashStability: ratio(
      results.filter((entry) => entry.deterministic).length,
      results.length,
    ),
  };

  const hardGates = {
    invalidExecutableState: results.filter(
      (entry) => !entry.executableInvariant,
    ).length,
    providerAllowlistViolations: results.filter(
      (entry) => !entry.providerAllowlistSafe,
    ).length,
    promptInjectionLeaks: results.filter((entry) => entry.forbiddenLeak).length,
    unsafeAmbiguousAutoRun: results.filter(
      (entry) =>
        entry.expectedStatus === "needs_confirmation" &&
        entry.actualStatus === "ready",
    ).length,
    missingZeroOverlapFullCatalogPaths:
      plannerFixture.zeroOverlapCases.length - zeroOverlapFullCatalog.size,
  };
  const qualityErrors = {
    statusMismatches: results.filter((entry) => !entry.statusCorrect).length,
    conceptMismatches: expectedReady.filter((entry) => !entry.conceptCorrect)
      .length,
  };

  const initialCoverage =
    cases.length >= 210 &&
    plannerFixture.conceptFamilies.length >= 30 &&
    plannerFixture.zeroOverlapCases.length >= 30 &&
    classifierFixture.cases.length >= 60;
  const releaseCoverage = cases.length >= 500 && classifierFixture.cases.length >= 600;
  const metricGates = {
    top1Accuracy: metrics.top1Accuracy >= 0.92,
    canonicalMacroF1: metrics.canonicalMacroF1 >= 0.9,
    autoResolvedPrecision: metrics.autoResolvedPrecision >= 0.95,
    readyCoverage: metrics.readyCoverage >= 0.8,
    correctConceptTop3: metrics.correctConceptTop3 >= 0.98,
    semanticOutcomeRecall: metrics.semanticOutcomeRecall >= 0.95,
    planHashStability: metrics.planHashStability === 1,
  };
  const hardGatePass = Object.values(hardGates).every((count) => count === 0);
  const selectedCoveragePass = PROFILE === "release" ? releaseCoverage : initialCoverage;
  const pass =
    hardGatePass &&
    Object.values(metricGates).every(Boolean) &&
    selectedCoveragePass;

  const sanitizedFailures = results
    .filter(
      (entry) =>
        !entry.statusCorrect ||
        !entry.conceptCorrect ||
        !entry.executableInvariant ||
        !entry.providerAllowlistSafe ||
        entry.forbiddenLeak,
    )
    .slice(0, 25)
    .map((entry) => ({
      id: entry.id,
      expectedStatus: entry.expectedStatus,
      actualStatus: entry.actualStatus,
      expectedConceptId: entry.expectedConceptId,
      selectedConceptId: entry.selectedConceptId,
    }));

  return {
    evaluation: "LeadRadar Query Intelligence offline",
    profile: PROFILE,
    fixtureVersions: {
      planner: plannerFixture.version,
      classifier: classifierFixture.version,
    },
    sampleCounts: {
      plannerCases: cases.length,
      conceptFamilies: plannerFixture.conceptFamilies.length,
      zeroOverlap: plannerFixture.zeroOverlapCases.length,
      ambiguous: plannerFixture.ambiguousCases.length,
      unsupported: plannerFixture.unsupportedCases.length,
      injection: plannerFixture.injectionCases.length,
      localized: plannerFixture.localizedCases.length,
      syntheticClassifierCases: classifierFixture.cases.length,
    },
    coverage: {
      initialGate: initialCoverage,
      releaseGate: releaseCoverage,
      releaseTarget: { plannerCases: 500, classifierCases: 600 },
    },
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([key, value]) => [key, roundMetric(value)]),
    ),
    metricGates,
    hardGates,
    qualityErrors,
    classifier: {
      status: "N/A",
      reason: "runtime deterministic classifier is not part of the current core surface",
      fixtureInvariantCoverage: "PASS",
    },
    sanitizedFailures,
    decision: pass ? "PASS" : "FAIL",
  };
}

const report = await evaluate();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.decision !== "PASS") process.exitCode = 1;
