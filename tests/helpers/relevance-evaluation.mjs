import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  CANDIDATE_EVIDENCE_SCHEMA_VERSION,
  RELEVANCE_CONTRACT_VERSION,
  RELEVANCE_EVIDENCE_FIELDS,
  classifyCandidateRelevance,
  validateCandidateRelevance,
} from "../../lib/search-planner/relevance.ts";
import { GEOAPIFY_CAPABILITY_REGISTRY } from "../../lib/search-planner/catalogs/geoapify.ts";
import { SEMANTIC_INTENT_SCHEMA_VERSION } from "../../lib/search-planner/types.ts";
import { assertAggregateOnly, ratio, roundMetric } from "./evaluation-metrics.mjs";

const fixtureUrl = new URL(
  "../fixtures/search-candidates.cis.json",
  import.meta.url,
);
const ALLOWED_RESULT_KEYS = new Set([
  "candidateId",
  "status",
  "confidence",
  "evidence",
  "reasonCodes",
  "source",
]);
const RELEVANCE_RELEASE_GATES = Object.freeze({
  candidates: 600,
  perStatus: 150,
  providerTargets: 150,
  contentProfiles: 400,
  injectionPerStatus: 15,
});

export async function loadRelevanceFixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

export function expandRelevanceCases(fixture) {
  return fixture.cases;
}

export function stableRelevanceCorpusChecksum(cases) {
  return createHash("sha256")
    .update(JSON.stringify(cases))
    .digest("hex");
}

function semanticIntent(entry) {
  const term = entry.semanticTerm;
  return {
    schemaVersion: SEMANTIC_INTENT_SCHEMA_VERSION,
    normalizedGoal: `find ${term}`,
    entityKind: "physical_business",
    physicalLocationRequirement: "required",
    industries: [],
    coreBusinessTypes: [term],
    adjacentBusinessTypes: [],
    excludedBusinessTypes: [],
    productsAndServices: [],
    includeSignals: [],
    excludeSignals: [],
    retrievalTerms: { precision: [term], recall: [], exclude: [] },
    brandSearch: "include",
    confidence: "high",
    ambiguity: {
      isAmbiguous: false,
      reason: null,
      clarificationQuestion: null,
    },
  };
}

function relevanceContext(entry) {
  const context = entry.retrievalContext;
  if (
    !context ||
    !Array.isArray(context.precisionCategoryIds) ||
    !Array.isArray(context.broadCategoryIds) ||
    !Array.isArray(context.exclusionTerms)
  ) {
    throw new Error(`Invalid frozen retrieval context for ${entry.id}`);
  }
  return {
    semanticIntent: semanticIntent(entry),
    precisionCategoryIds: context.precisionCategoryIds,
    broadCategoryIds: context.broadCategoryIds,
    exclusionTerms: context.exclusionTerms,
  };
}

export function evaluateRelevanceCase(entry) {
  return classifyCandidateRelevance(entry.evidence, relevanceContext(entry));
}

function evidenceFactExists(evidence, fact) {
  if (fact.field === "providerCategoryIds") {
    return evidence.providerCategoryIds.includes(fact.value);
  }
  return evidence[fact.field] === fact.value;
}

function outputIsBounded(result) {
  return (
    Object.keys(result).every((key) => ALLOWED_RESULT_KEYS.has(key)) &&
    result.evidence.length <= 8 &&
    result.reasonCodes.length <= 12
  );
}

function candidateEvidenceIsPrivate(evidence) {
  const serialized = JSON.stringify(evidence);
  return (
    Object.keys(evidence).sort().join(",") ===
      "candidateId,locality,name,providerCategoryIds,sourceDescription" &&
    !/https?:\/\//i.test(serialized) &&
    !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(serialized) &&
    !/\+\d[\d ()-]{8,}/.test(serialized) &&
    (evidence.locality === null ||
      (!/[\d,]/.test(evidence.locality) && evidence.locality.length <= 80))
  );
}

function invalidClassifierOutput(entry) {
  return {
    candidateId: entry.evidence.candidateId,
    status: "matched",
    confidence: 1,
    evidence: [{ field: "sourceDescription", value: "invented provider fact" }],
    reasonCodes: ["MODEL_OVERRIDE"],
    source: "kimi",
  };
}

