import assert from "node:assert/strict";

if (process.env.RUN_KIMI_GEOAPIFY_LIVE_SMOKE !== "1") {
  process.stdout.write(
    "Live Kimi → Geoapify smoke skipped. Set RUN_KIMI_GEOAPIFY_LIVE_SMOKE=1 explicitly.\n",
  );
  process.exit(0);
}

if (!(process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY)) {
  throw new Error("A server-side Kimi API key is required");
}
if (!process.env.GEOAPIFY_API_KEY) {
  throw new Error("A server-side Geoapify API key is required");
}

process.env.QUERY_INTELLIGENCE_MODE = "kimi";
process.env.SEARCH_PROVIDER = "geoapify";
process.env.KIMI_REQUEST_TIMEOUT_MS ??= "45000";
process.env.GEOAPIFY_PLACES_LIMIT = "20";
process.env.GEOAPIFY_DETAILS_LIMIT = "3";

const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("live-smoke", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const runtimeEnv = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const runtimeContext = {
  waitUntil() {},
  passThroughOnException() {},
};

const startedAt = Date.now();
const response = await worker.fetch(
  new Request("http://localhost/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      description: "Найти действующие спортивные и тренажёрные залы для B2B-предложения",
      primaryQuery: "Спортивный зал",
      relatedQueries: ["Фитнес-клуб", "Тренажёрный зал"],
      excludeQueries: ["Магазин спортивных товаров"],
      location: "Москва",
      center: [37.6176, 55.7558],
      radiusKm: 5,
      locale: "ru-RU",
      countryCodes: ["RU"],
    }),
  }),
  runtimeEnv,
  runtimeContext,
);

const payload = await response.json();
if (response.status !== 200) {
  process.stdout.write(
    `${JSON.stringify({
      decision: "FAIL",
      httpStatus: response.status,
      errorCode: payload.code ?? "UNKNOWN",
      planStatus: payload.plan?.status ?? null,
      reasonCodes: payload.plan?.resolution?.reasonCodes ?? [],
      schemaValidation: payload.plan?.ai?.validation ?? null,
      elapsedMs: Date.now() - startedAt,
    }, null, 2)}\n`,
  );
  process.exit(1);
}
assert.equal(payload.mode, "geoapify");
assert.equal(payload.plan?.status, "ready");
assert.equal(payload.plan?.ai?.used, true);
assert.equal(payload.plan?.ai?.validation, "passed");
assert.equal(payload.provider?.policy?.rawResponsesStored, false);
const categories = payload.plan?.executionPreview?.categoryLabels ?? [];
assert.ok(categories.some((category) => category.startsWith("sport.")));
assert.equal(categories.some((category) => category.startsWith("catering.")), false);
assert.ok(Array.isArray(payload.leads) && payload.leads.length > 0);

process.stdout.write(
  `${JSON.stringify({
    decision: "PASS",
    mode: payload.mode,
    planStatus: payload.plan.status,
    kimiUsed: payload.plan.ai.used,
    schemaValidation: payload.plan.ai.validation,
    providerCategoryCount: categories.length,
    precisionSportCategoryFound: categories.some((category) =>
      ["sport.sports_hall", "sport.fitness.gym", "sport.fitness.fitness_centre"].includes(category),
    ),
    leadCount: payload.leads.length,
    detailsRequested: payload.provider?.coverage?.detailsRequested ?? 0,
    detailsSucceeded: payload.provider?.coverage?.detailsSucceeded ?? 0,
    elapsedMs: Date.now() - startedAt,
    rawResponsesStored: payload.provider?.policy?.rawResponsesStored ?? null,
  }, null, 2)}\n`,
);
