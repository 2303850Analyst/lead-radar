import assert from "node:assert/strict";
import test from "node:test";

import {
  TwoGisProvider,
  compileTwoGisTextArms,
  twoGisPaginationLimits,
} from "../lib/providers/2gis.ts";

function payload(overrides = {}) {
  return {
    description: "Ищем физический бизнес",
    primaryQuery: "Hookah bar",
    relatedQueries: [],
    excludeQueries: [],
    location: "Москва, ул. Лесная, 7",
    locationMode: "radius",
    center: [37.6177, 55.7558],
    radiusKm: 15,
    services: [],
    locale: "ru-RU",
    countryCodes: ["RU"],
    ...overrides,
  };
}

function semanticIntent(overrides = {}) {
  return {
    schemaVersion: "2.2",
    normalizedGoal: "Найти кальянные",
    entityKind: "physical_business",
    physicalLocationRequirement: "required",
    industries: ["hospitality"],
    coreBusinessTypes: ["кальянная"],
    adjacentBusinessTypes: [],
    excludedBusinessTypes: [],
    productsAndServices: [],
    includeSignals: [],
    excludeSignals: [],
    retrievalTerms: {
      precision: ["hookah bar"],
      recall: ["кальян-бар"],
      exclude: [],
    },
    brandSearch: "include",
    confidence: "high",
    ambiguity: {
      isAmbiguous: false,
      reason: null,
      clarificationQuestion: null,
    },
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("2GIS sends bounded free-text requests, deduplicates cards and preserves explicit evidence", async () => {
  const urls = [];
  const item = {
    id: "70000001012345678",
    type: "branch",
    name: "Дым, кальянная",
    full_address_name: "Москва, Лесная улица, 7",
    address_comment: "1 этаж",
    point: { lon: 37.615, lat: 55.756 },
    rubrics: [{ id: "123", name: "Кальянные" }],
    contact_groups: [
      {
        contacts: [
          { type: "phone", value: "+7 495 000-00-00" },
          { type: "website", value: "smoke.example" },
        ],
      },
    ],
  };
  const fetch = async (input) => {
    urls.push(new URL(String(input)));
    return jsonResponse({
      meta: { code: 200 },
      result: { items: [item], total: 1 },
    });
  };
  const provider = new TwoGisProvider("test-key", {
    fetch,
    contactsEnabled: true,
    exportEnabled: true,
  });
  const intent = semanticIntent({
    includeSignals: ["первый или цокольный этаж", "в жилом доме"],
  });
  const arms = compileTwoGisTextArms(payload(), intent);
  assert.deepEqual(
    arms.map((arm) => arm.query),
    ["Hookah bar", "кальянная", "кальян-бар"],
  );
  assert.equal(arms.length, 3);
  assert.ok(arms.every((arm) => !("rubricId" in arm)));

  const result = await provider.search(payload({ radiusKm: 50 }), {
    semanticIntent: intent,
  });

  assert.equal(result.outcome, "success_with_results");
  assert.equal(result.mode, "2gis");
  assert.deepEqual(result.provider.policy.capabilities, {
    mapDisplay: true,
    csvExport: true,
    localPersistence: false,
  });
  assert.equal(result.leads.length, 1);
  assert.equal(result.leads[0].relevance.status, "matched");
  assert.equal(result.leads[0].phone, "+7 495 000-00-00");
  assert.equal(result.leads[0].website.url, "https://smoke.example/");
  assert.equal(result.leads[0].discovery.matchedQueries.length, 3);
  assert.deepEqual(result.leads[0].requirements, [
    { requirement: "первый или цокольный этаж", status: "confirmed_match" },
    { requirement: "в жилом доме", status: "unknown" },
  ]);
  assert.equal(result.provider.coverage.upstreamRequests, 3);
  assert.deepEqual(
    urls.map((url) => url.searchParams.get("q")),
    ["Hookah bar", "кальянная", "кальян-бар"],
  );
  for (const url of urls) {
    assert.equal(url.pathname, "/3.0/items");
    assert.equal(url.searchParams.get("type"), "branch");
    assert.equal(url.searchParams.get("point"), "37.6177,55.7558");
    assert.equal(url.searchParams.get("location"), "37.6177,55.7558");
    assert.equal(url.searchParams.get("radius"), "50000");
    assert.equal(url.searchParams.get("page_size"), "10");
    assert.equal(url.searchParams.get("locale"), "ru_RU");
    assert.equal(url.searchParams.get("key"), "test-key");
    assert.equal(url.searchParams.has("rubric_id"), false);
    assert.match(url.searchParams.get("fields"), /items\.contact_groups/);
  }
  await assert.rejects(
    provider.search(payload({ radiusKm: 50.1 }), { semanticIntent: intent }),
    (error) => error?.code === "DGIS_RADIUS_TOO_LARGE",
  );
  assert.equal(urls.length, 3, "invalid radius must fail before an upstream call");
});

test("2GIS follows result pages until the reported total is collected", async () => {
  assert.deepEqual(twoGisPaginationLimits(), {
    pageSize: 10,
    maxPages: 5,
    maxResultsPerArm: 50,
  });
  assert.deepEqual(twoGisPaginationLimits({ demoMode: false }), {
    pageSize: 50,
    maxPages: 20,
    maxResultsPerArm: 1_000,
  });

  const pages = [];
  const total = 25;
  const fetch = async (input) => {
    const url = new URL(String(input));
    const page = Number(url.searchParams.get("page"));
    const pageSize = Number(url.searchParams.get("page_size"));
    pages.push(page);
    const offset = (page - 1) * pageSize;
    const count = Math.max(0, Math.min(pageSize, total - offset));
    return jsonResponse({
      meta: { code: 200 },
      result: {
        total,
        items: Array.from({ length: count }, (_, index) => {
          const id = offset + index + 1;
          return {
            id: `floating-${id}`,
            type: "branch",
            name: `Флоатинг-студия ${id}`,
            full_address_name: `Москва, Тестовая улица, ${id}`,
            point: { lon: 37.6 + id / 10_000, lat: 55.7 + id / 10_000 },
            rubrics: [{ id: "floating", name: "Флоатинг" }],
          };
        }),
      },
    });
  };
  const provider = new TwoGisProvider("test-key", { fetch });
  const intent = semanticIntent({
    coreBusinessTypes: ["студия флоатинга"],
    retrievalTerms: { precision: [], recall: [], exclude: [] },
  });

  const result = await provider.search(
    payload({ primaryQuery: "студия флоатинга" }),
    { semanticIntent: intent },
  );

  assert.deepEqual(pages, [1, 2, 3]);
  assert.equal(result.outcome, "success_with_results");
  assert.equal(result.leads.length, total);
  assert.equal(result.summary.cardsFound, total);
  assert.equal(result.provider.coverage.upstreamRequests, 3);
});

test("2GIS does not confirm hookah bar from a broad bar rubric alone", async () => {
  const urls = [];
  const fetch = async (input) => {
    urls.push(new URL(String(input)));
    return jsonResponse({
      meta: { code: 200 },
      result: {
        total: 1,
        items: [
          {
            id: "broad-bar",
            type: "branch",
            name: "Север",
            address_name: "Лесная улица, 9",
            point: { lon: 37.616, lat: 55.757 },
            rubrics: [{ id: "bar", name: "Бары" }],
          },
        ],
      },
    });
  };
  const provider = new TwoGisProvider("test-key", { fetch });
  const intent = semanticIntent({
    coreBusinessTypes: ["hookah bar"],
    retrievalTerms: { precision: [], recall: ["bar"], exclude: [] },
    includeSignals: ["первый этаж"],
  });

  const result = await provider.search(payload(), { semanticIntent: intent });

  assert.equal(result.leads.length, 1);
  assert.equal(result.leads[0].relevance.status, "maybe");
  assert.deepEqual(result.leads[0].digitalProblems, []);
  assert.ok(
    urls.every(
      (url) => !url.searchParams.get("fields").includes("items.contact_groups"),
    ),
    "contacts must stay out of the request when disabled",
  );
  assert.deepEqual(result.leads[0].requirements, [
    { requirement: "первый этаж", status: "unknown" },
  ]);
  assert.equal(result.summary.manualReviewCandidates, 1);
});

test("2GIS retries a transient failure and returns success_empty for an empty source", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: "temporary" }, 500);
    return jsonResponse({
      meta: { code: 200 },
      result: { items: [], total: 0 },
    });
  };
  const provider = new TwoGisProvider("secret-test-key", { fetch });
  const oneArmIntent = semanticIntent({
    coreBusinessTypes: ["студия флоатинга"],
    retrievalTerms: { precision: [], recall: [], exclude: [] },
  });

  const result = await provider.search(
    payload({ primaryQuery: "студия флоатинга" }),
    { semanticIntent: oneArmIntent },
  );

  assert.equal(calls, 2);
  assert.equal(result.outcome, "success_empty");
  assert.deepEqual(result.leads, []);
  assert.equal(result.provider.coverage.upstreamRequests, 2);
});
