import {
  expandPlannerCases,
  normalizeForFixture,
} from "./query-intelligence-fixtures.mjs";

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
    modelId: "mock-kimi-golden-v1",
    calls,
    async resolve(request) {
      const entry = byIntent.get(
        lookupKey({
          locale: request.intent.locale,
          countryCode: request.intent.countryCodes[0],
          query: request.intent.primaryQuery,
        }),
      );
      if (!entry) throw new Error("Golden Kimi mock received an unknown intent");

      const allowedIds = new Set(
        request.candidates.map((candidate) => candidate.conceptId),
      );
      calls.push({
        caseId: entry.id,
        candidateMode: request.candidateMode,
        candidateCount: allowedIds.size,
      });

      let resolution;
      if (entry.expectedStatus === "ready") {
        if (!allowedIds.has(entry.expectedConceptId)) {
          throw new Error(
            `${entry.id}: expected concept was not supplied to the model`,
          );
        }
        resolution = {
          status: "selected",
          selectedConceptIds: [entry.expectedConceptId],
          alternatives: [],
          confidenceBand: "high",
          clarificationReasonCode: null,
        };
      } else if (entry.expectedStatus === "needs_confirmation") {
        const alternatives = entry.acceptableAlternatives
          .filter((conceptId) => allowedIds.has(conceptId))
          .slice(0, 3)
          .map((conceptId) => ({
            conceptId,
            reasonCodes: ["AMBIGUOUS_SCOPE"],
          }));
        if (alternatives.length < 2) {
          throw new Error(
            `${entry.id}: shortlist did not contain two acceptable alternatives`,
          );
        }
        resolution = {
          status: "ambiguous",
          selectedConceptIds: [],
          alternatives,
          confidenceBand: "medium",
          clarificationReasonCode: "AMBIGUOUS_SCOPE",
        };
      } else {
        resolution = {
          status: "unsupported",
          selectedConceptIds: [],
          alternatives: [],
          confidenceBand: "high",
          clarificationReasonCode: "NO_SUPPORTED_CONCEPT",
        };
      }

      return {
        resolution,
        modelId: this.modelId,
        finishReason: "stop",
        latencyMs: 1,
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
      };
    },
  };
}
