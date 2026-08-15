import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtimeEnv = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};

const runtimeContext = {
  waitUntil() {},
  passThroughOnException() {},
};

async function getWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

test("server-renders the LeadRadar search workspace", async () => {
  const worker = await getWorker();
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    runtimeEnv,
    runtimeContext,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html lang="ru">/i);
  assert.match(html, /LeadRadar/);
  assert.match(html, /Новый поиск компаний/);
  assert.match(html, /Запустить поиск/);
  assert.match(html, /Geoapify Places API/);
  assert.match(html, /Владимир/);
  assert.doesNotMatch(html, /Алексей/);
  assert.doesNotMatch(html, /sites-skeleton|codex-preview|react-loading-skeleton/i);
});

test("search API exposes health and deterministic demo results", async () => {
  const worker = await getWorker();
  const healthResponse = await worker.fetch(
    new Request("http://localhost/api/search"),
    runtimeEnv,
    runtimeContext,
  );
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, "ok");
  assert.equal(health.mode, "demo");
  assert.equal(health.geoapifyConfigured, false);
  assert.equal(health.geoapifyKeyConfigured, false);
  assert.equal(health.yandexConfigured, false);
  assert.equal(health.yandexLiveUiEnabled, false);
  const packageMetadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageMetadata.name, "lead-radar");
  assert.equal(health.version, packageMetadata.version);
  assert.equal(health.capabilities.geoapifyPlaces.strictRadius, true);
  assert.equal(health.capabilities.geoapifyPlaces.rawResponsesStored, false);
  assert.equal(health.capabilities.yandexGeosearch.strictRadius, true);

  const searchResponse = await worker.fetch(
    new Request("http://localhost/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: "Фулфилменты для маркетплейсов",
        primaryQuery: "Фулфилмент",
        relatedQueries: ["Складские услуги", "Комплектация заказов"],
        excludeQueries: ["Камеры хранения"],
        location: "Москва, ул. Лесная, 7",
        radiusKm: 15,
        services: ["Создание сайта", "Внедрение CRM"],
      }),
    }),
    runtimeEnv,
    runtimeContext,
  );

  assert.equal(searchResponse.status, 200);
  const result = await searchResponse.json();
  assert.equal(result.mode, "demo");
  assert.equal(result.leads.length, 8);
  assert.equal(result.leads[0].name, "Фулфилмент Про");
  assert.match(result.notice, /синтетические данные/i);
});

test("Geoapify provider normalizes live data without inventing missing websites", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    SEARCH_PROVIDER: process.env.SEARCH_PROVIDER,
    GEOAPIFY_API_KEY: process.env.GEOAPIFY_API_KEY,
    GEOAPIFY_PLACES_LIMIT: process.env.GEOAPIFY_PLACES_LIMIT,
    GEOAPIFY_DETAILS_LIMIT: process.env.GEOAPIFY_DETAILS_LIMIT,
  };
  const fakeKey = "fake-test-key";
  const upstreamCalls = [];

  process.env.SEARCH_PROVIDER = "geoapify";
  process.env.GEOAPIFY_API_KEY = fakeKey;
  process.env.GEOAPIFY_PLACES_LIMIT = "3";
  process.env.GEOAPIFY_DETAILS_LIMIT = "1";

  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    upstreamCalls.push(url.pathname);
    assert.equal(url.searchParams.get("apiKey"), fakeKey);

    if (url.pathname === "/v1/geocode/search") {
      assert.equal(url.searchParams.get("filter"), "countrycode:ru");
      return Response.json({
        features: [{ geometry: { type: "Point", coordinates: [37.6176, 55.7558] } }],
      });
    }

    if (url.pathname === "/v2/places") {
      assert.equal(
        url.searchParams.get("categories"),
        "office.logistics,rental.storage",
      );
      assert.match(url.searchParams.get("filter") ?? "", /^circle:/);
      return Response.json({
        features: [
          {
            properties: {
              place_id: "place-ru-storage",
              name: "Склад Север",
              formatted: "Москва, Складочная улица, 1",
              country_code: "ru",
              categories: ["rental.storage"],
            },
            geometry: { type: "Point", coordinates: [37.62, 55.76] },
          },
          {
            properties: {
              place_id: "place-by",
              name: "Border Warehouse",
              formatted: "Минск",
              country_code: "by",
              categories: ["rental.storage"],
            },
            geometry: { type: "Point", coordinates: [27.56, 53.9] },
          },
          {
            properties: {
              place_id: "place-ru-logistics",
              name: "Логистик",
              formatted: "Москва, Лесная улица, 2",
              country_code: "ru",
              categories: ["office.logistics"],
            },
            geometry: { type: "Point", coordinates: [37.63, 55.75] },
          },
        ],
      });
    }

    if (url.pathname === "/v2/place-details") {
      return Response.json({
        features: [
          {
            properties: {
              feature_type: "details",
              contact: {
                phone_other: ["+7 999 000-00-01"],
                email_other: ["hello@example.test"],
              },
              website_other: ["https://example.test"],
            },
          },
        ],
      });
    }

    return new Response("Unexpected upstream request", { status: 500 });
  };

  try {
    const worker = await getWorker();
    const response = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: "Фулфилмент и склады",
          primaryQuery: "Фулфилмент",
          relatedQueries: ["Складские услуги", "Логистика"],
          excludeQueries: [],
          location: "Москва",
          radiusKm: 15,
          services: ["Создание сайта"],
        }),
      }),
      runtimeEnv,
      runtimeContext,
    );

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.mode, "geoapify");
    assert.equal(result.summary.cardsFound, 3);
    assert.equal(result.leads.length, 2);
    assert.equal(result.summary.foundByPrimary, 0);
    assert.equal(result.summary.foundOnlyExpanded, 2);
    assert.equal(result.summary.digitalGapCandidates, 0);
    assert.equal(result.provider.coverage.detailsRequested, 1);
    assert.equal(result.provider.coverage.detailsSucceeded, 1);
    assert.equal(result.leads[0].phone, "+7 999 000-00-01");
    assert.equal(result.leads[0].email, "hello@example.test");
    assert.equal(result.leads[0].website.url, "https://example.test/");
    assert.equal(result.leads[0].website.sourceStatus, "listed");
    assert.equal(result.leads[1].website.sourceStatus, "not_checked");
    assert.doesNotMatch(result.leads[1].digitalProblems.join(" "), /сайт не указан/i);
    assert.deepEqual(upstreamCalls, [
      "/v1/geocode/search",
      "/v2/places",
      "/v2/place-details",
    ]);
    assert.equal(JSON.stringify(result).includes(fakeKey), false);

    const callsBeforeUnsupportedQuery = upstreamCalls.length;
    const unsupportedResponse = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: "Юридические услуги",
          primaryQuery: "Юристы",
          relatedQueries: [],
          excludeQueries: [],
          location: "Москва",
          radiusKm: 5,
          services: [],
        }),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(unsupportedResponse.status, 422);
    assert.equal(
      (await unsupportedResponse.json()).code,
      "GEOAPIFY_UNSUPPORTED_CATEGORY",
    );
    assert.equal(upstreamCalls.length, callsBeforeUnsupportedQuery);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("search API rejects invalid payloads", async () => {
  const worker = await getWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ primaryQuery: "", location: "Москва" }),
    }),
    runtimeEnv,
    runtimeContext,
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /основной поисковый запрос/i);
});
