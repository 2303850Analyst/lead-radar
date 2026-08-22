import assert from "node:assert/strict";
import test from "node:test";

import {
  compileGeoapifySemanticIntent,
} from "../lib/search-planner/catalogs/geoapify.ts";
import { createSearchPlan } from "../lib/search-planner/planner.ts";
import { GeoapifyProvider } from "../lib/providers/geoapify.ts";
import {
  GeoapifyNativeRecoveryError,
  projectGeoapifyNativeRecovery,
  resolveGeoapifyNativeRecovery,
} from "../lib/geoapify-native-recovery.ts";

function physicalIntent(coreBusinessType) {
  return {
    schemaVersion: "2.2",
    normalizedGoal: `find ${coreBusinessType}`,
    entityKind: "physical_business",
    physicalLocationRequirement: "required",
    industries: ["retail"],
    coreBusinessTypes: [coreBusinessType],
    adjacentBusinessTypes: [],
    excludedBusinessTypes: [],
    productsAndServices: [],
    includeSignals: [coreBusinessType],
    excludeSignals: [],
    retrievalTerms: {
      precision: [coreBusinessType],
      recall: [],
      exclude: [],
    },
    brandSearch: "include",
    confidence: "high",
    ambiguity: {
      isAmbiguous: false,
      reason: null,
      clarificationQuestion: null,
    },
  };
}

test("native recovery projects one signed source fallback and drops model fallbacks", () => {
  const compiled = compileGeoapifySemanticIntent(
    physicalIntent("optical shop"),
    {
      primaryQuery: "салон оптики",
      relatedQueries: ["магазин очков"],
    },
  );
  const before = JSON.stringify(compiled);

  const authorization = projectGeoapifyNativeRecovery(compiled);

  assert.ok(authorization);
  assert.equal(authorization.kind, "geoapify_source_native_v1");
  assert.equal(authorization.capabilityPlan.batches.length, 1);
  assert.equal(authorization.executionPreview.batches, 1);
  assert.equal(authorization.planArmId, compiled.batches[0].id);
  assert.deepEqual(
    authorization.capabilityPlan.categoryIds,
    authorization.capabilityPlan.batches[0].categoryIds,
  );
  assert.deepEqual(
    authorization.capabilityPlan.batches[0].provenance.map(
      (item) => item.origin,
    ),
    Array(authorization.capabilityPlan.batches[0].provenance.length).fill(
      "source.primaryQuery",
    ),
  );
  assert.equal(
    JSON.stringify(authorization).includes("optical shop"),
    false,
    "model-derived fallback terms must not enter the authorization",
  );
  assert.equal(JSON.stringify(compiled), before, "projection must be immutable");
});

test("native recovery resolves one corroborated allowlisted leaf through one external call", async () => {
  const compiled = compileGeoapifySemanticIntent(
    physicalIntent("optical shop"),
    { primaryQuery: "салон оптики", relatedQueries: [] },
  );
  const authorization = projectGeoapifyNativeRecovery(compiled);
  assert.ok(authorization);
  const before = JSON.stringify(authorization);
  const requests = [];
  const port = {
    async autocomplete(request) {
      requests.push(request);
      return {
        kind: "observations",
        observations: [
          {
            categoryId: "commercial.health_and_beauty.optician",
            countryCode: "RU",
            coordinates: [37.6176, 55.7558],
            providerPlaceId: "optician-evidence-1",
          },
          {
            categoryId: "commercial.health_and_beauty.optician",
            countryCode: "ru",
            coordinates: [37.62, 55.756],
            providerPlaceId: "optician-evidence-2",
          },
        ],
      };
    },
  };

  const resolved = await resolveGeoapifyNativeRecovery(
    {
      authorization,
      center: [37.6176, 55.7558],
      radiusMeters: 5_000,
      countryCode: "RU",
      language: "ru",
      timeoutMs: 1_500,
    },
    port,
  );

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], {
    text: "салон оптики",
    center: [37.6176, 55.7558],
    radiusMeters: 5_000,
    countryCode: "RU",
    language: "ru",
    limit: 5,
    timeoutMs: 1_500,
    signal: undefined,
  });
  assert.equal(resolved.categoryResolution.status, "resolved");
  assert.equal(resolved.categoryResolution.requests, 1);
  assert.equal(resolved.categoryPlan.batches.length, 1);
  assert.deepEqual(resolved.categoryPlan.categoryIds, [
    "commercial.health_and_beauty.optician",
  ]);
  assert.deepEqual(resolved.categoryPlan.batches[0].categoryIds, [
    "commercial.health_and_beauty.optician",
  ]);
  assert.equal(resolved.armBinding.planArmId, authorization.planArmId);
  assert.notEqual(resolved.armBinding.runtimeArmId, authorization.planArmId);
  assert.equal(JSON.stringify(authorization), before);
});

