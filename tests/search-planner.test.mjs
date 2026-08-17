import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  GEOAPIFY_CAPABILITY_REGISTRY,
  GEOAPIFY_CATEGORY_IDS,
  compileGeoapifySemanticIntent,
  compileGeoapifySelectors,
  validateGeoapifyCatalogCoverage,
} from "../lib/search-planner/catalogs/geoapify.ts";
import {
  ConfirmationTokenError,
  issueConfirmationToken,
  verifyConfirmationToken,
} from "../lib/search-planner/confirmation-token.ts";
import { canonicalJson } from "../lib/search-planner/hashing.ts";
import {
  KimiClientError,
  createKimiClient,
} from "../lib/search-planner/kimi-client.ts";
import {
  DECISION_POLICY_VERSION,
  confirmSearchPlan,
  createSearchPlan,
} from "../lib/search-planner/planner.ts";
import {
  lexicalSimilarity,
  normalizePlannerInput,
  normalizeSearchText,
  resolveDeterministically,
} from "../lib/search-planner/resolver.ts";
import {
  KIMI_SEMANTIC_INTENT_SCHEMA,
  validateKimiSemanticIntent,
} from "../lib/search-planner/schema.ts";
import { isSearchPlan } from "../lib/search-planner/guards.ts";
import {
  CANONICAL_CONCEPT_IDS,
  CANONICAL_TAXONOMY,
  CANONICAL_TAXONOMY_VERSION,
} from "../lib/search-planner/taxonomy.ts";
import { GEOAPIFY_PROVIDER_CATALOG_VERSION } from "../lib/search-planner/catalogs/geoapify.ts";

import { createGoldenKimiClient } from "./helpers/golden-kimi-client.mjs";
import { GeoapifyProvider } from "../lib/providers/geoapify.ts";
import { SearchProviderError } from "../lib/providers/types.ts";
import {
  loadPlannerFixture,
} from "./helpers/query-intelligence-fixtures.mjs";

const signingSecret = "test-only-confirmation-secret-32-bytes-minimum";

function plannerInput(query, locale = "ru-RU", countryCode = "RU") {
  return {
    description: "",
    primaryQuery: query,
    relatedQueries: [],
    excludeQueries: [],
    locale,
    countryCodes: [countryCode],
  };
}

function kimiRequestFor(query) {
  const intent = normalizePlannerInput(plannerInput(query));
  return { intent };
}

