import assert from "node:assert/strict";
import test from "node:test";

import { GeoapifyProvider } from "../lib/providers/geoapify.ts";
import {
  GEOAPIFY_CAPABILITY_REGISTRY,
  compileGeoapifySemanticIntent,
} from "../lib/search-planner/catalogs/geoapify.ts";
import {
  RELEVANCE_STATUSES,
  classifyCandidateRelevance,
  validateCandidateRelevance,
} from "../lib/search-planner/relevance.ts";

const semanticIntent = {
  schemaVersion: "2.0",
  normalizedGoal: "найти спортивные залы для взрослых",
  entityKind: "physical_business",
  physicalLocationRequirement: "required",
  industries: ["fitness"],
  coreBusinessTypes: ["sports hall", "crossfit gym"],
  adjacentBusinessTypes: ["fitness centre"],
  excludedBusinessTypes: ["children fitness"],
  productsAndServices: ["crossfit training"],
  includeSignals: ["crossfit", "gym"],
  excludeSignals: ["детский"],
  retrievalTerms: {
    precision: ["sports hall", "crossfit gym"],
    recall: ["fitness centre"],
    exclude: ["children fitness", "детский"],
  },
  brandSearch: "include",
  confidence: "high",
  ambiguity: {
    isAmbiguous: false,
    reason: null,
    clarificationQuestion: null,
  },
};

const relevanceContext = {
  semanticIntent,
  precisionCategoryIds: ["sport.fitness.gym", "sport.sports_hall"],
  broadCategoryIds: ["sport.fitness"],
  exclusionTerms: ["детский", "children fitness"],
};

test("relevance contract uses one bounded status and evidence vocabulary", () => {
  assert.deepEqual(RELEVANCE_STATUSES, [
    "matched",
    "maybe",
    "rejected",
    "not_checked",
  ]);

  const matched = classifyCandidateRelevance(
    {
      candidateId: "gym-1",
      name: "CrossFit Север",
      providerCategoryIds: ["sport.fitness.gym"],
      locality: "Москва",
      sourceDescription: "Функциональные тренировки",
    },
    relevanceContext,
  );
  assert.equal(matched.status, "matched");
  assert.equal(matched.source, "deterministic");
  assert.ok(
    matched.evidence.some(
      (fact) =>
        fact.field === "providerCategoryIds" &&
        fact.value === "sport.fitness.gym",
    ),
  );

  const maybe = classifyCandidateRelevance(
    {
      candidateId: "crossfit-name-only",
      name: "CrossFit на районе",
      providerCategoryIds: [],
      locality: "Москва",
      sourceDescription: null,
    },
    relevanceContext,
  );
  assert.equal(maybe.status, "maybe");
  assert.deepEqual(maybe.evidence, [
    { field: "name", value: "CrossFit на районе" },
  ]);

  const excluded = classifyCandidateRelevance(
    {
      candidateId: "children-gym",
      name: "Детский спортивный зал",
      providerCategoryIds: ["sport.fitness.gym"],
      locality: "Москва",
      sourceDescription: null,
    },
    relevanceContext,
  );
  assert.equal(excluded.status, "rejected");
  assert.ok(excluded.reasonCodes.includes("EXCLUSION_MATCH"));

  const insufficient = classifyCandidateRelevance(
    {
      candidateId: "unknown-1",
      name: null,
      providerCategoryIds: [],
      locality: "Москва",
      sourceDescription: null,
    },
    relevanceContext,
  );
  assert.equal(insufficient.status, "not_checked");

  const sibling = classifyCandidateRelevance(
    {
      candidateId: "cafe-1",
      name: "Городское кафе",
      providerCategoryIds: ["catering", "catering.cafe"],
      locality: "Москва",
      sourceDescription: null,
    },
    {
      ...relevanceContext,
      precisionCategoryIds: ["catering.restaurant"],
      broadCategoryIds: [],
      semanticIntent: {
        ...semanticIntent,
        coreBusinessTypes: ["restaurant"],
        includeSignals: ["restaurant"],
        retrievalTerms: {
          precision: ["restaurant"],
          recall: [],
          exclude: [],
        },
      },
    },
  );
  assert.notEqual(sibling.status, "matched");
  assert.equal(sibling.status, "rejected");
});

test("classifier evidence outside CandidateEvidence fails closed", () => {
  const evidence = {
    candidateId: "candidate-1",
    name: "Спортзал",
    providerCategoryIds: ["sport.fitness.gym"],
    locality: "Москва",
    sourceDescription: null,
  };
  const result = validateCandidateRelevance(evidence, {
    candidateId: evidence.candidateId,
    status: "matched",
    confidence: 0.99,
    evidence: [{ field: "phone", value: "+7 999 000-00-00" }],
    reasonCodes: ["MODEL_MATCH"],
    source: "kimi",
  });
  assert.equal(result.status, "not_checked");
  assert.equal(result.source, "not_checked");
  assert.deepEqual(result.evidence, []);
  assert.ok(result.reasonCodes.includes("INVALID_EVIDENCE"));

  const accepted = validateCandidateRelevance(evidence, {
    candidateId: evidence.candidateId,
    status: "matched",
    confidence: 0.91,
    evidence: [
      { field: "providerCategoryIds", value: "sport.fitness.gym" },
    ],
    reasonCodes: ["MODEL_MATCH"],
    source: "kimi",
  });
  assert.equal(accepted.status, "matched");
  assert.equal(accepted.source, "kimi");
  assert.deepEqual(accepted.evidence, [
    { field: "providerCategoryIds", value: "sport.fitness.gym" },
  ]);
});

