import assert from "node:assert/strict";
import test from "node:test";

import {
  attachOpenWorldAnnotations,
  cohenKappa,
  evaluateOpenWorldCorpus,
  expandOpenWorldCases,
  loadOpenWorldAnnotationSets,
  loadOpenWorldFixture,
  stableCorpusChecksum,
} from "./helpers/open-world-evaluation.mjs";

test("open-world corpus freezes 500 CIS cases across at least 100 physical types", async () => {
  const fixture = await loadOpenWorldFixture();
  const cases = expandOpenWorldCases(fixture);
  const physicalCases = cases.filter((entry) => entry.physicalTypeId);
  const physicalTypes = new Set(physicalCases.map((entry) => entry.physicalTypeId));
  const novelTypes = new Set(
    physicalCases.filter((entry) => entry.novel).map((entry) => entry.physicalTypeId),
  );
  const localeCounts = cases.reduce((counts, entry) => {
    counts[entry.countryCode] = (counts[entry.countryCode] ?? 0) + 1;
    return counts;
  }, {});

  assert.equal(fixture.legacyBaseline.version, "canonical-taxonomy-2026-08-16.1");
  assert.equal(fixture.legacyBaseline.categoryIds.length, 43);
  assert.equal(new Set(fixture.legacyBaseline.categoryIds).size, 43);
  assert.equal(cases.length, 500);
  assert.equal(physicalTypes.size, 100);
  assert.ok(novelTypes.size / physicalTypes.size >= 0.4);
  assert.ok(physicalCases.filter((entry) => entry.novel).length >= 80);
  assert.ok(localeCounts.RU >= 350);
  assert.ok(localeCounts.BY >= 50);
  assert.ok(localeCounts.KZ >= 50);
  assert.ok(cases.filter((entry) => entry.kind === "mixed_language").length >= 20);
  assert.ok(cases.filter((entry) => entry.kind === "ambiguous").length >= 20);
  assert.ok(cases.filter((entry) => entry.kind === "non_place").length >= 15);
  assert.ok(cases.filter((entry) => entry.kind === "injection").length >= 15);
});

test("open-world split is atomic by business family at 60/20/20", async () => {
  const cases = expandOpenWorldCases(await loadOpenWorldFixture());
  const splitByFamily = new Map();
  for (const entry of cases) {
    const previous = splitByFamily.get(entry.familyId);
    assert.ok(!previous || previous === entry.split, entry.familyId);
    splitByFamily.set(entry.familyId, entry.split);
  }
  const counts = { development: 0, regression: 0, holdout: 0 };
  for (const split of splitByFamily.values()) counts[split] += 1;
  assert.equal(splitByFamily.size, 150);
  assert.deepEqual(counts, { development: 90, regression: 30, holdout: 30 });
  const holdoutPhysical = cases.filter(
    (entry) => entry.split === "holdout" && entry.physicalTypeId,
  );
  assert.ok(holdoutPhysical.length > 0);
  assert.ok(
    holdoutPhysical.every((entry) => entry.novel),
    "hidden physical families must stay outside legacy production bindings",
  );
  const byFamily = Map.groupBy(holdoutPhysical, (entry) => entry.familyId);
  assert.equal(byFamily.size, 20);
  for (const [familyId, familyCases] of byFamily) {
    assert.equal(familyCases.length, 4, familyId);
    const categoryTokens = new Set(
      familyCases[0].providerCategoryId.split(/[._]+/).filter(Boolean),
    );
    const terms = familyCases.map(
      (entry) => entry.semanticIntent.retrievalTerms.precision[0],
    );
    assert.equal(new Set(terms).size, 4, `${familyId} needs independent terms`);
    assert.ok(
      terms.every((term) =>
        term.split(/\s+/).every((token) => !categoryTokens.has(token)),
      ),
      `${familyId} hidden terms must not be derived from provider category IDs`,
    );
  }
});

test("two blinded annotations reach Cohen kappa >= 0.80", async () => {
  const fixture = await loadOpenWorldFixture();
  const expandedCases = expandOpenWorldCases(fixture);
  const annotationSets = await loadOpenWorldAnnotationSets();
  const cases = attachOpenWorldAnnotations(expandedCases, annotationSets);
  assert.equal(annotationSets.length, 2);
  assert.notEqual(annotationSets[0].annotatorId, annotationSets[1].annotatorId);
  assert.deepEqual(
    annotationSets.map((set) => set.annotatorId),
    fixture.annotation.annotators,
  );
  assert.ok(annotationSets.every((set) => set.blinded === true));
  assert.ok(annotationSets.every((set) => set.labels.length === cases.length));
  assert.ok(
    annotationSets.every((set) =>
      set.labels.every(
        (label) =>
          Object.keys(label).length === 2 &&
          typeof label.id === "string" &&
          typeof label.outcome === "string",
      ),
    ),
    "blind annotation artifacts must not contain query text",
  );
  const kappa = cohenKappa(
    cases.map((entry) => entry.annotations.annotatorA),
    cases.map((entry) => entry.annotations.annotatorB),
  );
  assert.ok(kappa >= 0.8, `kappa=${kappa}`);
  assert.equal(
    stableCorpusChecksum(expandedCases),
    fixture.expansionContract.expandedChecksum,
    "expanded frozen corpus checksum changed",
  );
});

test("open-world offline evaluation enforces coverage, outcome and zero-tolerance gates", async () => {
  const report = await evaluateOpenWorldCorpus();
  assert.equal(report.sampleCounts.intentCases, 500);
  assert.ok(report.metrics.novelProviderCompilation >= 0.95);
  assert.equal(report.metrics.holdoutProviderCompilation, 1);
  assert.ok(report.metrics.falseUnsupported <= 0.02);
  assert.ok(report.metrics.unsupportedPrecision >= 0.95);
  assert.ok(report.metrics.cohensKappa >= 0.8);
  assert.deepEqual(report.hardGates, {
    openVocabularyRequestViolations: 0,
    geographyOwnershipViolations: 0,
    compilerSafetyViolations: 0,
    providerGroundingViolations: 0,
    cacheVersioningViolations: 0,
    corpusIntegrityViolations: 0,
    annotationAdjudicationViolations: 0,
  });
  assert.equal(report.aggregateOnly, true);
  assert.equal(report.decision, "PASS");
});