function semanticIntentFor(coreBusinessType = "барбершоп") {
  return {
    schemaVersion: "2.0",
    normalizedGoal: `найти ${coreBusinessType}`,
    entityKind: "physical_business",
    physicalLocationRequirement: "required",
    industries: ["услуги"],
    coreBusinessTypes: [coreBusinessType],
    adjacentBusinessTypes: [],
    excludedBusinessTypes: [],
    productsAndServices: [],
    includeSignals: [coreBusinessType],
    excludeSignals: [],
    retrievalTerms: {
      precision: [coreBusinessType, "business location"],
      recall: [coreBusinessType, "local business"],
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

test("taxonomy and Geoapify catalog have complete allowlisted coverage", async () => {
  const fixture = await loadPlannerFixture();
  assert.ok(CANONICAL_TAXONOMY.length >= 30);
  assert.ok(CANONICAL_TAXONOMY.length <= 60);
  assert.equal(new Set(CANONICAL_CONCEPT_IDS).size, CANONICAL_CONCEPT_IDS.length);
  assert.equal(new Set(GEOAPIFY_CATEGORY_IDS).size, GEOAPIFY_CATEGORY_IDS.length);
  assert.deepEqual(validateGeoapifyCatalogCoverage(), {
    valid: true,
    missingConceptIds: [],
    unknownBindingConceptIds: [],
    unknownCategoryIds: [],
  });

  const knownConcepts = new Set(CANONICAL_CONCEPT_IDS);
  for (const family of fixture.conceptFamilies) {
    assert.ok(knownConcepts.has(family.expectedConceptId), family.familyId);
    const compiled = compileGeoapifySelectors([family.expectedConceptId]);
    assert.ok(compiled.categoryIds.length > 0, family.familyId);
    assert.ok(
      compiled.categoryIds.every((categoryId) =>
        GEOAPIFY_CATEGORY_IDS.includes(categoryId),
      ),
      family.familyId,
    );
  }
  assert.throws(
    () => compileGeoapifySelectors(["airport", "https://evil.invalid"]),
    /unknown canonical concept/i,
  );
});

test("Geoapify capability registry is full, versioned, checksummed, and compiles sports", () => {
  assert.ok(GEOAPIFY_CAPABILITY_REGISTRY.categories.length >= 800);
  assert.equal(
    createHash("sha256")
      .update(GEOAPIFY_CAPABILITY_REGISTRY.categories.join("\n"))
      .digest("hex"),
    GEOAPIFY_CAPABILITY_REGISTRY.checksum,
  );
  const semanticIntent = {
    ...semanticIntentFor("sports hall"),
    industries: ["sport", "fitness"],
    coreBusinessTypes: ["sports hall", "gym", "fitness centre"],
    adjacentBusinessTypes: ["sport club"],
    productsAndServices: ["fitness training"],
    includeSignals: ["sports hall", "gym", "fitness centre"],
    retrievalTerms: {
      precision: ["sports hall", "gym", "fitness centre"],
      recall: ["fitness", "sport club"],
      exclude: ["sporting goods store"],
    },
  };
  const plan = compileGeoapifySemanticIntent(semanticIntent);
  assert.ok(plan.categoryIds.includes("sport.sports_hall"));
  assert.ok(plan.categoryIds.includes("sport.fitness.gym"));
  assert.ok(plan.categoryIds.includes("sport.fitness.fitness_centre"));
  assert.equal(plan.categoryIds.some((id) => id.startsWith("catering.")), false);
  assert.ok(plan.batches.length >= 1 && plan.batches.length <= 2);
  assert.ok(plan.batches.some((batch) => batch.mode === "precision"));
  assert.ok(plan.batches.every((batch) => batch.provenance.length > 0));
  assert.ok(plan.batches.every((batch) => batch.categoryIds.length <= 8));
});

test("Geoapify semantic compiler rejects collapsed infrastructure false positives", () => {
  for (const term of ["building", "highway", "pet store"]) {
    const plan = compileGeoapifySemanticIntent({
      ...semanticIntentFor(term),
      retrievalTerms: { precision: [term], recall: [], exclude: [] },
    });
    assert.equal(
      plan.categoryIds.some((categoryId) =>
        ["building.service", "highway.service", "pet.service"].includes(categoryId),
      ),
      false,
      term,
    );
    assert.equal(
      plan.categoryIds.some((categoryId) => !categoryId.includes(".")),
      false,
      term,
    );
  }
});

test("Geoapify semantic exclusions remove contradictory retrieval categories", () => {
  const plan = compileGeoapifySemanticIntent({
    ...semanticIntentFor("sports hall"),
    coreBusinessTypes: ["sports hall"],
    adjacentBusinessTypes: ["restaurant"],
    excludedBusinessTypes: ["restaurant"],
    excludeSignals: ["restaurant"],
    retrievalTerms: {
      precision: ["sports hall"],
      recall: ["restaurant"],
      exclude: ["restaurant"],
    },
  });
  assert.ok(plan.categoryIds.includes("sport.sports_hall"));
  assert.equal(plan.categoryIds.includes("catering.restaurant"), false);
});

test("Geoapify adapter rejects a category injected into a compiled batch", async () => {
  const provider = new GeoapifyProvider("test-only-placeholder-key");
  await assert.rejects(
    provider.search(
      {
        description: "спорт",
        primaryQuery: "Спортивный зал",
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
        compiledPlan: {
          provider: "geoapify",
          providerCatalogVersion: GEOAPIFY_CAPABILITY_REGISTRY.version,
          registryChecksum: GEOAPIFY_CAPABILITY_REGISTRY.checksum,
          categoryIds: ["sport.fitness.gym"],
          batches: [{
            id: "precision",
            mode: "precision",
            categoryIds: ["model.authored.not_in_registry"],
            provenance: [{
              semanticField: "precision",
              semanticTerm: "gym",
              match: "exact_leaf",
              categoryId: "model.authored.not_in_registry",
            }],
          }],
          countryCode: "RU",
          language: "ru",
          conceptIds: [],
        },
      },
    ),
    (error) =>
      error instanceof SearchProviderError &&
      error.code === "GEOAPIFY_UNSUPPORTED_CATEGORY",
  );
});

test("Geoapify adapter rejects incoherent category and provenance sets", async () => {
  const provider = new GeoapifyProvider("test-only-placeholder-key");
  await assert.rejects(
    provider.search(
      {
        description: "спорт",
        primaryQuery: "Спортивный зал",
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
        compiledPlan: {
          provider: "geoapify",
          providerCatalogVersion: GEOAPIFY_CAPABILITY_REGISTRY.version,
          registryChecksum: GEOAPIFY_CAPABILITY_REGISTRY.checksum,
          categoryIds: ["sport.fitness.gym"],
          batches: [{
            id: "precision",
            mode: "precision",
            categoryIds: ["catering.restaurant"],
            provenance: [{
              semanticField: "precision",
              semanticTerm: "gym",
              match: "exact_leaf",
              categoryId: "sport.fitness.gym",
            }],
          }],
          countryCode: "RU",
          language: "ru",
          conceptIds: [],
        },
      },
    ),
    (error) =>
      error instanceof SearchProviderError &&
      error.code === "GEOAPIFY_INVALID_COMPILED_PLAN",
  );
});

test("SemanticIntentV2 schema is strict, bounded, and open vocabulary", () => {
  const customIntent = semanticIntentFor("студия ухода за редкими растениями");
  assert.deepEqual(validateKimiSemanticIntent(customIntent), customIntent);
  const serializedSchema = JSON.stringify(KIMI_SEMANTIC_INTENT_SCHEMA);
  assert.equal(serializedSchema.includes("conceptId"), false);
  assert.equal(serializedSchema.includes("personal_care.barbershop"), false);
  assert.equal(KIMI_SEMANTIC_INTENT_SCHEMA.additionalProperties, false);
  assert.throws(
    () =>
      validateKimiSemanticIntent({
        ...customIntent,
        coreBusinessTypes: ["x".repeat(121)],
      }),
    /more than 120 characters/i,
  );
  assert.throws(
    () =>
      validateKimiSemanticIntent({
        ...customIntent,
        providerUrl: "https://evil.invalid",
      }),
    /additional properties/i,
  );
  assert.throws(
    () => validateKimiSemanticIntent(semanticIntentFor("https://evil.invalid")),
    /must not contain URLs/i,
  );
  for (const executableValue of [
    "55.7558 37.6176",
    "55.75 37.61",
    "geo:55.75,37.61",
    "GET /v2/places?type=amenity",
    "filter: place=city",
    "javascript:alert(1)",
    "mailto:user@example.com",
    "file:C:/tmp/x",
    "ftp://evil.invalid",
    "//evil.invalid/path",
    "sport.fitness.gym",
  ]) {
    assert.throws(
      () => validateKimiSemanticIntent(semanticIntentFor(executableValue)),
      /provider parameters/i,
      executableValue,
    );
  }
  assert.throws(
    () =>
      validateKimiSemanticIntent({
        ...semanticIntentFor("спортивный зал"),
        retrievalTerms: {
          precision: ["спортивный зал"],
          recall: ["спортзал"],
          exclude: [],
        },
      }),
    /English equivalent/i,
  );
});

test("SearchPlan runtime guard rejects partial V2 payloads before UI rendering", () => {
  assert.equal(isSearchPlan(null), false);
  assert.equal(
    isSearchPlan({
      status: "ready",
      semanticIntent: { schemaVersion: "2.0" },
      resolution: { selectedConceptIds: [], alternatives: [] },
    }),
    false,
  );
  const renderablePlan = {
    schemaVersion: "2.0",
    taxonomyVersion: "test-taxonomy",
    providerCatalogVersion: "test-provider",
    decisionPolicyVersion: "test-policy",
    promptVersion: "test-prompt",
    requestCacheKey: "test-request",
    planHash: "test-plan",
    parentPlanHash: null,
    status: "ready",
    intent: {
      description: "",
      primaryQuery: "барбершоп",
      relatedQueries: [],
      excludeQueries: [],
      locale: "ru-RU",
      countryCodes: ["RU"],
    },
    semanticIntent: semanticIntentFor(),
    confidence: { intent: "high", providerCoverage: "medium" },
    resolution: {
      method: "kimi",
      selectedConceptIds: [],
      alternatives: [],
      confidenceBand: "high",
      reasonCodes: [],
      clarificationQuestion: null,
    },
    executionPreview: null,
    ai: {
      used: true,
      modelId: "kimi-k3",
      latencyMs: 100,
      inputTokens: 10,
      outputTokens: 20,
      finishReason: "stop",
      validation: "passed",
      cacheHit: false,
    },
    confirmation: { token: null, expiresAt: null },
  };
  assert.equal(isSearchPlan(renderablePlan), true);
  const withoutPlanHash = { ...renderablePlan };
  delete withoutPlanHash.planHash;
  assert.equal(isSearchPlan(withoutPlanHash), false);
  assert.equal(isSearchPlan({ ...renderablePlan, executionPreview: {} }), false);
  assert.equal(
    isSearchPlan({
      ...renderablePlan,
      semanticIntent: { ...renderablePlan.semanticIntent, coreBusinessTypes: null },
    }),
    false,
  );
  assert.equal(
    isSearchPlan({
      ...renderablePlan,
      semanticIntent: { ...renderablePlan.semanticIntent, confidence: "unknown" },
    }),
    false,
  );
});

test("normalization, resolver output, and canonical JSON are deterministic", () => {
  assert.equal(normalizeSearchText("  БАРБЕРШОП\u00a0\u00a0Ё  "), "барбершоп е");
  const normalized = normalizePlannerInput({
    primaryQuery: " Барбершоп ",
    relatedQueries: ["Мужская стрижка", "мужская стрижка", "Барбер"],
    excludeQueries: ["Груминг", "груминг"],
    locale: "ru-RU",
    countryCodes: ["RU"],
  });
  assert.deepEqual(normalized.relatedQueries, ["барбер", "мужская стрижка"]);
  assert.deepEqual(normalized.excludeQueries, ["груминг"]);

  const first = resolveDeterministically(normalized);
  for (let index = 0; index < 50; index += 1) {
    assert.deepEqual(resolveDeterministically(normalized), first);
  }
  assert.equal(
    canonicalJson({ z: 1, nested: { b: 2, a: 1 }, a: 2 }),
    canonicalJson({ a: 2, nested: { a: 1, b: 2 }, z: 1 }),
  );
});

test("fuzzy retrieval shortlists a typo without unsafe auto-run", () => {
  assert.equal(lexicalSimilarity("супермаркет", "супермаркет"), 1);
  const intent = normalizePlannerInput(plannerInput("супермаркетт"));
  const resolution = resolveDeterministically(intent);
  assert.equal(resolution.decision, "semantic_required");
  assert.equal(resolution.method, "fuzzy");
  assert.equal(resolution.selectedConceptId, null);
  assert.equal(resolution.candidates[0].conceptId, "retail.supermarket");
  assert.ok(resolution.candidates[0].score >= 0.35);
});

test("all 30 zero-token-overlap cases stay non-executable in the legacy resolver", async () => {
  const fixture = await loadPlannerFixture();
  for (const entry of fixture.zeroOverlapCases) {
    const intent = normalizePlannerInput(
      plannerInput(entry.query, entry.locale, entry.countryCode),
    );
    const resolution = resolveDeterministically(intent);
    assert.equal(resolution.fullCatalog, true, entry.id);
    assert.equal(resolution.method, "full_catalog", entry.id);
    assert.ok(
      CANONICAL_TAXONOMY.some((concept) => concept.id === entry.expectedConceptId),
      entry.id,
    );
  }
});

test("confirmation token rejects tampering, expiry, stale context, and unoffered selection", async () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const input = plannerInput("салон");
  const fixture = await loadPlannerFixture();
  const mock = createGoldenKimiClient(fixture);
  const plan = await createSearchPlan(input, {
    mode: "kimi",
    kimiClient: mock,
    signingSecret,
    now,
  });
  assert.equal(plan.status, "needs_confirmation");
  assert.ok(plan.confirmation.token);

  const claims = await verifyConfirmationToken(plan.confirmation.token, {
    secret: signingSecret,
    now,
    expectedRequestCacheKey: plan.requestCacheKey,
    expectedTaxonomyVersion: CANONICAL_TAXONOMY_VERSION,
    expectedProviderCatalogVersion: GEOAPIFY_PROVIDER_CATALOG_VERSION,
    expectedDecisionPolicyVersion: DECISION_POLICY_VERSION,
  });
  assert.deepEqual(
    claims.allowedConceptIds,
    [...claims.allowedConceptIds].sort(),
  );

  const tampered = `${plan.confirmation.token.slice(0, -1)}${
    plan.confirmation.token.endsWith("A") ? "B" : "A"
  }`;
  await assert.rejects(
    verifyConfirmationToken(tampered, { secret: signingSecret, now }),
    (error) =>
      error instanceof ConfirmationTokenError &&
      error.code === "INVALID_CONFIRMATION_SIGNATURE",
  );
  await assert.rejects(
    verifyConfirmationToken(plan.confirmation.token, {
      secret: signingSecret,
      now: new Date("2026-08-16T12:11:00.000Z"),
    }),
    (error) =>
      error instanceof ConfirmationTokenError &&
      error.code === "EXPIRED_CONFIRMATION_TOKEN",
  );
  await assert.rejects(
    verifyConfirmationToken(plan.confirmation.token, {
      secret: signingSecret,
      now,
      expectedTaxonomyVersion: "stale-taxonomy",
    }),
    (error) =>
      error instanceof ConfirmationTokenError &&
      error.code === "CONFIRMATION_CONTEXT_MISMATCH",
  );

  const unoffered = CANONICAL_CONCEPT_IDS.find(
    (conceptId) => !claims.allowedConceptIds.includes(conceptId),
  );
  await assert.rejects(
    confirmSearchPlan(
      {
        input,
        confirmationToken: plan.confirmation.token,
        selectedConceptIds: [unoffered],
      },
      { signingSecret, now },
    ),
    /allowed by the confirmation token/i,
  );
});

test("confirmation token primitive enforces expiry independently of planner", async () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const issued = await issueConfirmationToken({
    secret: signingSecret,
    requestCacheKey: "cache-key",
    sourcePlanHash: "source-plan-hash",
    allowedConceptIds: ["logistics.fulfillment", "logistics.warehouse"],
    taxonomyVersion: CANONICAL_TAXONOMY_VERSION,
    providerCatalogVersion: GEOAPIFY_PROVIDER_CATALOG_VERSION,
    decisionPolicyVersion: DECISION_POLICY_VERSION,
    ttlSeconds: 60,
    now,
  });
  await assert.rejects(
    verifyConfirmationToken(issued.token, {
      secret: signingSecret,
      now: new Date("2026-08-16T12:01:01.000Z"),
    }),
    /expired/i,
  );
});

function kimiSseResponse({
  content,
  finishReason = "stop",
  done = true,
  model = "kimi-test-model",
  firstChunk,
} = {}) {
  const chunks = firstChunk
    ? [firstChunk]
    : [
        {
          model,
          choices: [
            {
              index: 0,
              delta: { content: content ?? "" },
              finish_reason: null,
            },
          ],
        },
        {
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
              usage: {
                prompt_tokens: 100,
                completion_tokens: 30,
                total_tokens: 130,
              },
            },
          ],
        },
      ];
  const events = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`);
  if (done) events.push("data: [DONE]\n\n");
  return new Response(events.join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}

test("Kimi client accepts a strict response and performs no hidden retry", async () => {
  let calls = 0;
  const request = kimiRequestFor("привести бороду в порядок");
  const client = createKimiClient({
    apiKey: "test-only-placeholder-key",
    model: "kimi-test-model",
    fetchImpl: async (input, init) => {
      calls += 1;
      assert.equal(new URL(String(input)).hostname, "api.moonshot.ai");
      const body = JSON.parse(String(init.body));
      // Kimi K3 currently accepts only its default temperature. Omitting the
      // field keeps the request compatible across the supported model family.
      assert.equal(Object.hasOwn(body, "temperature"), false);
      assert.equal(body.max_completion_tokens, 1200);
      assert.equal(body.stream, true);
      assert.equal(body.response_format.type, "json_schema");
      const serializedBody = JSON.stringify(body);
      assert.equal(serializedBody.includes("conceptId"), false);
      assert.equal(serializedBody.includes("candidates"), false);
      assert.equal(serializedBody.includes("personal_care.barbershop"), false);
      return kimiSseResponse({
        content: JSON.stringify(semanticIntentFor("барбершоп")),
      });
    },
  });
  const result = await client.encode(request);
  assert.equal(result.semanticIntent.coreBusinessTypes[0], "барбершоп");
  assert.deepEqual(result.usage, {
    inputTokens: 100,
    outputTokens: 30,
    totalTokens: 130,
  });
  assert.equal(calls, 1);
});

for (const fault of [
  {
    name: "429",
    fetchImpl: async () => new Response("rate limited", { status: 429 }),
    expectedCode: "KIMI_RATE_LIMITED",
    expectedRetryable: true,
  },
  {
    name: "500",
    fetchImpl: async () => new Response("failure", { status: 500 }),
    expectedCode: "KIMI_HTTP_ERROR",
    expectedRetryable: true,
  },
  {
    name: "401 authentication failure",
    fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    expectedCode: "KIMI_AUTH_ERROR",
    expectedRetryable: false,
  },
  {
    name: "malformed SSE JSON",
    fetchImpl: async () =>
      new Response("data: not-json\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    expectedCode: "KIMI_INVALID_RESPONSE",
    expectedRetryable: true,
  },
  {
    name: "truncated structured output",
    fetchImpl: async () =>
      kimiSseResponse({ content: "{\"schemaVersion\":" }),
    expectedCode: "KIMI_INVALID_RESPONSE",
    expectedRetryable: true,
  },
  {
    name: "stream without DONE",
    fetchImpl: async () =>
      kimiSseResponse({
        content: JSON.stringify(
          semanticIntentFor("барбершоп"),
        ),
        done: false,
      }),
    expectedCode: "KIMI_INVALID_RESPONSE",
    expectedRetryable: true,
  },
  {
    name: "length finish reason",
    fetchImpl: async () =>
      kimiSseResponse({
        content: JSON.stringify(
          semanticIntentFor("барбершоп"),
        ),
        finishReason: "length",
      }),
    expectedCode: "KIMI_INVALID_RESPONSE",
    expectedRetryable: true,
  },
  {
    name: "empty choices",
    fetchImpl: async () =>
      kimiSseResponse({ firstChunk: { choices: [] } }),
    expectedCode: "KIMI_INVALID_RESPONSE",
    expectedRetryable: true,
  },
  {
    name: "structured output with an extra property",
    fetchImpl: async () =>
      kimiSseResponse({
        content: JSON.stringify({
          ...semanticIntentFor("барбершоп"),
          providerUrl: "https://evil.invalid",
        }),
      }),
    expectedCode: "KIMI_INVALID_RESPONSE",
    expectedRetryable: true,
  },
  {
    name: "executable URL in an open-vocabulary field",
    query: "супермаркетт",
    fetchImpl: async () =>
      kimiSseResponse({
        content: JSON.stringify(semanticIntentFor("https://evil.invalid")),
      }),
    expectedCode: "KIMI_INVALID_RESPONSE",
    expectedRetryable: true,
  },
  {
    name: "inconsistent ambiguity fields",
    fetchImpl: async () =>
      kimiSseResponse({
        content: JSON.stringify({
          ...semanticIntentFor("склад"),
          ambiguity: {
            isAmbiguous: false,
            reason: "Есть разные трактовки",
            clarificationQuestion: null,
          },
        }),
      }),
    expectedCode: "KIMI_INVALID_RESPONSE",
    expectedRetryable: true,
  },
]) {
  test(`Kimi client safely rejects ${fault.name}`, async () => {
    let calls = 0;
    const client = createKimiClient({
      apiKey: "test-only-placeholder-key",
      model: "kimi-test-model",
      fetchImpl: async (...args) => {
        calls += 1;
        return fault.fetchImpl(...args);
      },
    });
    await assert.rejects(
      client.encode(
        kimiRequestFor(fault.query ?? "привести бороду в порядок"),
      ),
      (error) =>
        error instanceof KimiClientError &&
        error.code === fault.expectedCode &&
        error.retryable === fault.expectedRetryable,
    );
    assert.equal(calls, 1);
  });
}

test("Kimi client turns its bounded timeout into KIMI_TIMEOUT", async () => {
  const client = createKimiClient({
    apiKey: "test-only-placeholder-key",
    timeoutMs: 5,
    fetchImpl: async (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("mock timeout", "AbortError")),
          { once: true },
        );
      }),
  });
  await assert.rejects(
    client.encode(kimiRequestFor("привести бороду в порядок")),
    (error) => error instanceof KimiClientError && error.code === "KIMI_TIMEOUT",
  );
});

test("Kimi timeout remains active until the SSE terminal marker", async () => {
  const encoder = new TextEncoder();
  const client = createKimiClient({
    apiKey: "test-only-placeholder-key",
    timeoutMs: 10,
    fetchImpl: async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [
                    {
                      index: 0,
                      delta: { content: "{\"status\"" },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              ),
            );
            init.signal.addEventListener(
              "abort",
              () => controller.error(new DOMException("mock timeout", "AbortError")),
              { once: true },
            );
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  await assert.rejects(
    client.encode(kimiRequestFor("привести бороду в порядок")),
    (error) => error instanceof KimiClientError && error.code === "KIMI_TIMEOUT",
  );
});

test("Kimi client propagates caller cancellation without dispatching fetch", async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const client = createKimiClient({
    apiKey: "test-only-placeholder-key",
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    },
  });
  await assert.rejects(
    client.encode({
      ...kimiRequestFor("привести бороду в порядок"),
      signal: controller.signal,
    }),
    (error) => error instanceof KimiClientError && error.code === "KIMI_ABORTED",
  );
  assert.equal(calls, 0);
});

test("Kimi client rejects unofficial base URLs before network access", () => {
  assert.throws(
    () =>
      createKimiClient({
        apiKey: "test-only-placeholder-key",
        baseUrl: "https://evil.invalid/v1",
      }),
    (error) =>
      error instanceof KimiClientError &&
      error.code === "KIMI_CONFIGURATION_ERROR",
  );
});

test("Kimi models canary rejects a malformed provider response", async () => {
  const client = createKimiClient({
    apiKey: "test-only-placeholder-key",
    fetchImpl: async () => Response.json({ models: [] }),
  });
  await assert.rejects(
    client.listModels(),
    (error) =>
      error instanceof KimiClientError && error.code === "KIMI_INVALID_RESPONSE",
  );
});

test("planner turns Kimi failure into a safe non-executable semantic outcome", async () => {
  const fixture = await loadPlannerFixture();
  const zeroOverlap = fixture.zeroOverlapCases[0];
  const failingClient = {
    modelId: "mock-kimi-failure",
    async encode() {
      throw new KimiClientError("KIMI_RATE_LIMITED", "mock 429", {
        status: 429,
        retryable: true,
      });
    },
  };
  const plan = await createSearchPlan(plannerInput(zeroOverlap.query), {
    mode: "kimi",
    kimiClient: failingClient,
  });
  assert.ok(
    plan.status === "needs_confirmation" || plan.status === "unsupported",
  );
  assert.deepEqual(plan.resolution.selectedConceptIds, []);
  assert.equal(plan.executionPreview, null);
});

test("ambiguous warehouse intent never becomes executable before confirmation", async () => {
  const fixture = await loadPlannerFixture();
  const mock = createGoldenKimiClient(fixture);
  const plan = await createSearchPlan(plannerInput("склад"), {
    mode: "kimi",
    kimiClient: mock,
    signingSecret,
    now: new Date("2026-08-16T12:00:00.000Z"),
  });
  assert.equal(plan.status, "needs_confirmation");
  assert.deepEqual(plan.resolution.selectedConceptIds, []);
  assert.equal(plan.executionPreview, null);
});

test("open ambiguity without legacy options remains honest and editable", async () => {
  const client = {
    modelId: "mock-open-ambiguity",
    async encode() {
      return {
        semanticIntent: {
          ...semanticIntentFor("абракадабра зюзя"),
          confidence: "medium",
          ambiguity: {
            isAmbiguous: true,
            reason: "Это может быть площадка для мероприятий или мастерская",
            clarificationQuestion: "Вам нужна площадка или мастерская?",
          },
        },
        modelId: this.modelId,
        finishReason: "stop",
        latencyMs: 1,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    },
  };
  const plan = await createSearchPlan(plannerInput("абракадабра зюзя"), {
    mode: "kimi",
    kimiClient: client,
    signingSecret,
  });
  assert.equal(plan.status, "needs_confirmation");
  assert.deepEqual(plan.resolution.alternatives, []);
  assert.equal(plan.confirmation.token, null);
  assert.match(plan.semanticIntent.ambiguity.reason, /площадка/);
  assert.match(plan.resolution.clarificationQuestion, /площадка/);
});

test("open sports intent becomes executable without a legacy canonical concept", async () => {
  const client = {
    modelId: "mock-open-sports",
    async encode() {
      return {
        semanticIntent: {
          ...semanticIntentFor("sports hall"),
          industries: ["sport", "fitness"],
          coreBusinessTypes: ["sports hall", "gym", "fitness centre"],
          adjacentBusinessTypes: ["sport club"],
          retrievalTerms: {
            precision: ["sports hall", "gym", "fitness centre"],
            recall: ["fitness", "sport club"],
            exclude: ["sporting goods store"],
          },
        },
        modelId: this.modelId,
        finishReason: "stop",
        latencyMs: 1,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    },
  };
  const plan = await createSearchPlan(plannerInput("Спортивный зал"), {
    mode: "kimi",
    kimiClient: client,
  });
  assert.equal(plan.status, "ready");
  assert.deepEqual(plan.resolution.selectedConceptIds, []);
  assert.equal(plan.confidence.providerCoverage, "high");
  assert.ok(plan.executionPreview.categoryLabels.includes("sport.sports_hall"));
  assert.ok(plan.executionPreview.categoryLabels.includes("sport.fitness.gym"));
  assert.equal(
    plan.executionPreview.categoryLabels.includes("catering.restaurant"),
    false,
  );
});

test("semantic compatibility never executes a conflicting original category", async () => {
  const client = {
    modelId: "mock-conflicting-meaning",
    async encode() {
      return {
        semanticIntent: semanticIntentFor("студия ухода за редкими растениями"),
        modelId: this.modelId,
        finishReason: "stop",
        latencyMs: 1,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    },
  };
  const plan = await createSearchPlan(plannerInput("Аптека"), {
    mode: "kimi",
    kimiClient: client,
  });
  assert.equal(plan.status, "unsupported");
  assert.deepEqual(plan.resolution.selectedConceptIds, []);
  assert.deepEqual(plan.resolution.reasonCodes, ["PROVIDER_COVERAGE_GAP"]);
  assert.equal(plan.executionPreview, null);
});

test("bounded semantic arrays cannot overflow legacy compatibility input", async () => {
  const terms = Array.from({ length: 16 }, (_, index) => `смежный формат ${index}`);
  const client = {
    modelId: "mock-bounded-open-intent",
    async encode() {
      return {
        semanticIntent: {
          ...semanticIntentFor("барбершоп"),
          adjacentBusinessTypes: terms,
          productsAndServices: terms.map((term) => `услуга ${term}`),
          retrievalTerms: {
            precision: ["барбершоп", "hairdresser"],
            recall: ["barbershop", ...terms.map((term) => `синоним ${term}`)],
            exclude: [],
          },
        },
        modelId: this.modelId,
        finishReason: "stop",
        latencyMs: 1,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    },
  };
  const plan = await createSearchPlan(plannerInput("место для ухода за бородой"), {
    mode: "kimi",
    kimiClient: client,
  });
  assert.equal(plan.status, "ready");
  assert.equal(plan.ai.validation, "passed");
  assert.deepEqual(plan.resolution.selectedConceptIds, ["personal_care.barbershop"]);
});

test("generic warehouse policy overrides an overconfident Kimi selection", async () => {
  const overconfidentClient = {
    modelId: "mock-overconfident-kimi",
    async encode() {
      return {
        semanticIntent: {
          ...semanticIntentFor("склад"),
          confidence: "high",
          ambiguity: {
            isAmbiguous: false,
            reason: null,
            clarificationQuestion: null,
          },
        },
        modelId: "mock-overconfident-kimi",
        finishReason: "stop",
        latencyMs: 1,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };
    },
  };
  const plan = await createSearchPlan(plannerInput("склад"), {
    mode: "kimi",
    kimiClient: overconfidentClient,
    signingSecret,
    now: new Date("2026-08-16T12:00:00.000Z"),
  });
  assert.equal(plan.status, "needs_confirmation");
  assert.deepEqual(plan.resolution.selectedConceptIds, []);
  assert.deepEqual(
    plan.resolution.alternatives.map((alternative) => alternative.conceptId),
    ["logistics.warehouse", "logistics.fulfillment"],
  );
  assert.equal(plan.executionPreview, null);
  assert.ok(plan.confirmation.token);
});