export async function evaluateRelevanceCorpus(fixtureOverride) {
  const fixture = fixtureOverride ?? (await loadRelevanceFixture());
  const cases = expandRelevanceCases(fixture);
  const checksum = stableRelevanceCorpusChecksum(cases);
  const results = cases.map((entry) => {
    const actual = evaluateRelevanceCase(entry);
    const invalidFallback = validateCandidateRelevance(
      entry.evidence,
      invalidClassifierOutput(entry),
    );
    const invalidEvidenceReferences = actual.evidence.filter(
      (fact) => !evidenceFactExists(entry.evidence, fact),
    ).length;
    const missingRequiredEvidencePointers =
      entry.expected.requiredEvidencePointers.filter(
        (pointer) => !actual.evidence.some((fact) => fact.field === pointer),
      ).length;
    return {
      expectedStatus: entry.expected.status,
      actualStatus: actual.status,
      injection: entry.injection,
      identityValid: actual.candidateId === entry.evidence.candidateId,
      outputBounded: outputIsBounded(actual),
      evidencePrivate: candidateEvidenceIsPrivate(entry.evidence),
      invalidEvidenceReferences,
      missingRequiredEvidencePointers,
      invalidClassifierFailedClosed:
        invalidFallback.status === "not_checked" &&
        invalidFallback.source === "not_checked" &&
        invalidFallback.evidence.length === 0,
    };
  });

  const expectedMatched = results.filter(
    (entry) => entry.expectedStatus === "matched",
  );
  const actualMatched = results.filter((entry) => entry.actualStatus === "matched");
  const trueMatched = actualMatched.filter(
    (entry) => entry.expectedStatus === "matched",
  );
  const expectedPositive = results.filter(
    (entry) => entry.expectedStatus === "matched" || entry.expectedStatus === "maybe",
  );
  const evidenceFacts = results.reduce(
    (count, entry) => count + entry.invalidEvidenceReferences,
    0,
  );
  const metrics = {
    matchedPrecision: ratio(trueMatched.length, actualMatched.length),
    matchedRecall: ratio(trueMatched.length, expectedMatched.length),
    positiveToRejected: ratio(
      expectedPositive.filter((entry) => entry.actualStatus === "rejected").length,
      expectedPositive.length,
    ),
    outcomeAccuracy: ratio(
      results.filter((entry) => entry.actualStatus === entry.expectedStatus).length,
      results.length,
    ),
    evidenceReferenceValidity: ratio(
      results.length - results.filter((entry) => entry.invalidEvidenceReferences).length,
      results.length,
    ),
    requiredEvidenceSupport: ratio(
      results.filter((entry) => !entry.missingRequiredEvidencePointers).length,
      results.length,
    ),
    injectionOutcomeStability: ratio(
      results.filter(
        (entry) =>
          entry.injection && entry.actualStatus === entry.expectedStatus,
      ).length,
      results.filter((entry) => entry.injection).length,
    ),
  };
  const statusCounts = cases.reduce((counts, entry) => {
    counts[entry.expected.status] = (counts[entry.expected.status] ?? 0) + 1;
    return counts;
  }, {});
  const injectionStatusCounts = cases
    .filter((entry) => entry.injection)
    .reduce((counts, entry) => {
      counts[entry.expected.status] =
        (counts[entry.expected.status] ?? 0) + 1;
      return counts;
    }, {});
  const contentProfiles = new Set(
    cases.map((entry) =>
      JSON.stringify({ ...entry.evidence, candidateId: null }),
    ),
  );
  const coverage = {
    uniqueCaseIds: new Set(cases.map((entry) => entry.id)).size,
    uniqueCandidateIds: new Set(
      cases.map((entry) => entry.evidence.candidateId),
    ).size,
    distinctProviderTargets: new Set(
      cases.map((entry) => entry.targetProviderCategoryId),
    ).size,
    distinctContentProfiles: contentProfiles.size,
    injectionByExpectedStatus: injectionStatusCounts,
  };
  const expectedStatuses = ["matched", "maybe", "rejected", "not_checked"];
  const providerCategoryIds = new Set(GEOAPIFY_CAPABILITY_REGISTRY.categories);
  const allowedPointersMatchRuntime =
    JSON.stringify([...fixture.allowedEvidencePointers].sort()) ===
    JSON.stringify([...RELEVANCE_EVIDENCE_FIELDS].sort());
  const invalidProviderCategoryReferences = cases.filter(
    (entry) =>
      !providerCategoryIds.has(entry.targetProviderCategoryId) ||
      ![
        ...entry.retrievalContext.precisionCategoryIds,
        ...entry.retrievalContext.broadCategoryIds,
        ...entry.evidence.providerCategoryIds,
      ].every((categoryId) => providerCategoryIds.has(categoryId)),
  ).length;
  const fixtureContractViolations = [
    fixture.schemaVersion !== CANDIDATE_EVIDENCE_SCHEMA_VERSION,
    !allowedPointersMatchRuntime,
    invalidProviderCategoryReferences > 0,
    fixture.corpusContract.expectedCandidates !==
      RELEVANCE_RELEASE_GATES.candidates,
    fixture.corpusContract.expectedPerStatus !==
      RELEVANCE_RELEASE_GATES.perStatus,
    fixture.corpusContract.distinctProviderTargets !==
      RELEVANCE_RELEASE_GATES.providerTargets,
    fixture.corpusContract.injectionCases !==
      RELEVANCE_RELEASE_GATES.injectionPerStatus * expectedStatuses.length,
  ].filter(Boolean).length;
  const corpusCoverageViolations = [
    cases.length !== RELEVANCE_RELEASE_GATES.candidates,
    coverage.uniqueCaseIds !== cases.length,
    coverage.uniqueCandidateIds !== cases.length,
    coverage.distinctProviderTargets < RELEVANCE_RELEASE_GATES.providerTargets,
    coverage.distinctContentProfiles < RELEVANCE_RELEASE_GATES.contentProfiles,
    ...expectedStatuses.map(
      (status) =>
        statusCounts[status] !== RELEVANCE_RELEASE_GATES.perStatus,
    ),
    ...expectedStatuses.map(
      (status) =>
        injectionStatusCounts[status] !== RELEVANCE_RELEASE_GATES.injectionPerStatus,
    ),
  ].filter(Boolean).length;
  const hardGates = {
    inventedFacts:
      evidenceFacts + results.filter((entry) => !entry.outputBounded).length,
    invalidEvidenceReferences: evidenceFacts,
    missingRequiredEvidencePointers: results.reduce(
      (count, entry) => count + entry.missingRequiredEvidencePointers,
      0,
    ),
    candidateIdentityViolations: results.filter((entry) => !entry.identityValid).length,
    candidateEvidencePrivacyViolations: results.filter(
      (entry) => !entry.evidencePrivate,
    ).length,
    injectionContractViolations: results.filter(
      (entry) => entry.injection && entry.actualStatus !== entry.expectedStatus,
    ).length,
    invalidClassifierFailClosedViolations: results.filter(
      (entry) => !entry.invalidClassifierFailedClosed,
    ).length,
    corpusIntegrityViolations:
      checksum === fixture.corpusContract.corpusChecksum ? 0 : 1,
    corpusCoverageViolations,
    fixtureContractViolations,
  };
  const pass =
    cases.length >= 600 &&
    metrics.matchedPrecision >= 0.95 &&
    metrics.matchedRecall >= 0.85 &&
    metrics.positiveToRejected <= 0.02 &&
    metrics.evidenceReferenceValidity === 1 &&
    metrics.requiredEvidenceSupport === 1 &&
    metrics.injectionOutcomeStability === 1 &&
    Object.values(hardGates).every((count) => count === 0);
  const confusion = results.reduce((counts, entry) => {
    const key = `${entry.expectedStatus}->${entry.actualStatus}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  const report = {
    evaluation: "LeadRadar deterministic relevance offline evaluation",
    fixtureVersion: fixture.version,
    candidateEvidenceSchemaVersion: CANDIDATE_EVIDENCE_SCHEMA_VERSION,
    corpusChecksum: checksum,
    classifierContractVersion: RELEVANCE_CONTRACT_VERSION,
    semanticIntentSchemaVersion: SEMANTIC_INTENT_SCHEMA_VERSION,
    sampleCounts: {
      candidates: cases.length,
      byExpectedStatus: statusCounts,
      injection: cases.filter((entry) => entry.injection).length,
    },
    coverage,
    confusion,
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([key, value]) => [key, roundMetric(value)]),
    ),
    hardGates,
    optionalKimiClassifier: {
      status: "N/A",
      reason: "disabled_by_data_flow_and_rate_gate",
    },
    aggregateOnly: true,
    decision: pass ? "PASS" : "FAIL",
  };
  if (!assertAggregateOnly(report)) {
    throw new Error("Relevance evaluation report is not aggregate-only");
  }
  return report;
}