test("Geoapify classifies after dedupe and enriches only matched or maybe cards", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousDetailsLimit = process.env.GEOAPIFY_DETAILS_LIMIT;
  const previousClassifierFlag = process.env.KIMI_LEAD_CLASSIFICATION_ENABLED;
  const detailIds = [];
  const progress = [];
  process.env.GEOAPIFY_DETAILS_LIMIT = "10";
  delete process.env.KIMI_LEAD_CLASSIFICATION_ENABLED;

  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/v2/places") {
      return Response.json({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: {
              place_id: "gym-1",
              name: "CrossFit Север",
              country_code: "ru",
              city: "Москва",
              formatted: "Москва, Север",
              categories: ["sport.fitness.gym"],
              description: "Функциональные тренировки",
            },
            geometry: { type: "Point", coordinates: [37.61, 55.76] },
          },
          {
            type: "Feature",
            properties: {
              place_id: "restaurant-1",
              name: "Ресторанный зал",
              country_code: "ru",
              city: "Москва",
              formatted: "Москва, Центр",
              categories: ["catering.restaurant"],
              description: "Банкеты и питание",
            },
            geometry: { type: "Point", coordinates: [37.62, 55.75] },
          },
          {
            type: "Feature",
            properties: {
              place_id: "crossfit-name-only",
              name: "CrossFit на районе",
              country_code: "ru",
              city: "Москва",
              formatted: "Москва, Юг",
              categories: [],
            },
            geometry: { type: "Point", coordinates: [37.63, 55.74] },
          },
          {
            type: "Feature",
            properties: {
              place_id: "children-gym",
              name: "Детский спортивный зал",
              country_code: "ru",
              city: "Москва",
              formatted: "Москва, Запад",
              categories: ["sport.fitness.gym"],
            },
            geometry: { type: "Point", coordinates: [37.59, 55.75] },
          },
        ],
      });
    }
    if (url.pathname === "/v2/place-details") {
      detailIds.push(url.searchParams.get("id"));
      return Response.json({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: {
            feature_type: "details",
            contact: { phone: "+7 999 000-00-00" },
          },
        }],
      });
    }
    throw new Error(`Unexpected URL: ${url.pathname}`);
  };

  try {
    const capabilityPlan = compileGeoapifySemanticIntent(semanticIntent);
    const provider = new GeoapifyProvider("test-only-placeholder-key");
    const result = await provider.search(
      {
        description: "спортзал без детских секций",
        primaryQuery: "спортивный зал",
        relatedQueries: ["кроссфит"],
        excludeQueries: ["детский"],
        location: "Москва",
        center: [37.6176, 55.7558],
        radiusKm: 5,
        services: [],
        locale: "ru-RU",
        countryCodes: ["RU"],
      },
      {
        semanticIntent,
        compiledPlan: {
          ...capabilityPlan,
          providerCatalogVersion: GEOAPIFY_CAPABILITY_REGISTRY.version,
          registryChecksum: GEOAPIFY_CAPABILITY_REGISTRY.checksum,
          countryCode: "RU",
          language: "ru",
          conceptIds: [],
        },
        onProgress: (event) => progress.push(event.stage),
      },
    );

    assert.equal(result.leads.length, 4, "rejected cards remain inspectable");
    assert.equal(result.summary.relevance.matched, 1);
    assert.equal(result.summary.relevance.maybe, 1);
    assert.equal(result.summary.relevance.rejected, 2);
    assert.equal(result.summary.relevance.notChecked, 0);
    assert.deepEqual(detailIds.sort(), ["crossfit-name-only", "gym-1"]);
    assert.ok(progress.indexOf("relevance_classification") < progress.indexOf("details"));
    assert.equal(
      result.leads.find((lead) => lead.id === "geoapify-restaurant-1")?.relevance.status,
      "rejected",
    );
    assert.equal(
      result.leads.find((lead) => lead.id === "geoapify-crossfit-name-only")?.relevance.status,
      "maybe",
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDetailsLimit === undefined) delete process.env.GEOAPIFY_DETAILS_LIMIT;
    else process.env.GEOAPIFY_DETAILS_LIMIT = previousDetailsLimit;
    if (previousClassifierFlag === undefined) {
      delete process.env.KIMI_LEAD_CLASSIFICATION_ENABLED;
    } else {
      process.env.KIMI_LEAD_CLASSIFICATION_ENABLED = previousClassifierFlag;
    }
  }
});