test("native recovery blocks before external I/O when its one-shot budget is unavailable", async () => {
  const compiled = compileGeoapifySemanticIntent(
    physicalIntent("optical shop"),
    { primaryQuery: "салон оптики", relatedQueries: [] },
  );
  const authorization = projectGeoapifyNativeRecovery(compiled);
  assert.ok(authorization);
  let calls = 0;

  await assert.rejects(
    resolveGeoapifyNativeRecovery(
      {
        authorization,
        center: [37.6176, 55.7558],
        radiusMeters: 5_000,
        countryCode: "RU",
        language: "ru",
        timeoutMs: 299,
      },
      {
        async autocomplete() {
          calls += 1;
          return { kind: "observations", observations: [] };
        },
      },
    ),
    (error) =>
      error instanceof GeoapifyNativeRecoveryError &&
      error.code === "budget" &&
      error.requests === 0,
  );
  assert.equal(calls, 0);
});

test("native recovery rejects a modified authorization before external I/O", async () => {
  const compiled = compileGeoapifySemanticIntent(
    physicalIntent("optical shop"),
    { primaryQuery: "салон оптики", relatedQueries: [] },
  );
  const authorization = projectGeoapifyNativeRecovery(compiled);
  assert.ok(authorization);
  const modified = structuredClone(authorization);
  modified.executionPreview.retrievalArms[0].resultBudget += 1;
  let calls = 0;

  await assert.rejects(
    resolveGeoapifyNativeRecovery(
      {
        authorization: modified,
        center: [37.6176, 55.7558],
        radiusMeters: 5_000,
        countryCode: "RU",
        language: "ru",
        timeoutMs: 1_500,
      },
      {
        async autocomplete() {
          calls += 1;
          return { kind: "observations", observations: [] };
        },
      },
    ),
    (error) =>
      error instanceof GeoapifyNativeRecoveryError &&
      error.code === "invalid_authorization" &&
      error.requests === 0,
  );
  assert.equal(calls, 0);
});

test("native recovery cannot manufacture quorum from blank provider IDs", async () => {
  const compiled = compileGeoapifySemanticIntent(
    physicalIntent("optical shop"),
    { primaryQuery: "салон оптики", relatedQueries: [] },
  );
  const authorization = projectGeoapifyNativeRecovery(compiled);
  assert.ok(authorization);

  await assert.rejects(
    resolveGeoapifyNativeRecovery(
      {
        authorization,
        center: [37.6176, 55.7558],
        radiusMeters: 5_000,
        countryCode: "RU",
        language: "ru",
        timeoutMs: 1_500,
      },
      {
        async autocomplete() {
          return {
            kind: "observations",
            observations: [
              {
                categoryId: "commercial.health_and_beauty.optician",
                countryCode: "RU",
                coordinates: [37.62, 55.756],
                providerPlaceId: " ",
              },
              {
                categoryId: "commercial.health_and_beauty.optician",
                countryCode: "RU",
                coordinates: [37.62, 55.756],
                providerPlaceId: "\t",
              },
            ],
          };
        },
      },
    ),
    (error) =>
      error instanceof GeoapifyNativeRecoveryError &&
      error.code === "no_match" &&
      error.requests === 1,
  );
});

