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
import { validateKimiSemanticIntent } from "../lib/search-planner/schema.ts";

const apiKey = "test-only-placeholder-key";

function semanticIntentFor(businessType = "sports hall") {
  return {
    schemaVersion: "2.1",
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

function kimiSseResponse(model, semanticIntent = semanticIntentFor()) {
  const content = JSON.stringify(semanticIntent);
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

  assert.equal(KIMI_MODEL_POLICY_VERSION, "kimi-model-policy/2026-08-20.4");
  assert.equal(payload.reasoning_effort, "low");
  assert.equal(Object.hasOwn(payload, "thinking"), false);
  assert.deepEqual(payload.stream_options, { include_usage: true });
  assert.equal(result.usage.cachedInputTokens, 20);
  assert.ok(
    Number.isInteger(result.firstSseEventLatencyMs) &&
      result.firstSseEventLatencyMs >= 0,
  );
  assert.equal(
    client.cacheIdentity,
    "kimi-model-policy/2026-08-20.4:kimi-k3:k3-reasoning:low",
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
    { type: "string", enum: ["2.1"] },
  );
  assert.throws(
    () =>
      validateKimiSemanticIntent({
        ...semanticIntentFor(),
        coreBusinessTypes: [],
      }),
    /failed validation/i,
  );
});

test("terminal usage-only SSE chunks are accepted and retained", async () => {
  const content = JSON.stringify(semanticIntentFor());
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
  const content = JSON.stringify(semanticIntentFor());
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
  assert.equal(
    client.cacheIdentity,
    "kimi-model-policy/2026-08-20.4:kimi-k2.6:k2.6-thinking-disabled:none",
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
      error.semanticValidationIssueCodes?.includes("array_size") === true,
  );
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
    "kimi-model-policy/2026-08-20.4:kimi-k2.6:k2.6-thinking-disabled:none",
  );
  assert.ok(KIMI_PROMPT_VERSION.includes(KIMI_MODEL_POLICY_VERSION));
});
