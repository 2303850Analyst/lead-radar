import assert from "node:assert/strict";
import test from "node:test";

import {
  expandPlannerCases,
  loadClassifierFixture,
  loadPlannerFixture,
  meaningfulTokens,
} from "./helpers/query-intelligence-fixtures.mjs";

test("planner fixture contains 30 concept families and 150 base formulations", async () => {
  const fixture = await loadPlannerFixture();
  assert.equal(fixture.conceptFamilies.length, 30);

  const conceptIds = fixture.conceptFamilies.map(
    (family) => family.expectedConceptId,
  );
  assert.equal(new Set(conceptIds).size, 30);
  assert.ok(
    fixture.conceptFamilies.every(
      (family) => family.phrases.length >= 5 && family.split,
    ),
  );

  const cases = expandPlannerCases(fixture);
  assert.equal(
    cases.filter((entry) => entry.kind === "unambiguous").length,
    150,
  );
  assert.ok(cases.length >= 210);
});

test("zero-overlap suite has one full-catalog case per concept", async () => {
  const fixture = await loadPlannerFixture();
  assert.equal(fixture.zeroOverlapCases.length, 30);

  const familyByConcept = new Map(
    fixture.conceptFamilies.map((family) => [family.expectedConceptId, family]),
  );
  const seenConcepts = new Set();

  for (const entry of fixture.zeroOverlapCases) {
    assert.equal(entry.requiresFullCatalog, true, entry.id);
    const family = familyByConcept.get(entry.expectedConceptId);
    assert.ok(family, `${entry.id}: expected concept is missing from families`);
    seenConcepts.add(entry.expectedConceptId);

    const knownTokens = new Set(
      meaningfulTokens([family.canonicalLabel, ...family.phrases].join(" ")),
    );
    const overlap = meaningfulTokens(entry.query).filter((token) =>
      knownTokens.has(token),
    );
    assert.deepEqual(overlap, [], `${entry.id}: token overlap: ${overlap}`);
  }

  assert.equal(seenConcepts.size, 30);
});

test("planner safety and CIS slices are explicit and uniquely identified", async () => {
  const fixture = await loadPlannerFixture();
  assert.ok(fixture.ambiguousCases.length >= 10);
  assert.ok(fixture.unsupportedCases.length >= 10);
  assert.ok(fixture.injectionCases.length >= 10);
  assert.ok(fixture.localizedCases.length >= 12);

  const allCases = expandPlannerCases(fixture);
  const ids = allCases.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(
    fixture.ambiguousCases.every(
      (entry) =>
        entry.expectedStatus === "needs_confirmation" &&
        entry.acceptableAlternatives.length >= 2 &&
        entry.acceptableAlternatives.length <= 3,
    ),
  );
  assert.ok(
    fixture.unsupportedCases.every(
      (entry) => entry.expectedStatus === "unsupported" && entry.reasonTag,
    ),
  );
  assert.ok(
    fixture.injectionCases.every(
      (entry) => entry.forbiddenFragments.length > 0,
    ),
  );

  const localeCountryPairs = new Set(
    fixture.localizedCases.map(
      (entry) => `${entry.countryCode}:${entry.locale}`,
    ),
  );
  assert.ok(localeCountryPairs.has("BY:be-BY"));
  assert.ok(localeCountryPairs.has("KZ:kk-KZ"));
});

test("family split is atomic and the expanded fixture does not leak a family", async () => {
  const fixture = await loadPlannerFixture();
  const familySplits = new Map();
  for (const family of fixture.conceptFamilies) {
    const previous = familySplits.get(family.familyId);
    assert.ok(!previous || previous === family.split, family.familyId);
    familySplits.set(family.familyId, family.split);
  }

  const splitNames = new Set(fixture.conceptFamilies.map((family) => family.split));
  assert.deepEqual(
    [...splitNames].sort(),
    ["development", "holdout", "regression"],
  );
});

test("classifier fixture is balanced, synthetic, and evidence-bounded", async () => {
  const [planner, classifier] = await Promise.all([
    loadPlannerFixture(),
    loadClassifierFixture(),
  ]);
  assert.equal(classifier.privacy.syntheticOnly, true);
  assert.equal(classifier.privacy.containsContacts, false);
  assert.equal(classifier.privacy.containsStreetAddresses, false);
  assert.equal(classifier.privacy.containsRawProviderResponses, false);

  const knownConcepts = new Set(
    planner.conceptFamilies.map((family) => family.expectedConceptId),
  );
  const allowedPointers = new Set(classifier.allowedEvidencePointers);
  const counts = {
    matched: 0,
    ambiguous: 0,
    rejected: 0,
    insufficient_data: 0,
  };
  const ids = new Set();

  for (const entry of classifier.cases) {
    assert.equal(ids.has(entry.id), false, entry.id);
    ids.add(entry.id);
    assert.ok(knownConcepts.has(entry.targetConceptId), entry.id);
    if (entry.materializeProviderCategoriesFromConceptId) {
      assert.ok(
        knownConcepts.has(entry.materializeProviderCategoriesFromConceptId),
        entry.id,
      );
    }
    assert.ok(Object.hasOwn(counts, entry.expected.status), entry.id);
    counts[entry.expected.status] += 1;
    assert.ok(
      entry.expected.requiredEvidencePointers.every((pointer) =>
        allowedPointers.has(pointer),
      ),
      entry.id,
    );
    assert.match(entry.evidence.candidateId, /^synthetic-/);
    assert.ok(
      entry.evidence.locality === null ||
        (!/[\d,]/.test(entry.evidence.locality) &&
          entry.evidence.locality.length <= 80),
      entry.id,
    );
    const serializedEvidence = JSON.stringify(entry.evidence);
    assert.doesNotMatch(serializedEvidence, /https?:\/\//i, entry.id);
    assert.doesNotMatch(
      serializedEvidence,
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
      entry.id,
    );
    assert.doesNotMatch(serializedEvidence, /\+\d[\d ()-]{8,}/, entry.id);
  }

  assert.deepEqual(counts, {
    matched: 15,
    ambiguous: 15,
    rejected: 15,
    insufficient_data: 15,
  });
});