test("planner signs one source-native recovery arm for any unambiguous physical provider gap", async () => {
  const semanticIntent = {
    ...physicalIntent("custom keyboard workshop"),
    confidence: "medium",
  };
  const client = {
    modelId: "mock-kimi-native-recovery",
    async encode() {
      return {
        semanticIntent,
        providerNeutralCategoryHeads: ["optical shop"],
        modelId: this.modelId,
        finishReason: "stop",
        latencyMs: 1,
        usage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          totalTokens: 15,
        },
      };
    },
  };

  const plan = await createSearchPlan(
    {
      primaryQuery: "мастерская кастомных клавиатур",
      relatedQueries: [],
      excludeQueries: [],
      locale: "ru-RU",
      countryCodes: ["RU"],
    },
    { mode: "kimi", kimiClient: client },
  );

  assert.equal(plan.status, "ready");
  assert.equal(plan.confidence.providerCoverage, "unknown");
  assert.deepEqual(plan.resolution.reasonCodes, [
    "SEMANTIC_MATCH",
    "PROVIDER_COVERAGE_GAP",
  ]);
  assert.equal(plan.executionPreview?.retrievalArms.length, 1);
  assert.equal(plan.executionPreview?.retrievalArms[0].type, "fallback");
  assert.equal(plan.executionPreview?.retrievalArms[0].usesNameFallback, true);
  assert.ok(
    plan.executionPreview?.retrievalArms[0].provenance.every(
      (item) => item.origin === "source.primaryQuery",
    ),
  );
  assert.equal(
    JSON.stringify(plan.executionPreview).includes("optical shop"),
    false,
  );
});

test("required native recovery falls back to source text when autocomplete is unavailable", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousHints = process.env.GEOAPIFY_CATEGORY_HINTS_ENABLED;
  const previousDetails = process.env.GEOAPIFY_DETAILS_LIMIT;
  process.env.GEOAPIFY_CATEGORY_HINTS_ENABLED = "false";
  process.env.GEOAPIFY_DETAILS_LIMIT = "0";
  const compiled = compileGeoapifySemanticIntent(
    physicalIntent("custom keyboard workshop"),
    { primaryQuery: "мастерская кастомных клавиатур", relatedQueries: [] },
  );
  const authorization = projectGeoapifyNativeRecovery(compiled);
  assert.ok(authorization);
  const paths = [];
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    paths.push(url.pathname);
    if (url.pathname === "/v1/geocode/autocomplete") {
      return Response.json({ error: "temporary" }, { status: 503 });
    }
    assert.equal(url.pathname, "/v1/geocode/search");
    assert.match(
      url.searchParams.get("text") ?? "",
      /мастерская кастомных клавиатур/i,
    );
    return Response.json({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {
          place_id: "custom-keyboard-workshop-1",
          name: "Custom Keyboard Workshop",
          country_code: "ru",
          formatted: "Москва",
          categories: ["commercial"],
        },
        geometry: { type: "Point", coordinates: [37.62, 55.756] },
      }],
    });
  };

  try {
    const result = await new GeoapifyProvider("test-only-key").search(
        {
          description: "",
          primaryQuery: "мастерская кастомных клавиатур",
          relatedQueries: [],
          excludeQueries: [],
          location: "Москва",
          center: [37.6176, 55.7558],
          radiusKm: 5,
          services: [],
          locale: "ru-RU",
          countryCodes: ["RU"],
        },
        {
          semanticIntent: physicalIntent("custom keyboard workshop"),
          compiledPlan: {
            ...authorization.capabilityPlan,
            nativeCategoryResolutionRequired: true,
            countryCode: "RU",
            language: "ru",
            conceptIds: [],
          },
        },
      );
    assert.deepEqual(paths, [
      "/v1/geocode/autocomplete",
      "/v1/geocode/search",
    ]);
    assert.equal(result.outcome, "success_with_results");
    assert.equal(result.leads.length, 1);
    assert.equal(result.leads[0].relevance.status, "maybe");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHints === undefined) {
      delete process.env.GEOAPIFY_CATEGORY_HINTS_ENABLED;
    } else {
      process.env.GEOAPIFY_CATEGORY_HINTS_ENABLED = previousHints;
    }
    if (previousDetails === undefined) {
      delete process.env.GEOAPIFY_DETAILS_LIMIT;
    } else {
      process.env.GEOAPIFY_DETAILS_LIMIT = previousDetails;
    }
  }
});

