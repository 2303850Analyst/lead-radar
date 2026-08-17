import assert from "node:assert/strict";
import test from "node:test";

import { createSearchOrchestrator } from "../lib/search-orchestrator.ts";

test("search orchestrator prepares and executes only the selected provider adapter", async () => {
  const calls = [];
  const progress = [];
  const payload = {
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
