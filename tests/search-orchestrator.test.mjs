import assert from "node:assert/strict";
import test from "node:test";

import { createSearchOrchestrator } from "../lib/search-orchestrator.ts";

const BASE_PAYLOAD = {
  description: "Фулфилмент",
  primaryQuery: "Фулфилмент",
  relatedQueries: [],
  excludeQueries: [],
  location: "Москва",
  radiusKm: 15,
  services: [],
  locale: "ru-RU",
  countryCodes: ["RU"],
};

function unusedProviderAdapter() {
  return {
    preparationMessage: "Не должен запускаться",
    async prepare() {
      throw new Error("provider was prepared before semantic acceptance");
    },
  };
}

test("search orchestrator prepares and executes only the selected provider adapter", async () => {
  const calls = [];
  const progress = [];
  const payload = { ...BASE_PAYLOAD };
  const plan = {
    status: "ready",
    resolution: { selectedConceptIds: ["logistics.fulfillment"] },
    executionPreview: {
      provider: "geoapify",
      categoryLabels: ["office.logistics"],
      batches: 1,
    },
  };
  const response = {
    mode: "demo",
    provider: {
      id: "demo",
      label: "Demo",
      queriedAt: "2026-08-17T00:00:00.000Z",
      policy: {
        persistence: "synthetic",
        attributionRequired: false,
        attribution: [],
        rawResponsesStored: false,
      },
    },
    query: payload,
    summary: {
      cardsFound: 0,
      uniqueLocations: 0,
      assumedBusinesses: 0,
      foundByPrimary: 0,
      foundOnlyExpanded: 0,
      digitalGapCandidates: 0,
      manualReviewCandidates: 0,
    },
    leads: [],
    notice: "Demo",
    generatedAt: "2026-08-17T00:00:00.000Z",
  };

  const selectedAdapter = {
    preparationMessage: "Готовим demo",
    async prepare(receivedPlan) {
      calls.push(["prepare", receivedPlan]);
      return {
        completedMessage: "Demo готов",
        async execute(receivedPayload) {
          calls.push(["execute", receivedPayload]);
          return response;
        },
      };
    },
  };
  const unusedAdapter = {
    preparationMessage: "Не должен запускаться",
    async prepare() {
      throw new Error("unselected provider was prepared");
    },
  };
  const orchestrator = createSearchOrchestrator({
    verifyGeography: async (value) => value,
    createPlan: async () => plan,
    confirmPlan: async () => plan,
    isPlannerInfrastructureFailure: () => false,
    selectProvider: () => "demo",
    providers: {
      demo: selectedAdapter,
      geoapify: unusedAdapter,
      yandex: unusedAdapter,
    },
  });

  const result = await orchestrator.search(payload, {
    onProgress: (event) => progress.push(event),
  });

  assert.equal(result.mode, "demo");
  assert.equal(result.plan, plan);
  assert.deepEqual(calls, [
    ["prepare", plan],
    ["execute", payload],
  ]);
  assert.deepEqual(
    progress
      .filter((event) => event.stage === "provider_compilation")
      .map((event) => [event.status, event.message]),
    [
      ["started", "Готовим demo"],
      ["completed", "Demo готов"],
    ],
  );
});

test("search orchestrator rejects ambiguity before provider-backed geography verification", async () => {
  let geographyCalls = 0;
  const ambiguousPlan = {
    status: "needs_confirmation",
    resolution: { selectedConceptIds: [], alternatives: [] },
    executionPreview: null,
  };
  const unusedAdapter = unusedProviderAdapter();
  const orchestrator = createSearchOrchestrator({
    async verifyGeography() {
      geographyCalls += 1;
      throw new Error("geography must not run before semantic confirmation");
    },
    createPlan: async () => ambiguousPlan,
    confirmPlan: async () => ambiguousPlan,
    isPlannerInfrastructureFailure: () => false,
    selectProvider: () => "geoapify",
    providers: {
      demo: unusedAdapter,
      geoapify: unusedAdapter,
      yandex: unusedAdapter,
    },
  });

  await assert.rejects(
    orchestrator.search({ ...BASE_PAYLOAD }),
    (error) => error?.code === "SEARCH_PLAN_CONFIRMATION_REQUIRED",
  );
  assert.equal(geographyCalls, 0);
});

test("search orchestrator validates a confirmation before provider-backed geography verification", async () => {
  let geographyCalls = 0;
  let createPlanCalls = 0;
  const unusedAdapter = unusedProviderAdapter();
  const orchestrator = createSearchOrchestrator({
    async verifyGeography() {
      geographyCalls += 1;
      throw new Error("geography must not run before confirmation validation");
    },
    async createPlan() {
      createPlanCalls += 1;
      throw new Error("confirmed requests must not be replanned");
    },
    async confirmPlan() {
      const error = new Error("Подтверждение запроса недействительно");
      error.code = "CONFIRMATION_TOKEN_INVALID";
      throw error;
    },
    isPlannerInfrastructureFailure: () => false,
    selectProvider: () => "geoapify",
    providers: {
      demo: unusedAdapter,
      geoapify: unusedAdapter,
      yandex: unusedAdapter,
    },
  });

  await assert.rejects(
    orchestrator.search({
      ...BASE_PAYLOAD,
      confirmationToken: "v2.invalid",
      confirmedAlternative: {
        alternativeId: "alt-invalid",
        alternativeHash: "a".repeat(64),
        semanticIntent: {
          schemaVersion: "2.0",
        },
      },
    }),
    (error) => error?.code === "CONFIRMATION_TOKEN_INVALID",
  );
  assert.equal(createPlanCalls, 0);
  assert.equal(geographyCalls, 0);
});