test("source-text fallback drops unrelated nearby organizations", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousHints = process.env.GEOAPIFY_CATEGORY_HINTS_ENABLED;
  const previousDetails = process.env.GEOAPIFY_DETAILS_LIMIT;
  process.env.GEOAPIFY_CATEGORY_HINTS_ENABLED = "false";
  process.env.GEOAPIFY_DETAILS_LIMIT = "0";
  const compiled = compileGeoapifySemanticIntent(
    physicalIntent("eyelash extension studio"),
    { primaryQuery: "Наращивание ресниц", relatedQueries: [] },
  );
  const authorization = projectGeoapifyNativeRecovery(compiled);
  assert.ok(authorization);
  const paths = [];
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    paths.push(url.pathname);
    if (url.pathname === "/v1/geocode/autocomplete") {
      return Response.json({ error: "temporary" }, { status: 503 });
    }
    assert.equal(url.pathname, "/v1/geocode/search");
    assert.match(
      url.searchParams.get("text") ?? "",
      /наращивание ресниц/i,
    );
    return Response.json({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            place_id: "nearby-office-1",
            name: "Nextons",
            country_code: "ru",
            formatted: "Лесная улица 7, Москва",
            categories: ["office"],
          },
          geometry: { type: "Point", coordinates: [37.5907, 55.78] },
        },
        {
          type: "Feature",
          properties: {
            place_id: "nearby-atm-1",
            name: "Промсвязьбанк",
            country_code: "ru",
            formatted: "Лесная улица 7, Москва",
            categories: ["service.financial.atm"],
          },
          geometry: { type: "Point", coordinates: [37.5907, 55.78] },
        },
        {
          type: "Feature",
          properties: {
            place_id: "nearby-restaurant-1",
            name: "Mozza",
            country_code: "ru",
            formatted: "Лесная улица 7, Москва",
            categories: ["catering.restaurant"],
          },
          geometry: { type: "Point", coordinates: [37.5907, 55.78] },
        },
      ],
    });
  };

  try {
    const result = await new GeoapifyProvider("test-only-key").search(
      {
        description: "",
        primaryQuery: "Наращивание ресниц",
        relatedQueries: [],
        excludeQueries: [],
        location: "Москва, ул. Лесная, 7",
        center: [37.5907, 55.78],
        radiusKm: 15,
        services: [],
        locale: "ru-RU",
        countryCodes: ["RU"],
      },
      {
        semanticIntent: physicalIntent("eyelash extension studio"),
        compiledPlan: {
          ...authorization.capabilityPlan,
          nativeCategoryResolutionRequired: true,
          countryCode: "RU",
          language: "ru",
          conceptIds: [],
        },
      },
    );
    assert.deepEqual(paths, [
      "/v1/geocode/autocomplete",
      "/v1/geocode/search",
    ]);
    assert.equal(result.outcome, "success_empty");
    assert.equal(result.summary.cardsFound, 0);
    assert.equal(result.leads.length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHints === undefined) {
      delete process.env.GEOAPIFY_CATEGORY_HINTS_ENABLED;
    } else {
      process.env.GEOAPIFY_CATEGORY_HINTS_ENABLED = previousHints;
    }
    if (previousDetails === undefined) {
      delete process.env.GEOAPIFY_DETAILS_LIMIT;
    } else {
      process.env.GEOAPIFY_DETAILS_LIMIT = previousDetails;
    }
  }
});
