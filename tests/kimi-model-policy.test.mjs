import assert from "node:assert/strict";
import test from "node:test";

import {
  KIMI_MODEL_POLICY_VERSION,
  KimiClientError,
  createKimiClient,
  createKimiClientFromEnv,
  kimiClientConfigFromEnv,
} from "../lib/search-planner/kimi-client.ts";
import {
  KIMI_PROMPT_VERSION,
  clearSearchPlanRuntimeCache,
  confirmSearchPlan,
  createSearchPlan,
  createSearchPlanFromEnv,
} from "../lib/search-planner/planner.ts";
import { compileGeoapifySemanticIntent } from "../lib/search-planner/catalogs/geoapify.ts";
import { validateKimiSemanticIntent } from "../lib/search-planner/schema.ts";

const apiKey = "test-only-placeholder-key";

function semanticIntentFor(businessType = "sports hall") {
  return {
    schemaVersion: "2.2",
    normalizedGoal: `find ${businessType}`,
    entityKind: "physical_business",
    physicalLocationRequirement: "required",
    industries: ["sport"],
    coreBusinessTypes: [businessType],
    adjacentBusinessTypes: [],
    excludedBusinessTypes: [],
    productsAndServices: [],
    includeSignals: [businessType],
    excludeSignals: [],
    retrievalTerms: {
      precision: [businessType],
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

function kimiRequest() {
  return {
    intent: {
      description: "",
      primaryQuery: "современный спортивный зал",
      relatedQueries: [],
      excludeQueries: [],
      locale: "ru-RU",
      countryCodes: ["RU"],
    },
  };
}

function kimiWireIntent(
  semanticIntent = semanticIntentFor(),
  providerNeutralCategoryHeads,
) {
  const nonExecutable =
    semanticIntent.ambiguity?.isAmbiguous === true ||
    semanticIntent.entityKind === "non_physical";
  const heads =
    providerNeutralCategoryHeads ??
    (nonExecutable
      ? []
      : [semanticIntent.retrievalTerms?.precision?.[0] ?? "business"]);
  return {
    ...semanticIntent,
    providerNeutralCategoryHeads: heads,
  };
}

function kimiSseValueResponse(model, value) {
  const content = JSON.stringify(value);
  return new Response(
    [
      `data: ${JSON.stringify({
        model,
        choices: [
          { index: 0, delta: { content }, finish_reason: null },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
            usage: {
              prompt_tokens: 100,
              cached_tokens: 20,
              completion_tokens: 30,
              total_tokens: 130,
            },
          },
        ],
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    },
  );
}

function kimiSseResponse(
  model,
  semanticIntent = semanticIntentFor(),
  providerNeutralCategoryHeads,
) {
  return kimiSseValueResponse(
    model,
    kimiWireIntent(semanticIntent, providerNeutralCategoryHeads),
  );
}

async function capturedPayload(config) {
  let payload = null;
  const client = createKimiClient({
    apiKey,
    ...config,
    fetchImpl: async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return kimiSseResponse(config.model);
    },
  });
  const result = await client.encode(kimiRequest());
  return { client, payload, result };
}

test("K3 request uses only its server-owned reasoning effort policy", async () => {
  const { client, payload, result } = await capturedPayload({
    model: "kimi-k3",
    reasoningEffort: "low",
  });

  assert.equal(KIMI_MODEL_POLICY_VERSION, "kimi-model-policy/2026-08-20.6");
  assert.equal(payload.reasoning_effort, "low");
  assert.equal(Object.hasOwn(payload, "thinking"), false);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  assert.match(payload.messages[0].content, /at most 8 coreBusinessTypes/);
  assert.match(payload.messages[0].content, /without an explicit physical business/);
  assert.match(payload.messages[0].content, /shortest unambiguous English head phrase/);
  assert.match(payload.messages[0].content, /providerNeutralCategoryHeads/);
  assert.match(payload.messages[0].content, /only then evaluate business-type ambiguity/);
  assert.match(payload.messages[0].content, /do not enumerate interpretations in positive arrays/);
  assert.equal(result.usage.cachedInputTokens, 20);
  assert.ok(
    Number.isInteger(result.firstSseEventLatencyMs) &&
      result.firstSseEventLatencyMs >= 0,
  );
  assert.equal(
    client.cacheIdentity,
    "kimi-model-policy/2026-08-20.6:kimi-k3:k3-reasoning:low",
  );
});

test("Kimi request uses an MFJS transport schema without weakening local validation", async () => {
  const { payload } = await capturedPayload({
    model: "kimi-k3",
    reasoningEffort: "low",
  });
  const transportSchema = payload.response_format.json_schema.schema;
  const forbiddenKeywords = new Set([
    "$schema",
    "$id",
    "title",
    "definitions",
    "const",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "uniqueItems",
  ]);
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeywords.has(key), false, key);
      visit(child);
    }
  };

  visit(transportSchema);
  assert.deepEqual(
    transportSchema.properties.schemaVersion,
    { type: "string", enum: ["2.2"] },
  );
  assert.ok(transportSchema.required.includes("providerNeutralCategoryHeads"));
  assert.deepEqual(transportSchema.properties.providerNeutralCategoryHeads, {
    type: "array",
    items: { type: "string" },
  });
  assert.throws(
    () =>
      validateKimiSemanticIntent({
        ...semanticIntentFor(),
        coreBusinessTypes: [],
      }),
    /failed validation/i,
  );
});

test("Kimi wire category heads become bounded precision semantics without leaking the wire field", async () => {
  const semanticIntent = {
    ...semanticIntentFor("indoor rock wall venue"),
    coreBusinessTypes: ["indoor rock wall venue"],
    retrievalTerms: {
      precision: ["indoor rock wall venue"],
      recall: [],
      exclude: [],
    },
  };
  const client = createKimiClient({
    apiKey,
    model: "kimi-k3",
    reasoningEffort: "low",
    fetchImpl: async () =>
      kimiSseResponse("kimi-k3", semanticIntent, [" climbing ", "CLIMBING"]),
  });

  const result = await client.encode(kimiRequest());
  assert.deepEqual(result.semanticIntent.retrievalTerms.precision, [
    "climbing",
    "indoor rock wall venue",
  ]);
  assert.equal(
    Object.hasOwn(result.semanticIntent, "providerNeutralCategoryHeads"),
    false,
  );
  assert.ok(
    compileGeoapifySemanticIntent(result.semanticIntent).categoryIds.includes(
      "entertainment.activity_park.climbing",
    ),
  );

  const planClient = createKimiClient({
    apiKey,
    model: "kimi-k3",
    reasoningEffort: "low",
    fetchImpl: async () =>
      kimiSseResponse("kimi-k3", semanticIntent, ["climbing"]),
  });
  const plan = await createSearchPlan(
    { primaryQuery: "крытый зал со стенами для лазания" },
    { mode: "kimi", kimiClient: planClient },
  );
  assert.equal(plan.status, "ready");
  assert.ok(
    plan.executionPreview?.retrievalArms.some(
      (arm) =>
        arm.type === "precision" &&
        arm.provenance.some(
          (item) =>
            item.semanticTerm === "climbing" && item.match === "exact_leaf",
        ),
    ),
  );
  assert.equal(JSON.stringify(plan).includes("providerNeutralCategoryHeads"), false);
});

test("an unresolved, parent, or colliding wire head cannot be laundered through fallback", async () => {
  const semanticIntent = {
    ...semanticIntentFor("unfindable artisan destination"),
    coreBusinessTypes: ["unfindable artisan destination"],
    retrievalTerms: {
      precision: ["unfindable artisan destination"],
      recall: [],
      exclude: [],
    },
  };
  for (const head of ["unfindable trade", "sport fitness", "spa"]) {
    const client = createKimiClient({
      apiKey,
      model: "kimi-k3",
      fetchImpl: async () =>
        kimiSseResponse("kimi-k3", semanticIntent, [head]),
    });

    const plan = await createSearchPlan(
      { primaryQuery: "qzxv место неизвестного ремесла" },
      { mode: "kimi", kimiClient: client },
    );

    assert.equal(plan.status, "unsupported", head);
    assert.equal(plan.executionPreview, null, head);
    assert.equal(plan.confidence.providerCoverage, "unknown", head);
    assert.deepEqual(
      plan.resolution.reasonCodes,
      ["PROVIDER_COVERAGE_GAP"],
      head,
    );
  }

  const legacySemanticIntent = {
    ...semanticIntentFor("парикмахерская"),
    coreBusinessTypes: ["парикмахерская"],
    retrievalTerms: {
      precision: ["unfindable trade"],
      recall: [],
      exclude: [],
    },
  };
  const legacyClient = createKimiClient({
    apiKey,
    model: "kimi-k3",
    fetchImpl: async () =>
      kimiSseResponse("kimi-k3", legacySemanticIntent, ["unfindable trade"]),
  });
  const legacyPlan = await createSearchPlan(
    { primaryQuery: "qzxv неизвестная услуга" },
    { mode: "kimi", kimiClient: legacyClient },
  );
  assert.equal(legacyPlan.status, "unsupported");
  assert.equal(legacyPlan.executionPreview, null);
});

test("Kimi wire category heads fail closed without truncation or executable syntax", async () => {
  const cases = [
    {
      label: "missing",
      value: semanticIntentFor(),
      issueCode: "required_field_missing",
    },
    {
      label: "empty executable",
      value: kimiWireIntent(semanticIntentFor(), []),
      issueCode: "executable_heads_missing",
    },
    {
      label: "overflow",
      value: kimiWireIntent(semanticIntentFor(), [
        "sports hall",
        "fitness centre",
        "gymnasium",
        "athletics centre",
        "training facility",
      ]),
      issueCode: "array_max_provider_neutral_category_heads",
    },
    {
      label: "raw duplicate overflow",
      value: kimiWireIntent(semanticIntentFor(), [
        "sports hall",
        " SPORTS HALL ",
        "sports  hall",
        "Sports Hall",
        "SPORTS HALL",
      ]),
      issueCode: "array_max_provider_neutral_category_heads",
    },
    {
      label: "provider category ID",
      value: kimiWireIntent(semanticIntentFor(), ["sport.fitness.gym"]),
      issueCode: "executable_value_forbidden",
    },
    {
      label: "underscored provider syntax",
      value: kimiWireIntent(semanticIntentFor(), ["sports_hall"]),
      issueCode: "category_head_invalid",
    },
    {
      label: "punctuation-wrapped provider ID in precision",
      value: kimiWireIntent(
        {
          ...semanticIntentFor(),
          retrievalTerms: {
            precision: ["(sport.fitness.gym)"],
            recall: [],
            exclude: [],
          },
        },
        ["sports hall"],
      ),
      issueCode: "executable_value_forbidden",
    },
    ...[
      "[sport.fitness.gym]",
      "'sport.fitness.gym'",
      "sport.fitness.gym,",
      "sport.fitness.gym;",
    ].map((precisionTerm) => ({
      label: `provider ID boundary ${precisionTerm}`,
      value: kimiWireIntent(
        {
          ...semanticIntentFor(),
          retrievalTerms: {
            precision: [precisionTerm],
            recall: [],
            exclude: [],
          },
        },
        ["sports hall"],
      ),
      issueCode: "executable_value_forbidden",
    })),
  ];

  for (const item of cases) {
    const client = createKimiClient({
      apiKey,
      model: "kimi-k3",
      reasoningEffort: "low",
      fetchImpl: async () => kimiSseValueResponse("kimi-k3", item.value),
    });
    await assert.rejects(
      client.encode(kimiRequest()),
      (error) =>
        error instanceof KimiClientError &&
        error.reason === "semantic_schema_invalid" &&
        error.semanticValidationIssueCodes.includes(item.issueCode),
      item.label,
    );
  }
});

test("Kimi wire forbids category heads for ambiguous and non-physical outcomes", async () => {
  const ambiguous = {
    ...semanticIntentFor(),
    coreBusinessTypes: [],
    industries: [],
    includeSignals: [],
    retrievalTerms: { precision: [], recall: [], exclude: [] },
    ambiguity: {
      isAmbiguous: true,
      reason: "Several physical interpretations remain",
      clarificationQuestion: "Which physical business do you mean?",
    },
  };
  const nonPhysical = {
    ...semanticIntentFor(),
    entityKind: "non_physical",
    physicalLocationRequirement: "not_applicable",
    coreBusinessTypes: [],
    industries: [],
    includeSignals: [],
    retrievalTerms: { precision: [], recall: [], exclude: [] },
  };

  for (const semanticIntent of [ambiguous, nonPhysical]) {
    const accepted = createKimiClient({
      apiKey,
      model: "kimi-k3",
      fetchImpl: async () => kimiSseResponse("kimi-k3", semanticIntent, []),
    });
    assert.deepEqual(
      (await accepted.encode(kimiRequest())).semanticIntent.retrievalTerms
        .precision,
      [],
    );

    const rejected = createKimiClient({
      apiKey,
      model: "kimi-k3",
      fetchImpl: async () =>
        kimiSseResponse("kimi-k3", semanticIntent, ["sports hall"]),
    });
    await assert.rejects(
      rejected.encode(kimiRequest()),
      (error) =>
        error instanceof KimiClientError &&
        error.semanticValidationIssueCodes.includes("nonready_heads_present"),
    );

    const positiveTerms = createKimiClient({
      apiKey,
      model: "kimi-k3",
      fetchImpl: async () =>
        kimiSseResponse(
          "kimi-k3",
          {
            ...semanticIntent,
            coreBusinessTypes: ["sports hall"],
            retrievalTerms: {
              ...semanticIntent.retrievalTerms,
              precision: ["sports hall"],
            },
          },
          [],
        ),
    });
    await assert.rejects(
      positiveTerms.encode(kimiRequest()),
      (error) =>
        error instanceof KimiClientError &&
        error.semanticValidationIssueCodes.includes("nonready_terms_present"),
    );
  }
});

test("an unclear entity cannot become executable without clarification", async () => {
  const unclear = {
    ...semanticIntentFor("climbing"),
    entityKind: "unclear",
    confidence: "low",
  };
  assert.throws(
    () => validateKimiSemanticIntent(unclear),
    /unclear intent must be marked ambiguous/i,
  );

  for (const heads of [[], ["climbing"]]) {
    const client = createKimiClient({
      apiKey,
      model: "kimi-k3",
      fetchImpl: async () => kimiSseResponse("kimi-k3", unclear, heads),
    });
    await assert.rejects(
      client.encode(kimiRequest()),
      (error) =>
        error instanceof KimiClientError &&
        error.reason === "semantic_schema_invalid" &&
        error.semanticValidationIssueCodes.some((code) =>
          ["unclear_intent_invariant", "nonready_heads_present"].includes(code),
        ),
    );
  }
});

test("Kimi wire precision and category-head bounds compose to the public limit", async () => {
  const precision = Array.from({ length: 8 }, (_, index) => `precision ${index}`);
  const semanticIntent = {
    ...semanticIntentFor(),
    retrievalTerms: { precision, recall: [], exclude: [] },
  };
  const client = createKimiClient({
    apiKey,
    model: "kimi-k3",
    fetchImpl: async () =>
      kimiSseResponse("kimi-k3", semanticIntent, [
        "sports hall",
        "fitness centre",
        "gymnasium",
        "athletics centre",
      ]),
  });
  const result = await client.encode(kimiRequest());
  assert.equal(result.semanticIntent.retrievalTerms.precision.length, 12);

  for (const overflowPrecision of [
    [...precision, "precision 8"],
    Array.from({ length: 9 }, (_, index) =>
      index % 2 ? " SAME TERM " : "same term",
    ),
  ]) {
    const overflow = {
      ...semanticIntent,
      retrievalTerms: {
        ...semanticIntent.retrievalTerms,
        precision: overflowPrecision,
      },
    };
    const rejected = createKimiClient({
      apiKey,
      model: "kimi-k3",
      fetchImpl: async () =>
        kimiSseResponse("kimi-k3", overflow, ["sports hall"]),
    });
    await assert.rejects(
      rejected.encode(kimiRequest()),
      (error) =>
        error instanceof KimiClientError &&
        error.semanticValidationIssueCodes.includes(
          "array_max_retrieval_precision",
        ),
    );
  }
});

test("terminal usage-only SSE chunks are accepted and retained", async () => {
  const content = JSON.stringify(kimiWireIntent());
  const client = createKimiClient({
    apiKey,
    model: "kimi-k3",
    fetchImpl: async () =>
      new Response(
        [
          `data: ${JSON.stringify({
            model: "kimi-k3",
            choices: [
              { index: 0, delta: { content }, finish_reason: null },
              { index: 0, delta: {}, finish_reason: "stop" },
            ],
          })}\n\n`,
          `data: ${JSON.stringify({
            model: "kimi-k3",
            usage: {
              prompt_tokens: 111,
              completion_tokens: 22,
              total_tokens: 133,
            },
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
  });

  const result = await client.encode(kimiRequest());

  assert.deepEqual(result.usage, {
    inputTokens: 111,
    cachedInputTokens: null,
    outputTokens: 22,
    totalTokens: 133,
  });
});

test("SSE reader cancels immediately after DONE without waiting for close", async () => {
  const content = JSON.stringify(kimiWireIntent());
  let cancelled = false;
  const responseBody = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          [
            `data: ${JSON.stringify({
              model: "kimi-k3",
              choices: [
                { index: 0, delta: { content }, finish_reason: "stop" },
              ],
            })}\n\n`,
            "data: [DONE]\n\n",
          ].join(""),
        ),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = createKimiClient({
    apiKey,
    model: "kimi-k3",
    timeoutMs: 100,
    fetchImpl: async () =>
      new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
  });

  const result = await client.encode(kimiRequest());

  assert.equal(result.finishReason, "stop");
  assert.equal(cancelled, true);
});

test("SSE reader cancels an invalid stream before DONE", async () => {
  let cancelled = false;
  const responseBody = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ model: "kimi-k3" })}\n\n`,
        ),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = createKimiClient({
    apiKey,
    model: "kimi-k3",
    timeoutMs: 100,
    fetchImpl: async () =>
      new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
  });

  await assert.rejects(
    client.encode(kimiRequest()),
    (error) =>
      error instanceof KimiClientError &&
      error.code === "KIMI_INVALID_RESPONSE" &&
      error.reason === "sse_missing_choices",
  );
  assert.equal(cancelled, true);
});

test("Kimi cancels a streaming HTTP error body before rejecting", async () => {
  let cancelled = false;
  const responseBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("rate limited"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = createKimiClient({
    apiKey,
    model: "kimi-k3",
    fetchImpl: async () =>
      new Response(responseBody, {
        status: 429,
        headers: { "Content-Type": "text/event-stream" },
      }),
  });

  await assert.rejects(
    client.encode(kimiRequest()),
    (error) =>
      error instanceof KimiClientError && error.code === "KIMI_RATE_LIMITED",
  );
  assert.equal(cancelled, true);
});

test("models canary cancels a streaming HTTP error body before rejecting", async () => {
  let cancelled = false;
  const responseBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("rate limited"));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = createKimiClient({
    apiKey,
    model: "kimi-k3",
    fetchImpl: async () =>
      new Response(responseBody, {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
  });

  await assert.rejects(
    client.listModels(),
    (error) =>
      error instanceof KimiClientError && error.code === "KIMI_RATE_LIMITED",
  );
  assert.equal(cancelled, true);
});

test("K2.6 request disables thinking without a K3-only field", async () => {
  const { client, payload } = await capturedPayload({ model: "kimi-k2.6" });

  assert.deepEqual(payload.thinking, { type: "disabled" });
  assert.equal(Object.hasOwn(payload, "reasoning_effort"), false);
  assert.deepEqual(payload.response_format, { type: "json_object" });
  assert.match(payload.messages[0].content, /schemaVersion/);
  assert.match(payload.messages[0].content, /providerNeutralCategoryHeads/);
  assert.equal(
    client.cacheIdentity,
    "kimi-model-policy/2026-08-20.6:kimi-k2.6:k2.6-thinking-disabled:none",
  );
});

test("Kimi rejects a response attributed to a different model", async () => {
  const client = createKimiClient({
    apiKey,
    model: "kimi-k3",
    fetchImpl: async () => kimiSseResponse("kimi-k2.6"),
  });

  await assert.rejects(
    client.encode(kimiRequest()),
    (error) =>
      error instanceof KimiClientError &&
      error.code === "KIMI_INVALID_RESPONSE" &&
      error.reason === "response_model_mismatch" &&
      error.retryable,
  );
});

test("Kimi reports bounded local semantic-validation issue codes", async () => {
  const invalidIntent = {
    ...semanticIntentFor(),
    coreBusinessTypes: [],
  };
  const client = createKimiClient({
    apiKey,
    model: "kimi-k2.6",
    fetchImpl: async () => kimiSseResponse("kimi-k2.6", invalidIntent),
  });

  await assert.rejects(
    client.encode(kimiRequest()),
    (error) =>
      error instanceof KimiClientError &&
      error.reason === "semantic_schema_invalid" &&
      error.semanticValidationIssueCodes?.includes("executable_terms_missing") === true,
  );
});

test("Kimi canonically normalizes and deduplicates valid open semantic arrays", async () => {
  const verboseIntent = {
    ...semanticIntentFor(),
    industries: [" sport ", "SPORT", "fitness"],
    coreBusinessTypes: [" sports hall ", "SPORTS HALL", "fitness centre"],
    retrievalTerms: {
      precision: [" sports hall ", "SPORTS HALL", "fitness centre"],
      recall: [" gym ", "GYM", "fitness"],
      exclude: [],
    },
  };
  const client = createKimiClient({
    apiKey,
    model: "kimi-k2.6",
    fetchImpl: async () => kimiSseResponse("kimi-k2.6", verboseIntent),
  });

  const result = await client.encode(kimiRequest());

  assert.deepEqual(result.semanticIntent.industries, ["sport", "fitness"]);
  assert.deepEqual(
    result.semanticIntent.coreBusinessTypes,
    ["sports hall", "fitness centre"],
  );
  assert.deepEqual(
    result.semanticIntent.retrievalTerms.precision,
    ["sports hall", "fitness centre"],
  );
  assert.deepEqual(
    result.semanticIntent.retrievalTerms.recall,
    ["gym", "fitness"],
  );
});

test("Kimi rejects exclusion overflow instead of silently broadening intent", async () => {
  const overflowIntent = {
    ...semanticIntentFor(),
    excludedBusinessTypes: Array.from(
      { length: 17 },
      (_, index) => `excluded type ${index}`,
    ),
    retrievalTerms: {
      ...semanticIntentFor().retrievalTerms,
      exclude: Array.from(
        { length: 17 },
        (_, index) => `excluded term ${index}`,
      ),
    },
  };
  const client = createKimiClient({
    apiKey,
    model: "kimi-k2.6",
    fetchImpl: async () => kimiSseResponse("kimi-k2.6", overflowIntent),
  });

  await assert.rejects(
    client.encode(kimiRequest()),
    (error) =>
      error instanceof KimiClientError &&
      error.reason === "semantic_schema_invalid" &&
      error.semanticValidationIssueCodes.includes(
        "array_max_excluded_business_types",
      ) &&
      error.semanticValidationIssueCodes.includes("array_max_retrieval_exclude"),
  );
});

test("Kimi never hides an executable value beyond a semantic array bound", async () => {
  const unsafeIntent = {
    ...semanticIntentFor(),
    industries: [
      ...Array.from({ length: 16 }, (_, index) => `industry ${index}`),
      "sport.fitness.gym",
    ],
  };
  const client = createKimiClient({
    apiKey,
    model: "kimi-k2.6",
    fetchImpl: async () => kimiSseResponse("kimi-k2.6", unsafeIntent),
  });

  await assert.rejects(
    client.encode(kimiRequest()),
    (error) =>
      error instanceof KimiClientError &&
      error.reason === "semantic_schema_invalid" &&
      error.semanticValidationIssueCodes.includes("executable_value_forbidden"),
  );
});

test("non-executable semantic outcomes may omit positive retrieval terms", async () => {
  const nonPhysical = {
    ...semanticIntentFor(),
    normalizedGoal: "получить онлайн-консультацию",
    entityKind: "non_physical",
    physicalLocationRequirement: "not_applicable",
    coreBusinessTypes: [],
    includeSignals: [],
    retrievalTerms: { precision: [], recall: [], exclude: [] },
  };
  const ambiguous = {
    ...semanticIntentFor(),
    normalizedGoal: "понять, что означает площадка",
    coreBusinessTypes: [],
    includeSignals: [],
    retrievalTerms: { precision: [], recall: [], exclude: [] },
    confidence: "low",
    ambiguity: {
      isAmbiguous: true,
      reason: "Термин не определяет один физический тип бизнеса",
      clarificationQuestion: "Какой именно тип площадки нужен?",
    },
  };

  assert.deepEqual(validateKimiSemanticIntent(nonPhysical), nonPhysical);
  assert.deepEqual(validateKimiSemanticIntent(ambiguous), ambiguous);

  for (const [semanticIntent, expectedStatus] of [
    [nonPhysical, "unsupported"],
    [ambiguous, "needs_confirmation"],
  ]) {
    const plan = await createSearchPlan(
      {
        primaryQuery: "неопределённый открытый запрос",
        locale: "ru-RU",
        countryCodes: ["RU"],
      },
      {
        mode: "kimi",
        signingSecret: "test-only-signing-secret-with-safe-length",
        kimiClient: {
          modelId: "mock-safe-non-executable",
          cacheIdentity: "mock-safe-non-executable-v1",
          async encode() {
            return {
              semanticIntent,
              modelId: this.modelId,
              finishReason: "stop",
              latencyMs: 1,
              firstSseEventLatencyMs: 0,
              usage: {
                inputTokens: 10,
                cachedInputTokens: 0,
                outputTokens: 5,
                totalTokens: 15,
              },
            };
          },
        },
      },
    );
    assert.equal(plan.status, expectedStatus);
    assert.equal(plan.executionPreview, null);
  }
});

test("a physical semantic intent cannot auto-run without core and precision terms", async () => {
  const invalidPhysical = {
    ...semanticIntentFor(),
    coreBusinessTypes: [],
    includeSignals: [],
    retrievalTerms: { precision: [], recall: ["business"], exclude: [] },
  };
  assert.throws(
    () => validateKimiSemanticIntent(invalidPhysical),
    /requires coreBusinessTypes and precision retrieval terms/i,
  );

  const plan = await createSearchPlan(
    {
      primaryQuery: "неизвестный формат физического бизнеса qzx",
      locale: "ru-RU",
      countryCodes: ["RU"],
    },
    {
      mode: "kimi",
      kimiClient: {
        modelId: "mock-invalid-physical",
        cacheIdentity: "mock-invalid-physical-v1",
        async encode() {
          return {
            semanticIntent: invalidPhysical,
            modelId: this.modelId,
            finishReason: "stop",
            latencyMs: 1,
            firstSseEventLatencyMs: 0,
            usage: {
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              totalTokens: 15,
            },
          };
        },
      },
    },
  );
  assert.equal(plan.executionPreview, null);
  assert.equal(plan.ai.validation, "failed");
});

test("server env rejects unknown or incompatible model policies", () => {
  for (const env of [
    {
      KIMI_API_KEY: apiKey,
      KIMI_PLANNER_MODEL: "kimi-k2.6",
      KIMI_PLANNER_REASONING_EFFORT: "low",
    },
    {
      KIMI_API_KEY: apiKey,
      KIMI_PLANNER_MODEL: "kimi-k3",
      KIMI_PLANNER_REASONING_EFFORT: "medium",
    },
    {
      KIMI_API_KEY: apiKey,
      KIMI_PLANNER_MODEL: "kimi-latest",
    },
  ]) {
    assert.throws(
      () => kimiClientConfigFromEnv(env),
      (error) =>
        error instanceof KimiClientError &&
        error.code === "KIMI_CONFIGURATION_ERROR",
    );
  }
});

test("blank reasoning effort is absent for the K2.6 environment profile", () => {
  const config = kimiClientConfigFromEnv({
    KIMI_API_KEY: apiKey,
    KIMI_PLANNER_MODEL: "kimi-k2.6",
    KIMI_PLANNER_REASONING_EFFORT: "   ",
  });

  assert.equal(config?.model, "kimi-k2.6");
  assert.equal(config?.reasoningEffort, undefined);
});

test(
  "runtime planner cache identity changes with the K3 effort policy",
  { concurrency: false },
  async () => {
    const previousFetch = globalThis.fetch;
    const scheduler = { run: (task) => task() };
    const baseEnv = {
      QUERY_INTELLIGENCE_MODE: "kimi",
      KIMI_API_KEY: apiKey,
      KIMI_PLANNER_MODEL: "kimi-k3",
      SEARCH_PLAN_SIGNING_SECRET:
        "test-only-signing-secret-at-least-thirty-two-bytes",
    };
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return kimiSseResponse("kimi-k3");
    };
    clearSearchPlanRuntimeCache();

    try {
      const input = { primaryQuery: "современный спортивный зал" };
      const low = await createSearchPlanFromEnv(
        input,
        { scheduler },
        { ...baseEnv, KIMI_PLANNER_REASONING_EFFORT: "low" },
      );
      const high = await createSearchPlanFromEnv(
        input,
        { scheduler },
        { ...baseEnv, KIMI_PLANNER_REASONING_EFFORT: "high" },
      );
      const cachedHigh = await createSearchPlanFromEnv(
        input,
        { scheduler },
        { ...baseEnv, KIMI_PLANNER_REASONING_EFFORT: "high" },
      );

      assert.equal(low.ai.cacheHit, false);
      assert.equal(high.ai.cacheHit, false);
      assert.equal(cachedHigh.ai.cacheHit, true);
      assert.equal(calls, 2);
    } finally {
      clearSearchPlanRuntimeCache();
      globalThis.fetch = previousFetch;
    }
  },
);

test("K3 low and high policy identities produce distinct plan hashes", async () => {
  const createClient = (reasoningEffort) =>
    createKimiClient({
      apiKey,
      model: "kimi-k3",
      reasoningEffort,
      fetchImpl: async () => kimiSseResponse("kimi-k3"),
    });
  const input = { primaryQuery: "современный спортивный зал" };

  const low = await createSearchPlan(input, {
    mode: "kimi",
    kimiClient: createClient("low"),
  });
  const high = await createSearchPlan(input, {
    mode: "kimi",
    kimiClient: createClient("high"),
  });

  assert.notEqual(low.promptVersion, high.promptVersion);
  assert.match(low.promptVersion, /k3-reasoning:low$/);
  assert.match(high.promptVersion, /k3-reasoning:high$/);
  assert.notEqual(low.planHash, high.planHash);
});

test("confirmation material preserves and accepts the exact Kimi behavior identity", async () => {
  const now = new Date("2026-08-20T10:00:00.000Z");
  const signingSecret = "test-only-signing-secret-at-least-thirty-two-bytes";
  const ambiguousIntent = semanticIntentFor("warehouse");
  ambiguousIntent.industries = [];
  ambiguousIntent.coreBusinessTypes = [];
  ambiguousIntent.adjacentBusinessTypes = [];
  ambiguousIntent.productsAndServices = [];
  ambiguousIntent.includeSignals = [];
  ambiguousIntent.retrievalTerms = {
    precision: [],
    recall: [],
    exclude: [],
  };
  ambiguousIntent.confidence = "medium";
  ambiguousIntent.ambiguity = {
    isAmbiguous: true,
    reason: "The term can describe materially different physical businesses",
    clarificationQuestion: "Какой именно тип склада нужен?",
  };
  const client = createKimiClient({
    apiKey,
    model: "kimi-k3",
    reasoningEffort: "high",
    fetchImpl: async () => kimiSseResponse("kimi-k3", ambiguousIntent),
  });
  const input = { primaryQuery: "склад" };
  const plan = await createSearchPlan(input, {
    mode: "kimi",
    kimiClient: client,
    signingSecret,
    now,
  });

  assert.equal(plan.status, "needs_confirmation");
  assert.match(plan.promptVersion, /k3-reasoning:high$/);
  assert.ok(plan.confirmation.token);
  const selected = plan.resolution.alternatives[0];
  assert.ok(selected);

  const confirmed = await confirmSearchPlan(
    {
      input,
      confirmationToken: plan.confirmation.token,
      selectedAlternative: {
        alternativeId: selected.alternativeId,
        alternativeHash: selected.alternativeHash,
        semanticIntent: selected.semanticIntent,
      },
    },
    { signingSecret, now },
  );

  assert.equal(confirmed.status, "ready");
  assert.equal(confirmed.promptVersion, plan.promptVersion);
  assert.equal(confirmed.parentPlanHash, plan.planHash);
});

test("known environment policy creates a client without network access", () => {
  const client = createKimiClientFromEnv({
    KIMI_API_KEY: apiKey,
    KIMI_PLANNER_MODEL: "kimi-k2.6",
  });

  assert.equal(client?.modelId, "kimi-k2.6");
  assert.equal(
    client?.cacheIdentity,
    "kimi-model-policy/2026-08-20.6:kimi-k2.6:k2.6-thinking-disabled:none",
  );
  assert.ok(KIMI_PROMPT_VERSION.includes(KIMI_MODEL_POLICY_VERSION));
});
