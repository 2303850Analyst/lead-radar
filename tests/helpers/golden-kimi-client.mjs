import {
  expandPlannerCases,
  normalizeForFixture,
} from "./query-intelligence-fixtures.mjs";
import { CANONICAL_TAXONOMY } from "../../lib/search-planner/taxonomy.ts";

const conceptsById = new Map(
  CANONICAL_TAXONOMY.map((concept) => [concept.id, concept]),
);

function lookupKey({ locale, countryCode, query }) {
  return JSON.stringify([
    locale,
    countryCode,
    normalizeForFixture(query),
  ]);
}

export function createGoldenKimiClient(fixture) {
  const allCases = expandPlannerCases(fixture);
  const byIntent = new Map(
    allCases.map((entry) => [
      lookupKey(entry),
      entry,
    ]),
  );
  const calls = [];

  return {
    modelId: "mock-kimi-semantic-v2",
    calls,
    async encode(request) {
      const entry = byIntent.get(
        lookupKey({
          locale: request.intent.locale,
          countryCode: request.intent.countryCodes[0],
          query: request.intent.primaryQuery,
        }),
      );
      if (!entry) throw new Error("Golden Kimi mock received an unknown intent");

      calls.push({
        caseId: entry.id,
        mode: "open_vocabulary",
      });

      const concept = entry.expectedConceptId
        ? conceptsById.get(entry.expectedConceptId)
        : null;
      const coreBusinessType =
        concept?.labels?.[request.intent.locale] ??
        concept?.labels?.["ru-RU"] ??
        request.intent.primaryQuery;
      const isAmbiguous = entry.expectedStatus === "needs_confirmation";
      const isUnsupported = entry.expectedStatus === "unsupported";
      const semanticIntent = {
        schemaVersion: "2.0",
        normalizedGoal: isUnsupported
          ? request.intent.primaryQuery
          : `найти ${coreBusinessType}`,
        entityKind: isUnsupported ? "non_physical" : "physical_business",
        physicalLocationRequirement: isUnsupported ? "not_applicable" : "required",
        industries: [],
        coreBusinessTypes: [coreBusinessType],
        adjacentBusinessTypes: [],
        excludedBusinessTypes: [...request.intent.excludeQueries],
        productsAndServices: [],
        includeSignals: [coreBusinessType],
        excludeSignals: [...request.intent.excludeQueries],
        retrievalTerms: {
          precision: [coreBusinessType],
          recall: [coreBusinessType],
          exclude: [...request.intent.excludeQueries],
        },
        brandSearch: "include",
        confidence: isAmbiguous ? "medium" : "high",
        ambiguity: {
          isAmbiguous,
          reason: isAmbiguous ? "Несколько типов бизнеса подходят под запрос" : null,
          clarificationQuestion: isAmbiguous
            ? "Какой именно тип бизнеса вы хотите найти?"
            : null,
        },
      };

      if (entry.expectedStatus === "ready" && !concept) {
        throw new Error(`${entry.id}: expected concept is absent from fixture taxonomy`);
      }
      /*
       * This mock deliberately never receives or returns a canonical candidate.
       * The planner's temporary compatibility layer may map the open semantic
       * labels after encoding, but the model-facing seam remains open vocabulary.
       */
      return {
        semanticIntent,
        modelId: this.modelId,
        finishReason: "stop",
        latencyMs: 1,
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
      };
    },
  };
}
