import assert from "node:assert/strict";
import test from "node:test";

import {
  GEOAPIFY_CATEGORY_IDS,
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
  buildKimiCandidates,
  lexicalSimilarity,
  normalizePlannerInput,
  normalizeSearchText,
  resolveDeterministically,
} from "../lib/search-planner/resolver.ts";
import {
  assertSchemaTaxonomyParity,
  createKimiResolutionSchema,
  validateKimiResolution,
} from "../lib/search-planner/schema.ts";
import {
  CANONICAL_CONCEPT_IDS,
  CANONICAL_TAXONOMY,
  CANONICAL_TAXONOMY_VERSION,
} from "../lib/search-planner/taxonomy.ts";
import { GEOAPIFY_PROVIDER_CATALOG_VERSION } from "../lib/search-planner/catalogs/geoapify.ts";

import { createGoldenKimiClient } from "./helpers/golden-kimi-client.mjs";
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

function selectedResolution(conceptId) {
  return {
    status: "selected",
    selectedConceptIds: [conceptId],
    alternatives: [],
    confidenceBand: "high",
    clarificationReasonCode: null,
  };
}

function kimiRequestFor(query) {
  const intent = normalizePlannerInput(plannerInput(query));
  const deterministic = resolveDeterministically(intent);
  return {
    intent,
    candidates: buildKimiCandidates(deterministic, intent.locale),
    candidateMode: deterministic.fullCatalog ? "full_catalog" : "shortlist",
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

test("Kimi schema is strict, taxonomy-bound, and candidate-narrowed", () => {
  assert.doesNotThrow(() => assertSchemaTaxonomyParity());
  const allowed = ["personal_care.barbershop", "personal_care.beauty_salon"];
  const schema = createKimiResolutionSchema(allowed);
  assert.deepEqual(schema.definitions.conceptId.enum, allowed);
  assert.deepEqual(
    validateKimiResolution(selectedResolution(allowed[0]), allowed),
    selectedResolution(allowed[0]),
  );
  assert.throws(
    () =>
      validateKimiResolution(
        selectedResolution("automotive.fuel_station"),
        allowed,
      ),
    /outside the supplied candidate set/i,
  );
  assert.throws(
    () =>
      validateKimiResolution(
        { ...selectedResolution(allowed[0]), providerUrl: "https://evil.invalid" },
        allowed,
      ),
    /additional properties/i,
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

test("all 30 zero-token-overlap cases take the complete compact catalog path", async () => {
  const fixture = await loadPlannerFixture();
  for (const entry of fixture.zeroOverlapCases) {
    const intent = normalizePlannerInput(
      plannerInput(entry.query, entry.locale, entry.countryCode),
    );
    const resolution = resolveDeterministically(intent);
    assert.equal(resolution.fullCatalog, true, entry.id);
    assert.equal(resolution.method, "full_catalog", entry.id);
    const candidates = buildKimiCandidates(resolution, entry.locale);
    assert.equal(candidates.length, CANONICAL_TAXONOMY.length, entry.id);
    assert.ok(
      candidates.some(
        (candidate) => candidate.conceptId === entry.expectedConceptId,
      ),
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
      assert.equal(body.max_completion_tokens, 300);
      assert.equal(body.stream, true);
      assert.equal(body.response_format.type, "json_schema");
      assert.deepEqual(
        body.response_format.json_schema.schema.definitions.conceptId.enum,
        request.candidates.map((candidate) => candidate.conceptId),
      );
      return kimiSseResponse({
        content: JSON.stringify(
          selectedResolution("personal_care.barbershop"),
        ),
      });
    },
  });
  const result = await client.resolve(request);
  assert.equal(result.resolution.selectedConceptIds[0], "personal_care.barbershop");
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
  },
  {
    name: "500",
    fetchImpl: async () => new Response("failure", { status: 500 }),
    expectedCode: "KIMI_HTTP_ERROR",
  },
  {
    name: "401 authentication failure",
    fetchImpl: async () => new Response("unauthorized", { status: 401 }),
    expectedCode: "KIMI_AUTH_ERROR",
  },
  {
    name: "malformed SSE JSON",
    fetchImpl: async () =>
      new Response("data: not-json\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    expectedCode: "KIMI_INVALID_RESPONSE",
  },
  {
    name: "truncated structured output",
    fetchImpl: async () =>
      kimiSseResponse({ content: "{\"status\":" }),
    expectedCode: "KIMI_INVALID_RESPONSE",
  },
  {
    name: "stream without DONE",
    fetchImpl: async () =>
      kimiSseResponse({
        content: JSON.stringify(
          selectedResolution("personal_care.barbershop"),
        ),
        done: false,
      }),
    expectedCode: "KIMI_INVALID_RESPONSE",
  },
  {
    name: "length finish reason",
    fetchImpl: async () =>
      kimiSseResponse({
        content: JSON.stringify(
          selectedResolution("personal_care.barbershop"),
        ),
        finishReason: "length",
      }),
    expectedCode: "KIMI_INVALID_RESPONSE",
  },
  {
    name: "empty choices",
    fetchImpl: async () =>
      kimiSseResponse({ firstChunk: { choices: [] } }),
    expectedCode: "KIMI_INVALID_RESPONSE",
  },
  {
    name: "structured output with an extra property",
    fetchImpl: async () =>
      kimiSseResponse({
        content: JSON.stringify({
          ...selectedResolution("personal_care.barbershop"),
          providerUrl: "https://evil.invalid",
        }),
      }),
    expectedCode: "KIMI_INVALID_RESPONSE",
  },
  {
    name: "out-of-candidate concept",
    query: "супермаркетт",
    fetchImpl: async () =>
      kimiSseResponse({
        content: JSON.stringify(
          selectedResolution("automotive.fuel_station"),
        ),
      }),
    expectedCode: "KIMI_INVALID_RESPONSE",
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
      client.resolve(
        kimiRequestFor(fault.query ?? "привести бороду в порядок"),
      ),
      (error) =>
        error instanceof KimiClientError && error.code === fault.expectedCode,
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
    client.resolve(kimiRequestFor("привести бороду в порядок")),
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
    client.resolve(kimiRequestFor("привести бороду в порядок")),
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
    client.resolve({
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
    async resolve() {
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

test("generic warehouse policy overrides an overconfident Kimi selection", async () => {
  const overconfidentClient = {
    modelId: "mock-overconfident-kimi",
    async resolve() {
      return {
        resolution: selectedResolution("logistics.warehouse"),
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