test("optional classifier failure keeps cards as not_checked without enrichment", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousDetailsLimit = process.env.GEOAPIFY_DETAILS_LIMIT;
  const previousClassifierFlag = process.env.KIMI_LEAD_CLASSIFICATION_ENABLED;
  const previousClassifierTimeout = process.env.KIMI_LEAD_CLASSIFIER_TIMEOUT_MS;
  let detailCalls = 0;
  let classifierInput;
  process.env.GEOAPIFY_DETAILS_LIMIT = "10";
  process.env.KIMI_LEAD_CLASSIFICATION_ENABLED = "true";
  process.env.KIMI_LEAD_CLASSIFIER_TIMEOUT_MS = "20";

  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.pathname === "/v2/places") {
      return Response.json({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: {
            name: "CrossFit на районе",
            country_code: "ru",
            city: "Москва",
            street: "Секретная улица",
            housenumber: "42",
            formatted: "Москва, Секретная улица, 42",
            categories: [
              ...GEOAPIFY_CAPABILITY_REGISTRY.categories.slice(0, 40),
              ...GEOAPIFY_CAPABILITY_REGISTRY.categories.slice(0, 5),
            ],
          },
          geometry: { type: "Point", coordinates: [37.61, 55.76] },
        }],
      });
    }
    if (url.pathname === "/v2/place-details") {
      detailCalls += 1;
      return Response.json({ type: "FeatureCollection", features: [] });
    }
    throw new Error(`Unexpected URL: ${url.pathname}`);
  };

  try {
    const capabilityPlan = compileGeoapifySemanticIntent(semanticIntent);
    const provider = new GeoapifyProvider("test-only-placeholder-key");
    const payload = {
      description: "кроссфит",
      primaryQuery: "кроссфит",
      relatedQueries: [],
      excludeQueries: [],
      location: "Москва",
      center: [37.6176, 55.7558],
      radiusKm: 5,
      services: [],
      locale: "ru-RU",
      countryCodes: ["RU"],
    };
    const compiledPlan = {
      ...capabilityPlan,
      countryCode: "RU",
      language: "ru",
      conceptIds: [],
    };
    const result = await provider.search(
      payload,
      {
        semanticIntent,
        compiledPlan,
        relevanceClassifier: {
          classify(input) {
            classifierInput = input;
            return new Promise(() => undefined);
          },
        },
      },
    );

    assert.deepEqual(
      Object.keys(classifierInput.candidates[0]).sort(),
      ["candidateId", "locality", "name", "providerCategoryIds", "sourceDescription"],
    );
    assert.match(classifierInput.candidates[0].candidateId, /^candidate-\d{4}$/);
    assert.ok(classifierInput.candidates[0].providerCategoryIds.length <= 32);
    assert.equal(
      new Set(classifierInput.candidates[0].providerCategoryIds).size,
      classifierInput.candidates[0].providerCategoryIds.length,
    );
    assert.doesNotMatch(
      JSON.stringify(classifierInput),
      /Секретная улица|42/,
      "classifier input must not reuse address-bearing fallback provider IDs",
    );
    assert.equal(result.leads.length, 1);
    assert.equal(result.leads[0].relevance.status, "not_checked");
    assert.equal(result.provider.coverage.relevance.classifier, "degraded");
    assert.equal(detailCalls, 0);

    const invalidOutput = await provider.search(payload, {
      semanticIntent,
      compiledPlan,
      relevanceClassifier: {
        classify(input) {
          const candidateId = input.candidates[0].candidateId;
          const record = {
            candidateId,
            status: "matched",
            confidence: 0.9,
            evidence: [{ field: "name", value: input.candidates[0].name }],
            reasonCodes: ["MODEL_MATCH"],
            source: "kimi",
          };
          return Promise.resolve([record, { ...record }]);
        },
      },
    });
    assert.equal(
      invalidOutput.provider.coverage.relevance.classifier,
      "degraded",
    );
    assert.equal(invalidOutput.leads[0].relevance.status, "not_checked");
    assert.equal(detailCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDetailsLimit === undefined) delete process.env.GEOAPIFY_DETAILS_LIMIT;
    else process.env.GEOAPIFY_DETAILS_LIMIT = previousDetailsLimit;
    if (previousClassifierFlag === undefined) {
      delete process.env.KIMI_LEAD_CLASSIFICATION_ENABLED;
    } else {
      process.env.KIMI_LEAD_CLASSIFICATION_ENABLED = previousClassifierFlag;
    }
    if (previousClassifierTimeout === undefined) {
      delete process.env.KIMI_LEAD_CLASSIFIER_TIMEOUT_MS;
    } else {
      process.env.KIMI_LEAD_CLASSIFIER_TIMEOUT_MS = previousClassifierTimeout;
    }
  }
});
