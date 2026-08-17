import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateRelevanceCase,
  evaluateRelevanceCorpus,
  expandRelevanceCases,
  loadRelevanceFixture,
  stableRelevanceCorpusChecksum,
} from "./helpers/relevance-evaluation.mjs";

test("relevance corpus freezes 600 balanced synthetic candidate-evidence cases", async () => {
  const fixture = await loadRelevanceFixture();
  const cases = expandRelevanceCases(fixture);
  const counts = Object.groupBy(cases, (entry) => entry.expected.status);

  assert.equal(cases.length, 600);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(counts).map(([status, entries]) => [status, entries.length]),
    ),
    { matched: 150, maybe: 150, rejected: 150, not_checked: 150 },
  );
  assert.equal(new Set(cases.map((entry) => entry.id)).size, 600);
  assert.equal(cases.filter((entry) => entry.injection).length, 60);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(
        Object.groupBy(
          cases.filter((entry) => entry.injection),
          (entry) => entry.expected.status,
        ),
      ).map(([status, entries]) => [status, entries.length]),
    ),
    { matched: 15, maybe: 15, rejected: 15, not_checked: 15 },
  );
  assert.equal(
    stableRelevanceCorpusChecksum(cases),
    fixture.corpusContract.corpusChecksum,
  );
  assert.ok(
    cases.every(
      (entry) =>
        JSON.stringify(Object.keys(entry.evidence).sort()) ===
          JSON.stringify([
            "candidateId",
            "locality",
            "name",
            "providerCategoryIds",
            "sourceDescription",
          ]) &&
        /^candidate-rel-\d{3}-(matched|maybe|rejected|not_checked)$/.test(
          entry.evidence.candidateId,
        ),
    ),
  );
  const contentFingerprints = new Set(
    cases.map((entry) =>
      JSON.stringify({ ...entry.evidence, candidateId: null }),
    ),
  );
  assert.equal(contentFingerprints.size, 600);
  assert.equal(
    new Set(cases.map((entry) => entry.targetProviderCategoryId)).size,
    150,
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(
        Object.groupBy(cases, (entry) => entry.retrievalContext.kind),
      ).map(([role, entries]) => [role, entries.length]),
    ),
    {
      precision_category: 75,
      broad_plus_text: 75,
      broad_category: 75,
      text_only: 75,
      precision_conflict: 75,
      broad_conflict: 75,
      precision_empty: 75,
      none_empty: 75,
    },
  );
});

test("relevance runtime context is frozen independently from the golden label", async () => {
  const fixture = await loadRelevanceFixture();
  const broadCase = expandRelevanceCases(fixture).find(
    (entry) => entry.retrievalContext.kind === "broad_category",
  );
  assert.ok(broadCase);
  const original = evaluateRelevanceCase(broadCase);
  const relabelled = evaluateRelevanceCase({
    ...broadCase,
    expected: { ...broadCase.expected, status: "rejected" },
  });
  assert.equal(original.status, "maybe");
  assert.deepEqual(relabelled, original);
});

test("documented evaluator rejects a rechecksummed duplicated and imbalanced corpus", async () => {
  const fixture = await loadRelevanceFixture();
  const source = fixture.cases[0];
  const cases = Array.from({ length: 600 }, (_, index) => ({
    ...structuredClone(source),
    id: `duplicated-${index}`,
    evidence: {
      ...structuredClone(source.evidence),
      candidateId: `duplicated-candidate-${index}`,
    },
  }));
  const poisoned = {
    ...structuredClone(fixture),
    cases,
    corpusContract: {
      ...fixture.corpusContract,
      corpusChecksum: stableRelevanceCorpusChecksum(cases),
    },
  };
  const report = await evaluateRelevanceCorpus(poisoned);
  assert.equal(report.hardGates.corpusIntegrityViolations, 0);
  assert.ok(report.hardGates.corpusCoverageViolations > 0);
  assert.equal(report.decision, "FAIL");
});

test("release diversity gate cannot be weakened inside the fixture", async () => {
  const fixture = structuredClone(await loadRelevanceFixture());
  const singleTarget = fixture.cases[0].targetProviderCategoryId;
  fixture.cases.forEach((entry) => {
    entry.targetProviderCategoryId = singleTarget;
  });
  fixture.corpusContract.distinctProviderTargets = 1;
  fixture.corpusContract.corpusChecksum = stableRelevanceCorpusChecksum(
    fixture.cases,
  );

  const report = await evaluateRelevanceCorpus(fixture);
  assert.equal(report.hardGates.corpusIntegrityViolations, 0);
  assert.equal(report.coverage.distinctProviderTargets, 1);
  assert.ok(report.hardGates.corpusCoverageViolations > 0);
  assert.ok(report.hardGates.fixtureContractViolations > 0);
  assert.equal(report.decision, "FAIL");
});

test("relevance evaluation enforces quality, evidence and fail-closed safety gates", async () => {
  const previousFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("Relevance offline evaluation must not use the network");
  };
  const report = await evaluateRelevanceCorpus().finally(() => {
    globalThis.fetch = previousFetch;
  });

  assert.equal(report.sampleCounts.candidates, 600);
  assert.equal(report.candidateEvidenceSchemaVersion, "candidate-evidence-v2");
  assert.equal(report.semanticIntentSchemaVersion, "2.0");
  assert.deepEqual(report.coverage.injectionByExpectedStatus, {
    matched: 15,
    maybe: 15,
    rejected: 15,
    not_checked: 15,
  });
  assert.equal(report.coverage.uniqueCaseIds, 600);
  assert.equal(report.coverage.uniqueCandidateIds, 600);
  assert.equal(report.coverage.distinctProviderTargets, 150);
  assert.ok(report.coverage.distinctContentProfiles >= 400);
  assert.ok(report.metrics.matchedPrecision >= 0.95);
  assert.ok(report.metrics.matchedRecall >= 0.85);
  assert.ok(report.metrics.positiveToRejected <= 0.02);
  assert.equal(report.metrics.evidenceReferenceValidity, 1);
  assert.equal(report.metrics.requiredEvidenceSupport, 1);
  assert.equal(report.metrics.injectionOutcomeStability, 1);
  assert.deepEqual(report.hardGates, {
    inventedFacts: 0,
    invalidEvidenceReferences: 0,
    missingRequiredEvidencePointers: 0,
    candidateIdentityViolations: 0,
    candidateEvidencePrivacyViolations: 0,
    injectionContractViolations: 0,
    invalidClassifierFailClosedViolations: 0,
    corpusIntegrityViolations: 0,
    corpusCoverageViolations: 0,
    fixtureContractViolations: 0,
  });
  assert.deepEqual(report.optionalKimiClassifier, {
    status: "N/A",
    reason: "disabled_by_data_flow_and_rate_gate",
  });
  assert.equal(networkCalls, 0);
  assert.equal(report.aggregateOnly, true);
  assert.equal(report.decision, "PASS");
});
