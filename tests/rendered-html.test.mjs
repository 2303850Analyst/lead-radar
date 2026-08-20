import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Keep production admission semantics while removing the 20-second Tier-0
// pacing delay from mocked worker tests.
process.env.KIMI_MIN_START_INTERVAL_MS = "0";
process.env.KIMI_ADMISSION_TIMEOUT_MS = "100";
process.env.KIMI_CIRCUIT_FAILURE_THRESHOLD = "100";

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

async function signedLegacyV1Token(secret, claims) {
  const claimsPart = Buffer.from(JSON.stringify({ v: 1, ...claims })).toString(
    "base64url",
  );
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(claimsPart),
  );
  return `${claimsPart}.${Buffer.from(signature).toString("base64url")}`;
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
  assert.match(html, /Город[\s\S]*Район[\s\S]*Метро[\s\S]*Область[\s\S]*Радиус/);
  assert.match(html, /Владимир/);
  assert.doesNotMatch(html, /Алексей/);
  assert.doesNotMatch(html, /sites-skeleton|codex-preview|react-loading-skeleton/i);
});

test("search-area map keeps a bounded responsive height", async () => {
  const css = await readFile(
    new URL("../components/SearchAreaMap.module.css", import.meta.url),
    "utf8",
  );
  const frameRule = css.match(/\.frame\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(frameRule, /height:\s*280px/);
  assert.match(frameRule, /min-height:\s*280px/);
  assert.doesNotMatch(frameRule, /height:\s*100%/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*560px\)[\s\S]*?\.frame\s*\{[\s\S]*?height:\s*230px/,
  );
});

test("result map derives focus bounds without a detached Leaflet circle", async () => {
  const source = await readFile(
    new URL("../components/LeadMap.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /leaflet\s*\.circle\([\s\S]{0,240}?\.getBounds\(\)/,
  );
  assert.match(
    source,
    /leaflet\s*\.latLng\(position\)\s*\.toBounds\(/,
  );
});

test("planner outage UI never presents an infrastructure failure as an unsupported niche", async () => {
  const source = await readFile(
    new URL("../components/LeadRadarApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /failure\.code === "SEARCH_PLANNER_UNAVAILABLE"[\s\S]*?setSearchPlan\(null\)[\s\S]*?повторите поиск/i,
  );
  const panelSource = await readFile(
    new URL("../components/SearchIntentPanel.tsx", import.meta.url),
    "utf8",
  );
  assert.match(panelSource, /Как сервис понял задачу/);
  assert.match(panelSource, /Основные типы/);
  assert.match(panelSource, /Смежные типы/);
  assert.match(panelSource, /Исключаем/);
  assert.doesNotMatch(panelSource, /Для этой ниши пока нет безопасной категории/);

  const panelCss = await readFile(
    new URL("../components/SearchIntentPanel.module.css", import.meta.url),
    "utf8",
  );
  assert.match(
    panelCss,
    /\.alternatives\s+label:focus-within\s*\{[^}]*outline:/s,
    "the visually hidden native radio must expose a visible keyboard focus ring",
  );
});

test("result UI keeps every relevance outcome inspectable without replacing website links", async () => {
  const source = await readFile(
    new URL("../components/LeadRadarApp.tsx", import.meta.url),
    "utf8",
  );
  for (const status of ["matched", "maybe", "rejected", "not_checked"]) {
    assert.match(source, new RegExp(`<option value="${status}">`));
  }
  assert.match(source, /Отклонены правилами/);
  assert.match(source, /Доказательства релевантности/);
  assert.match(source, /href=\{lead\.website\.url\}/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /websiteLabel\(lead\)/);
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
  assert.ok(health.capabilities.geoapifyPlaces.capabilityRegistry.categoryCount >= 800);
  assert.match(
    health.capabilities.geoapifyPlaces.capabilityRegistry.checksum,
    /^[a-f0-9]{64}$/,
  );
  assert.deepEqual(health.capabilities.geoapifyPlaces.retrievalLimits, {
    maxArms: 4,
    maxUpstreamRequests: 4,
    maxCards: 200,
    maxDetails: 50,
  });
  assert.equal(health.capabilities.metroStations.systems.length, 7);
  assert.equal(health.capabilities.metroStations.typedGeocodeFallback, true);
  assert.equal(health.capabilities.yandexGeosearch.strictRadius, true);
  assert.equal(health.capabilities.queryIntelligence.mode, "deterministic");
  assert.equal(health.capabilities.queryIntelligence.strictStructuredOutput, true);
  assert.equal(
    health.capabilities.queryIntelligence.relevance.deterministic,
    true,
  );
  assert.deepEqual(
    health.capabilities.queryIntelligence.relevance.statuses,
    ["matched", "maybe", "rejected", "not_checked"],
  );
  assert.equal(
    health.capabilities.queryIntelligence.relevance.liveLeadCardsSentToKimi,
    false,
  );

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
  assert.equal(result.summary.relevance.notChecked, 8);
  assert.ok(result.leads.every((lead) => lead.relevance.status === "not_checked"));
  assert.match(result.notice, /синтетические данные/i);
});

test("JSON and NDJSON demo search share one result without Geoapify compilation", { concurrency: false }, async () => {
  const previousProvider = process.env.SEARCH_PROVIDER;
  process.env.SEARCH_PROVIDER = "demo";

  const payload = {
    description: "Фулфилменты для маркетплейсов",
    primaryQuery: "Фулфилмент",
    relatedQueries: ["Складские услуги", "Комплектация заказов"],
    excludeQueries: ["Камеры хранения"],
    location: "Москва, ул. Лесная, 7",
    radiusKm: 15,
    services: ["Создание сайта", "Внедрение CRM"],
  };

  try {
    const worker = await getWorker();
    const jsonResponse = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      runtimeEnv,
      runtimeContext,
    );
    const streamResponse = await worker.fetch(
      new Request("http://localhost/api/search?stream=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      runtimeEnv,
      runtimeContext,
    );

    assert.equal(jsonResponse.status, 200);
    assert.equal(streamResponse.status, 200);
    const jsonResult = await jsonResponse.json();
    const records = (await streamResponse.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const streamedResult = records.find((record) => record.type === "result")?.data;
    assert.ok(streamedResult);
    assert.deepEqual(
      {
        mode: streamedResult.mode,
        summary: streamedResult.summary,
        leadIds: streamedResult.leads.map((lead) => lead.id),
        providerPolicy: streamedResult.provider.policy,
      },
      {
        mode: jsonResult.mode,
        summary: jsonResult.summary,
        leadIds: jsonResult.leads.map((lead) => lead.id),
        providerPolicy: jsonResult.provider.policy,
      },
    );

    const progress = records.filter((record) => record.type === "progress");
    assert.ok(progress.some((record) => record.stage === "provider_compilation"));
    assert.ok(
      progress.some(
        (record) =>
          record.stage === "provider_compilation" &&
          /demo не требует категорий/i.test(record.message),
      ),
    );
    assert.equal(
      progress.some((record) => /компилируем разрешённые категории/i.test(record.message)),
      false,
    );
    const relevanceIndex = progress.findIndex(
      (record) => record.stage === "relevance_classification",
    );
    const detailsIndex = progress.findIndex(
      (record) => record.stage === "details",
    );
    assert.ok(relevanceIndex >= 0 && relevanceIndex < detailsIndex);
  } finally {
    if (previousProvider === undefined) delete process.env.SEARCH_PROVIDER;
    else process.env.SEARCH_PROVIDER = previousProvider;
  }
});

test("JSON and NDJSON deadline races yield one controlled terminal outcome", { concurrency: false }, async () => {
  const previous = {
    SEARCH_PROVIDER: process.env.SEARCH_PROVIDER,
    GEOAPIFY_API_KEY: process.env.GEOAPIFY_API_KEY,
    QUERY_INTELLIGENCE_MODE: process.env.QUERY_INTELLIGENCE_MODE,
    SEARCH_REQUEST_DEADLINE_MS: process.env.SEARCH_REQUEST_DEADLINE_MS,
  };
  const previousFetch = globalThis.fetch;
  process.env.SEARCH_PROVIDER = "geoapify";
  process.env.GEOAPIFY_API_KEY = "deadline-test-key";
  process.env.QUERY_INTELLIGENCE_MODE = "deterministic";
  process.env.SEARCH_REQUEST_DEADLINE_MS = "25";
  globalThis.fetch = async (_input, init = {}) =>
    await new Promise((_resolve, reject) => {
      const fail = () => {
        reject(new DOMException("aborted", "AbortError"));
      };
      if (init.signal?.aborted) fail();
      else init.signal?.addEventListener("abort", fail, { once: true });
    });

  const payload = {
    description: "Фулфилмент",
    primaryQuery: "Фулфилмент",
    relatedQueries: [],
    excludeQueries: [],
    location: "Москва",
    center: [37.6176, 55.7558],
    radiusKm: 5,
    services: [],
  };

  try {
    const worker = await getWorker();
    const jsonResponse = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      runtimeEnv,
      runtimeContext,
    );
    const jsonFailure = await jsonResponse.json();
    assert.equal(jsonResponse.status, 504, JSON.stringify(jsonFailure));
    assert.equal(jsonFailure.code, "SEARCH_DEADLINE_EXCEEDED");
    assert.equal(jsonFailure.retryable, true);

    const streamResponse = await worker.fetch(
      new Request("http://localhost/api/search?stream=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      runtimeEnv,
      runtimeContext,
    );
    const records = (await streamResponse.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const terminal = records.filter((record) =>
      record.type === "result" || record.type === "error",
    );
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].type, "error");
    assert.equal(terminal[0].code, "SEARCH_DEADLINE_EXCEEDED");
    assert.equal(terminal[0].retryable, true);
    assert.equal(records[0].type, "progress");
    assert.equal(records[0].stage, "validation");
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
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
      if (url.searchParams.get("id") === "belorusskaya") {
        return Response.json({
          features: [
            {
              properties: {
                feature_type: "details",
                place_id: "canonical-belorusskaya",
                name: "Белорусская",
                country_code: "ru",
                categories: ["public_transport.subway"],
              },
              geometry: { type: "Point", coordinates: [37.5859, 55.7767] },
            },
          ],
        });
      }
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
    const geocodeResponse = await worker.fetch(
      new Request("http://localhost/api/geocode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ location: "Москва, ул. Лесная, 7" }),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(geocodeResponse.status, 200);
    assert.deepEqual(await geocodeResponse.json(), {
      coordinates: [37.6176, 55.7558],
      location: "Москва, ул. Лесная, 7",
      provider: "geoapify",
    });
    assert.deepEqual(upstreamCalls, ["/v1/geocode/search"]);
    upstreamCalls.length = 0;

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
          radiusKm: 1.5,
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

    upstreamCalls.length = 0;
    const streamResponse = await worker.fetch(
      new Request("http://localhost/api/search?stream=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: "Фулфилмент и склады",
          primaryQuery: "Фулфилмент",
          relatedQueries: ["Складские услуги", "Логистика"],
          excludeQueries: [],
          location: "",
          center: [37.5859, 55.7767],
          locationMode: "metro",
          metro: {
            systemId: "moscow",
            stationId: "geoapify:belorusskaya",
            stationName: "Белорусская",
          },
          radiusKm: 1.5,
          services: ["Создание сайта"],
        }),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(streamResponse.status, 200);
    assert.match(
      streamResponse.headers.get("content-type") ?? "",
      /^application\/x-ndjson\b/i,
    );
    const streamText = await streamResponse.text();
    const events = streamText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const progressEvents = events.filter((event) => event.type === "progress");
    assert.deepEqual(
      [...new Set(progressEvents.map((event) => event.stage))],
      [
        "validation",
        "intent_resolution",
        "provider_compilation",
        "geocoding",
        "places",
        "relevance_classification",
        "details",
        "normalizing",
        "complete",
      ],
    );
    assert.ok(
      progressEvents.some(
        (event) =>
          event.stage === "geocoding" &&
          event.message === "Используем точку, выбранную на карте",
      ),
    );
    assert.ok(
      progressEvents.some(
        (event) =>
          event.stage === "details" &&
          event.status === "running" &&
          event.completed === 1 &&
          event.total === 1,
      ),
    );
    const resultEvent = events.at(-1);
    assert.equal(resultEvent.type, "result");
    assert.equal(resultEvent.data.mode, "geoapify");
    assert.equal(
      resultEvent.data.query.location,
      "Метро «Белорусская», Москва",
    );
    assert.equal(resultEvent.data.query.locationMode, "metro");
    assert.equal(resultEvent.data.query.metro.stationName, "Белорусская");
    assert.equal(
      resultEvent.data.query.metro.stationId,
      "geoapify:belorusskaya",
    );
    assert.equal(streamText.includes(fakeKey), false);
    assert.deepEqual(upstreamCalls, [
      "/v2/place-details",
      "/v2/places",
      "/v2/place-details",
    ]);

    const callsBeforeStationMismatch = upstreamCalls.length;
    const stationMismatchResponse = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          primaryQuery: "Фулфилмент",
          location: "Метро «Потапово», Москва",
          locationMode: "metro",
          metro: {
            systemId: "moscow",
            stationId: "geoapify:belorusskaya",
            stationName: "Потапово",
          },
          center: [37.7149, 55.5605],
          radiusKm: 1.5,
          services: [],
        }),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(stationMismatchResponse.status, 400);
    assert.equal(
      (await stationMismatchResponse.json()).code,
      "METRO_STATION_MISMATCH",
    );
    assert.equal(upstreamCalls.length, callsBeforeStationMismatch);

    const callsBeforeUnsupportedQuery = upstreamCalls.length;
    const unsupportedResponse = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: "Удалённый финансовый совет без физического офиса",
          primaryQuery: "Онлайн-консультант по инвестициям",
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
      "SEARCH_PLAN_UNSUPPORTED",
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

test("metro API deduplicates stations and falls back to typed geocoding", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.GEOAPIFY_API_KEY;
  const fakeKey = "fake-metro-test-key";
  const upstreamPaths = [];
  process.env.GEOAPIFY_API_KEY = fakeKey;

  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    upstreamPaths.push(url.pathname);
    assert.equal(url.searchParams.get("apiKey"), fakeKey);

    if (url.pathname === "/v2/places") {
      assert.equal(url.searchParams.get("categories"), "public_transport.subway");
      assert.equal(url.searchParams.get("conditions"), "named");
      assert.equal(url.searchParams.get("limit"), "500");
      assert.equal(url.searchParams.get("offset"), "0");
      const filter = url.searchParams.get("filter") ?? "";
      if (filter.includes("50.1002,53.1959")) {
        return Response.json({
          features: [
            {
              properties: {
                place_id: "samara-moskovskaya",
                name: "Московская",
                country_code: "ru",
                categories: ["public_transport.subway"],
              },
              geometry: { type: "Point", coordinates: [50.1501, 53.2038] },
            },
          ],
        });
      }
      return Response.json({
        features: [
          {
            properties: {
              place_id: "belorusskaya-green",
              name: "Белорусская",
              color: "#2d9b50",
              country_code: "ru",
              categories: ["public_transport.subway"],
            },
            geometry: { type: "Point", coordinates: [37.5859, 55.7767] },
          },
          {
            properties: {
              place_id: "belorusskaya-brown",
              name: "Белорусская",
              color: "#8c7042",
              country_code: "ru",
              categories: ["public_transport.subway"],
            },
            geometry: { type: "Point", coordinates: [37.5844, 55.7752] },
          },
          {
            properties: {
              place_id: "park-pobedy-moscow",
              name: "Парк Победы",
              country_code: "ru",
              categories: ["public_transport.subway"],
            },
            geometry: { type: "Point", coordinates: [37.5038, 55.7362] },
          },
        ],
      });
    }

    if (url.pathname === "/v1/geocode/search") {
      assert.equal(url.searchParams.get("type"), "amenity");
      assert.match(url.searchParams.get("text") ?? "", /метро Гагаринская, Самара, Россия/i);
      return Response.json({
        features: [
          {
            properties: {
              place_id: "samara-gagarinskaya",
              name: "Гагаринская",
              result_type: "amenity",
              country_code: "ru",
              categories: ["public_transport.subway"],
            },
            geometry: { type: "Point", coordinates: [50.1325, 53.2001] },
          },
        ],
      });
    }

    if (url.pathname === "/v2/place-details") {
      assert.equal(url.searchParams.get("id"), "samara-gagarinskaya");
      return Response.json({
        features: [
          {
            properties: {
              feature_type: "details",
              place_id: "samara-gagarinskaya",
              name: "Гагаринская",
              country_code: "ru",
              categories: ["public_transport.subway"],
            },
            geometry: { type: "Point", coordinates: [50.1325, 53.2001] },
          },
        ],
      });
    }

    return new Response("Unexpected upstream request", { status: 500 });
  };

  try {
    const worker = await getWorker();
    const directoryResponse = await worker.fetch(
      new Request("http://localhost/api/metro-stations?city=moscow"),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(directoryResponse.status, 200);
    const directory = await directoryResponse.json();
    assert.equal(directory.system.city, "Москва");
    assert.equal(directory.stations.length, 2);
    const belorusskaya = directory.stations.find(
      (station) => station.name === "Белорусская",
    );
    assert.equal(belorusskaya.providerPlaceIds.length, 2);
    assert.deepEqual(belorusskaya.lineColors, ["#2d9b50", "#8c7042"]);

    const fallbackResponse = await worker.fetch(
      new Request(
        "http://localhost/api/metro-stations?city=samara&q=%D0%93%D0%B0%D0%B3%D0%B0%D1%80%D0%B8%D0%BD%D1%81%D0%BA%D0%B0%D1%8F",
      ),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(fallbackResponse.status, 200);
    const fallback = await fallbackResponse.json();
    assert.equal(fallback.stations[0].name, "Гагаринская");
    assert.equal(fallback.stations[0].systemId, "samara");
    assert.equal(JSON.stringify(fallback).includes(fakeKey), false);
    assert.ok(upstreamPaths.includes("/v1/geocode/search"));

    const invalidCityResponse = await worker.fetch(
      new Request("http://localhost/api/metro-stations?city=omsk"),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(invalidCityResponse.status, 400);
    assert.equal((await invalidCityResponse.json()).code, "METRO_INVALID_CITY");

    const tooShortQueryResponse = await worker.fetch(
      new Request("http://localhost/api/metro-stations?city=moscow&q=%D0%91"),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(tooShortQueryResponse.status, 400);
    assert.equal((await tooShortQueryResponse.json()).code, "METRO_INVALID_QUERY");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEOAPIFY_API_KEY;
    else process.env.GEOAPIFY_API_KEY = previousKey;
  }
});

test("one cancelled metro directory request does not cancel a concurrent caller", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.GEOAPIFY_API_KEY;
  process.env.GEOAPIFY_API_KEY = "fake-metro-concurrency-key";
  let upstreamRequests = 0;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    assert.equal(url.pathname, "/v2/places");
    upstreamRequests += 1;
    if (upstreamRequests === 1) markFirstStarted();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 35);
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      };
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
    });
    return Response.json({
      features: [
        {
          properties: {
            place_id: "ekb-ploshchad-1905",
            name: "Площадь 1905 года",
            country_code: "ru",
            categories: ["public_transport.subway"],
          },
          geometry: { type: "Point", coordinates: [60.5974, 56.8366] },
        },
      ],
    });
  };

  try {
    const worker = await getWorker();
    const firstController = new AbortController();
    const firstRequest = worker.fetch(
      new Request(
        "http://localhost/api/metro-stations?city=yekaterinburg",
        { signal: firstController.signal },
      ),
      runtimeEnv,
      runtimeContext,
    );
    await firstStarted;
    const healthyRequest = worker.fetch(
      new Request("http://localhost/api/metro-stations?city=yekaterinburg"),
      runtimeEnv,
      runtimeContext,
    );
    firstController.abort();

    const firstOutcome = await Promise.allSettled([firstRequest]);
    assert.ok(
      firstOutcome[0].status === "rejected" ||
        (firstOutcome[0].status === "fulfilled" &&
          firstOutcome[0].value.status >= 400),
    );
    const healthyResponse = await healthyRequest;
    assert.equal(healthyResponse.status, 200);
    const healthyPayload = await healthyResponse.json();
    assert.equal(healthyPayload.stations[0].name, "Площадь 1905 года");
    assert.ok(upstreamRequests >= 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEOAPIFY_API_KEY;
    else process.env.GEOAPIFY_API_KEY = previousKey;
  }
});

test("rejected metro requests do not consume the global rate budget", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.GEOAPIFY_API_KEY;
  process.env.GEOAPIFY_API_KEY = "fake-metro-rate-key";
  let upstreamRequests = 0;

  globalThis.fetch = async () => {
    upstreamRequests += 1;
    return Response.json({
      features: [
        {
          properties: {
            place_id: "kazan-kremlevskaya",
            name: "Кремлёвская",
            country_code: "ru",
            categories: ["public_transport.subway"],
          },
          geometry: { type: "Point", coordinates: [49.1061, 55.7952] },
        },
      ],
    });
  };

  try {
    const worker = await getWorker();
    const statuses = [];
    for (let index = 0; index < 60; index += 1) {
      const response = await worker.fetch(
        new Request("http://localhost/api/metro-stations?city=kazan", {
          headers: { "x-real-ip": "198.51.100.10" },
        }),
        runtimeEnv,
        runtimeContext,
      );
      statuses.push(response.status);
    }
    assert.equal(statuses.filter((status) => status === 200).length, 30);
    assert.equal(statuses.filter((status) => status === 429).length, 30);

    const otherClientResponse = await worker.fetch(
      new Request("http://localhost/api/metro-stations?city=kazan", {
        headers: { "x-real-ip": "198.51.100.11" },
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(otherClientResponse.status, 200);
    assert.equal(upstreamRequests, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEOAPIFY_API_KEY;
    else process.env.GEOAPIFY_API_KEY = previousKey;
  }
});

test("Yandex provider exposes only safe website links", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    SEARCH_PROVIDER: process.env.SEARCH_PROVIDER,
    YANDEX_MAPS_API_KEY: process.env.YANDEX_MAPS_API_KEY,
    YANDEX_LIVE_UI_ENABLED: process.env.YANDEX_LIVE_UI_ENABLED,
  };
  const fakeKey = "fake-yandex-test-key";

  process.env.SEARCH_PROVIDER = "yandex";
  process.env.YANDEX_MAPS_API_KEY = fakeKey;
  process.env.YANDEX_LIVE_UI_ENABLED = "true";

  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    assert.equal(url.searchParams.get("apikey"), fakeKey);
    if (url.searchParams.get("type") === "geo") {
      return Response.json({
        features: [{ geometry: { type: "Point", coordinates: [37.6176, 55.7558] } }],
      });
    }
    return Response.json({
      features: [
        {
          properties: {
            CompanyMetaData: {
              id: "unsafe-site",
              name: "Небезопасная ссылка",
              address: "Москва",
              url: "javascript:alert(1)",
            },
          },
          geometry: { type: "Point", coordinates: [37.62, 55.76] },
        },
        {
          properties: {
            CompanyMetaData: {
              id: "safe-site",
              name: "Сайт без схемы",
              address: "Москва",
              url: "example.test/company",
            },
          },
          geometry: { type: "Point", coordinates: [37.63, 55.75] },
        },
      ],
    });
  };

  try {
    const worker = await getWorker();
    const response = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          primaryQuery: "Ответственное хранение",
          relatedQueries: [],
          excludeQueries: [],
          location: "Москва",
          radiusKm: 15,
          services: [],
        }),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    const unsafeLead = result.leads.find((lead) => lead.id === "yandex-unsafe-site");
    const safeLead = result.leads.find((lead) => lead.id === "yandex-safe-site");
    assert.equal(unsafeLead.website.url, null);
    assert.equal(unsafeLead.website.sourceStatus, "not_listed");
    assert.equal(safeLead.website.url, "https://example.test/company");
    assert.equal(safeLead.website.sourceStatus, "listed");
    assert.equal(JSON.stringify(result).includes(fakeKey), false);
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

  const invalidCenterResponse = await worker.fetch(
    new Request("http://localhost/api/search?stream=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        primaryQuery: "Склад",
        location: "Москва",
        center: [181, 91],
      }),
    }),
    runtimeEnv,
    runtimeContext,
  );
  assert.equal(invalidCenterResponse.status, 400);
  assert.match(
    invalidCenterResponse.headers.get("content-type") ?? "",
    /^application\/x-ndjson\b/i,
  );
  const invalidCenterEvent = JSON.parse(await invalidCenterResponse.text());
  assert.equal(invalidCenterEvent.type, "error");
  assert.equal(invalidCenterEvent.code, "INVALID_SEARCH_PAYLOAD");
  assert.match(invalidCenterEvent.error, /долгота, широта/i);

  const incompatibleLocaleResponse = await worker.fetch(
    new Request("http://localhost/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        primaryQuery: "Барбершоп",
        location: "Алматы",
        locale: "ru-RU",
        countryCodes: ["KZ"],
      }),
    }),
    runtimeEnv,
    runtimeContext,
  );
  assert.equal(incompatibleLocaleResponse.status, 400);
  const incompatibleLocaleError = await incompatibleLocaleResponse.json();
  assert.equal(incompatibleLocaleError.code, "INVALID_SEARCH_PAYLOAD");
  assert.match(incompatibleLocaleError.error, /несовместима/i);

  const incompleteMetroResponse = await worker.fetch(
    new Request("http://localhost/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        primaryQuery: "Кофейня",
        location: "Москва",
        locationMode: "metro",
        metro: { systemId: "moscow" },
        radiusKm: 1.5,
      }),
    }),
    runtimeEnv,
    runtimeContext,
  );
  assert.equal(incompleteMetroResponse.status, 400);
  assert.match((await incompleteMetroResponse.json()).error, /конкретную станцию/i);

  const validMetroBase = {
    primaryQuery: "Кофейня",
    location: "Москва",
    locationMode: "metro",
    metro: {
      systemId: "moscow",
      stationId: "geoapify:belorusskaya",
      stationName: "Белорусская",
    },
    center: [37.5859, 55.7767],
    radiusKm: 1.5,
    locale: "ru-RU",
    countryCodes: ["RU"],
  };
  for (const [payload, errorPattern] of [
    [{ ...validMetroBase, radiusKm: 11 }, /0,5 до 10/i],
    [{ ...validMetroBase, center: [82.9204, 55.0302] }, /не соответствуют/i],
    [
      {
        ...validMetroBase,
        locale: "ru-KZ",
        countryCodes: ["KZ"],
      },
      /только для городов России/i,
    ],
    [
      {
        ...validMetroBase,
        metro: {
          ...validMetroBase.metro,
          stationId: "manual:belorusskaya",
        },
      },
      /серверного справочника/i,
    ],
  ]) {
    const invalidMetroResponse = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(invalidMetroResponse.status, 400);
    assert.match((await invalidMetroResponse.json()).error, errorPattern);
  }
});

test("search APIs expose a retryable error when Kimi is unavailable", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    QUERY_INTELLIGENCE_MODE: process.env.QUERY_INTELLIGENCE_MODE,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    KIMI_API_KEY: process.env.KIMI_API_KEY,
    KIMI_MODEL: process.env.KIMI_MODEL,
  };

  process.env.QUERY_INTELLIGENCE_MODE = "kimi";
  process.env.MOONSHOT_API_KEY = "fake-kimi-test-key";
  delete process.env.KIMI_API_KEY;
  process.env.KIMI_MODEL = "kimi-k3";
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    assert.equal(url.hostname, "api.moonshot.ai");
    return Response.json(
      { error: { message: "rate limited" } },
      { status: 429 },
    );
  };

  const payload = {
    primaryQuery: "привести бороду в порядок",
    location: "Москва",
    locale: "ru-RU",
    countryCodes: ["RU"],
  };

  try {
    const worker = await getWorker();
    const planResponse = await worker.fetch(
      new Request("http://localhost/api/search/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(planResponse.status, 503);
    const planFailure = await planResponse.json();
    assert.equal(planFailure.code, "SEARCH_PLANNER_UNAVAILABLE");
    assert.equal(planFailure.plan.status, "unsupported");
    assert.ok(planFailure.plan.resolution.reasonCodes.includes("KIMI_UNAVAILABLE"));

    const searchResponse = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(searchResponse.status, 503);
    const searchFailure = await searchResponse.json();
    assert.equal(searchFailure.code, "SEARCH_PLANNER_UNAVAILABLE");
    assert.equal(searchFailure.plan.status, "unsupported");
    assert.equal(JSON.stringify(searchFailure).includes("fake-kimi-test-key"), false);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("search plan encodes an unseen business intent without canonical candidates", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    QUERY_INTELLIGENCE_MODE: process.env.QUERY_INTELLIGENCE_MODE,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    KIMI_API_KEY: process.env.KIMI_API_KEY,
    KIMI_MODEL: process.env.KIMI_MODEL,
  };
  let capturedRequest = null;
  const semanticIntent = {
    schemaVersion: "2.2",
    normalizedGoal: "найти спортивные залы и фитнес-клубы",
    entityKind: "physical_business",
    physicalLocationRequirement: "required",
    industries: ["фитнес", "спорт"],
    coreBusinessTypes: ["фитнес-клуб", "тренажёрный зал"],
    adjacentBusinessTypes: ["спортивный клуб"],
    excludedBusinessTypes: ["магазин спортивных товаров"],
    productsAndServices: ["фитнес-тренировки", "тренажёрный зал"],
    includeSignals: ["спортзал", "фитнес-клуб", "тренажёрный зал"],
    excludeSignals: ["интернет-магазин"],
    retrievalTerms: {
      precision: ["фитнес-клуб", "тренажёрный зал", "sports hall", "gym", "fitness centre"],
      recall: ["спортзал", "спортивный зал", "fitness", "sport club"],
      exclude: ["магазин спортивных товаров", "sporting goods store"],
    },
    brandSearch: "include",
    confidence: "high",
    ambiguity: {
      isAmbiguous: false,
      reason: null,
      clarificationQuestion: null,
    },
  };

  process.env.QUERY_INTELLIGENCE_MODE = "kimi";
  process.env.MOONSHOT_API_KEY = "fake-kimi-open-vocabulary-key";
  delete process.env.KIMI_API_KEY;
  process.env.KIMI_MODEL = "kimi-k3";
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    assert.equal(url.hostname, "api.moonshot.ai");
    assert.equal(url.pathname, "/v1/chat/completions");
    capturedRequest = JSON.parse(String(init?.body));
    const serializedRequest = JSON.stringify(capturedRequest);
    for (const forbidden of [
      '"candidates"',
      '"candidateMode"',
      '"conceptId"',
      "food.restaurant",
      "logistics.fulfillment",
      "sport.fitness.gym",
    ]) {
      assert.equal(serializedRequest.includes(forbidden), false, forbidden);
    }
    const userMessage = capturedRequest.messages.find(
      (message) => message.role === "user",
    );
    const modelInput = JSON.parse(userMessage.content);
    assert.deepEqual(Object.keys(modelInput).sort(), [
      "countryCodes",
      "description",
      "excludeQueries",
      "locale",
      "primaryQuery",
      "relatedQueries",
    ]);
    assert.equal(Object.hasOwn(modelInput, "location"), false);
    assert.equal(Object.hasOwn(modelInput, "center"), false);
    const responseSchema = capturedRequest.response_format.json_schema.schema;
    assert.equal(capturedRequest.response_format.type, "json_schema");
    assert.equal(capturedRequest.response_format.json_schema.strict, true);
    assert.equal(responseSchema.additionalProperties, false);
    assert.deepEqual(responseSchema.properties.schemaVersion, {
      type: "string",
      enum: ["2.2"],
    });
    assert.deepEqual(responseSchema.properties.coreBusinessTypes, {
      type: "array",
      items: { type: "string" },
    });
    assert.ok(responseSchema.required.includes("providerNeutralCategoryHeads"));
    assert.equal(Object.hasOwn(responseSchema, "definitions"), false);
    const events = [
      {
        model: "kimi-k3",
        choices: [{
          index: 0,
          delta: {
            content: JSON.stringify({
              ...semanticIntent,
              providerNeutralCategoryHeads: [
                "sports hall",
                "gym",
                "fitness centre",
              ],
            }),
          },
          finish_reason: null,
        }],
      },
      {
        model: "kimi-k3",
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "stop",
          usage: { prompt_tokens: 420, completion_tokens: 180, total_tokens: 600 },
        }],
      },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`);
    events.push("data: [DONE]\n\n");
    return new Response(events.join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    });
  };

  try {
    const worker = await getWorker();
    const response = await worker.fetch(
      new Request("http://localhost/api/search/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: "Спортзалы для open-world end-to-end проверки",
          primaryQuery: "Спортивный зал",
          relatedQueries: ["Фитнес-клуб"],
          excludeQueries: ["Магазины спорттоваров"],
          locale: "ru-RU",
          countryCodes: ["RU"],
          location: "Москва",
          center: [37.6176, 55.7558],
        }),
      }),
      runtimeEnv,
      runtimeContext,
    );

    assert.equal(response.status, 200);
    assert.ok(capturedRequest);
    const plan = await response.json();
    assert.equal(plan.schemaVersion, "2.2");
    assert.equal(plan.semanticIntent.schemaVersion, "2.2");
    assert.equal(plan.semanticIntent.normalizedGoal, semanticIntent.normalizedGoal);
    assert.deepEqual(plan.semanticIntent.coreBusinessTypes, semanticIntent.coreBusinessTypes);
    assert.deepEqual(plan.semanticIntent.adjacentBusinessTypes, semanticIntent.adjacentBusinessTypes);
    assert.deepEqual(plan.semanticIntent.excludedBusinessTypes, semanticIntent.excludedBusinessTypes);
    assert.equal(plan.confidence.intent, "high");
    assert.equal(plan.confidence.providerCoverage, "high");
    assert.equal(plan.status, "ready");
    assert.deepEqual(plan.resolution.selectedConceptIds, []);
    assert.ok(plan.executionPreview.categoryLabels.includes("sport.sports_hall"));
    assert.ok(plan.executionPreview.categoryLabels.includes("sport.fitness.gym"));
    assert.equal(plan.executionPreview.categoryLabels.includes("catering.restaurant"), false);
    assert.equal(plan.ai.used, true);
    assert.equal(plan.ai.modelId, "kimi-k3");
    assert.equal(plan.ai.inputTokens, 420);
    assert.equal(plan.ai.outputTokens, 180);
    assert.ok(plan.ai.latencyMs >= 0);
    assert.match(plan.promptVersion, /^semantic-intent-v2\//);
    assert.match(plan.requestCacheKey, /^[a-f0-9]{64}$/);
    assert.match(plan.planHash, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(plan).includes("fake-kimi-open-vocabulary-key"), false);
    assert.equal(JSON.stringify(plan).includes("37.6176"), false);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("sports intent executes Kimi to Geoapify through the real search seam", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    QUERY_INTELLIGENCE_MODE: process.env.QUERY_INTELLIGENCE_MODE,
    SEARCH_PROVIDER: process.env.SEARCH_PROVIDER,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    KIMI_API_KEY: process.env.KIMI_API_KEY,
    GEOAPIFY_API_KEY: process.env.GEOAPIFY_API_KEY,
    GEOAPIFY_DETAILS_LIMIT: process.env.GEOAPIFY_DETAILS_LIMIT,
  };
  const registry = JSON.parse(
    await readFile(
      new URL(
        "../lib/search-planner/catalogs/geoapify-categories.snapshot.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const allowedCategories = new Set(registry.categories);
  const requestedBatches = [];
  let fallbackCalls = 0;
  let kimiCalls = 0;
  const semanticIntent = {
    schemaVersion: "2.2",
    normalizedGoal: "найти спортивные залы, тренажёрные залы и фитнес-клубы",
    entityKind: "physical_business",
    physicalLocationRequirement: "required",
    industries: ["спорт", "фитнес"],
    coreBusinessTypes: ["спортивный зал", "тренажёрный зал", "фитнес-клуб"],
    adjacentBusinessTypes: ["спортивный клуб"],
    excludedBusinessTypes: ["магазин спортивных товаров"],
    productsAndServices: ["фитнес-тренировки"],
    includeSignals: ["спортзал", "фитнес-клуб"],
    excludeSignals: ["интернет-магазин"],
    retrievalTerms: {
      precision: ["sports hall", "gym", "fitness centre"],
      recall: ["fitness", "sport club"],
      exclude: ["sporting goods store"],
    },
    brandSearch: "include",
    confidence: "high",
    ambiguity: {
      isAmbiguous: false,
      reason: null,
      clarificationQuestion: null,
    },
  };

  process.env.QUERY_INTELLIGENCE_MODE = "kimi";
  process.env.SEARCH_PROVIDER = "geoapify";
  process.env.MOONSHOT_API_KEY = "fake-kimi-sports-key";
  delete process.env.KIMI_API_KEY;
  process.env.GEOAPIFY_API_KEY = "fake-geoapify-sports-key";
  process.env.GEOAPIFY_DETAILS_LIMIT = "0";
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "api.moonshot.ai") {
      kimiCalls += 1;
      const body = JSON.parse(String(init?.body));
      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes('"candidates"'), false);
      assert.equal(serialized.includes("sport.fitness.gym"), false);
      return new Response(
        [
          `data: ${JSON.stringify({
            model: "kimi-k3",
            choices: [{
              index: 0,
              delta: {
                content: JSON.stringify({
                  ...semanticIntent,
                  providerNeutralCategoryHeads: [
                    "sports hall",
                    "gym",
                    "fitness centre",
                  ],
                }),
              },
              finish_reason: null,
            }],
          })}\n\n`,
          `data: ${JSON.stringify({
            model: "kimi-k3",
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop",
              usage: { prompt_tokens: 500, completion_tokens: 250, total_tokens: 750 },
            }],
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    assert.equal(url.hostname, "api.geoapify.com");
    if (url.pathname === "/v1/geocode/search") {
      fallbackCalls += 1;
      return Response.json({ type: "FeatureCollection", features: [] });
    }
    assert.equal(url.pathname, "/v2/places");
    const categories = (url.searchParams.get("categories") ?? "")
      .split(",")
      .filter(Boolean);
    requestedBatches.push(categories);
    assert.ok(categories.length > 0 && categories.length <= 8);
    assert.ok(categories.every((categoryId) => allowedCategories.has(categoryId)));
    assert.equal(categories.includes("catering.restaurant"), false);
    return Response.json({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {
          place_id: "sports-place-1",
          name: "Фитнес Арена",
          country_code: "ru",
          city: "Москва",
          formatted: "Фитнес Арена, Москва, Россия",
          categories: ["sport.fitness.gym"],
          lon: 37.62,
          lat: 55.76,
        },
        geometry: { type: "Point", coordinates: [37.62, 55.76] },
      }],
    });
  };

  try {
    const worker = await getWorker();
    const response = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: "Спортзалы",
          primaryQuery: "Спортивный зал",
          relatedQueries: ["Фитнес-клуб"],
          excludeQueries: ["Магазины спорттоваров"],
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
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.mode, "geoapify");
    assert.equal(result.plan.status, "ready");
    assert.deepEqual(result.plan.resolution.selectedConceptIds, []);
    assert.ok(result.plan.executionPreview.categoryLabels.includes("sport.sports_hall"));
    assert.equal(result.leads.length, 1);
    assert.equal(result.leads[0].name, "Фитнес Арена");
    assert.equal(kimiCalls, 1);
    assert.ok(requestedBatches.length >= 1 && requestedBatches.length <= 4);
    assert.ok(requestedBatches.flat().includes("sport.fitness.gym"));
    assert.equal(
      fallbackCalls,
      result.plan.executionPreview.retrievalArms.filter(
        (arm) => arm.type === "fallback",
      ).length,
    );
    assert.equal(
      result.plan.executionPreview.retrievalArms.length,
      requestedBatches.length + fallbackCalls,
    );
    assert.equal(
      result.leads[0].discovery.retrievalArms.length,
      requestedBatches.length,
    );
    assert.ok(
      result.leads[0].discovery.retrievalArms.some(
        (arm) => arm.role === "primary",
      ),
    );
    assert.equal(JSON.stringify(result).includes("fake-kimi-sports-key"), false);
    assert.equal(JSON.stringify(result).includes("fake-geoapify-sports-key"), false);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("known niche keeps its precise legacy categories when Kimi is unavailable", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    QUERY_INTELLIGENCE_MODE: process.env.QUERY_INTELLIGENCE_MODE,
    SEARCH_PROVIDER: process.env.SEARCH_PROVIDER,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    KIMI_API_KEY: process.env.KIMI_API_KEY,
    GEOAPIFY_API_KEY: process.env.GEOAPIFY_API_KEY,
    GEOAPIFY_DETAILS_LIMIT: process.env.GEOAPIFY_DETAILS_LIMIT,
  };
  const placesCalls = [];
  let kimiCalls = 0;
  process.env.QUERY_INTELLIGENCE_MODE = "kimi";
  process.env.SEARCH_PROVIDER = "geoapify";
  process.env.MOONSHOT_API_KEY = "fake-kimi-degraded-key";
  delete process.env.KIMI_API_KEY;
  process.env.GEOAPIFY_API_KEY = "fake-geoapify-degraded-key";
  process.env.GEOAPIFY_DETAILS_LIMIT = "0";
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "api.moonshot.ai") {
      kimiCalls += 1;
      return Response.json({ error: { message: "rate limited" } }, { status: 429 });
    }
    assert.equal(url.hostname, "api.geoapify.com");
    assert.equal(url.pathname, "/v2/places");
    placesCalls.push(url);
    return Response.json({ type: "FeatureCollection", features: [] });
  };

  try {
    const worker = await getWorker();
    const response = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: "degraded legacy regression 2026-08-17",
          primaryQuery: "Барбершоп",
          relatedQueries: [],
          excludeQueries: [],
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
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.plan.status, "degraded");
    assert.equal(result.plan.ai.validation, "failed");
    assert.deepEqual(result.plan.resolution.selectedConceptIds, [
      "personal_care.barbershop",
    ]);
    assert.equal(kimiCalls, 1);
    assert.equal(placesCalls.length, 1);
    assert.equal(
      placesCalls[0].searchParams.get("categories"),
      "service.beauty.hairdresser",
    );
    assert.equal(placesCalls[0].searchParams.has("name"), false);
    assert.equal(JSON.stringify(result).includes("fake-kimi-degraded-key"), false);
    assert.equal(JSON.stringify(result).includes("fake-geoapify-degraded-key"), false);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("warehouse semantic confirmation executes only the signed selected preview", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    QUERY_INTELLIGENCE_MODE: process.env.QUERY_INTELLIGENCE_MODE,
    SEARCH_PROVIDER: process.env.SEARCH_PROVIDER,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    KIMI_API_KEY: process.env.KIMI_API_KEY,
    GEOAPIFY_API_KEY: process.env.GEOAPIFY_API_KEY,
    GEOAPIFY_DETAILS_LIMIT: process.env.GEOAPIFY_DETAILS_LIMIT,
    SEARCH_PLAN_SIGNING_SECRET: process.env.SEARCH_PLAN_SIGNING_SECRET,
  };
  const signingSecret = "e2e-semantic-confirmation-secret-32-bytes";
  const placesCalls = [];
  const fallbackCalls = [];
  let kimiCalls = 0;
  process.env.QUERY_INTELLIGENCE_MODE = "kimi";
  process.env.SEARCH_PROVIDER = "geoapify";
  process.env.MOONSHOT_API_KEY = "fake-kimi-confirmation-key";
  delete process.env.KIMI_API_KEY;
  process.env.GEOAPIFY_API_KEY = "fake-geoapify-confirmation-key";
  process.env.GEOAPIFY_DETAILS_LIMIT = "0";
  process.env.SEARCH_PLAN_SIGNING_SECRET = signingSecret;
  const semanticIntent = {
    schemaVersion: "2.2",
    normalizedGoal: "найти складские организации",
    entityKind: "physical_business",
    physicalLocationRequirement: "required",
    industries: [],
    coreBusinessTypes: [],
    adjacentBusinessTypes: [],
    excludedBusinessTypes: [],
    productsAndServices: [],
    includeSignals: [],
    excludeSignals: [],
    retrievalTerms: {
      precision: [],
      recall: [],
      exclude: [],
    },
    brandSearch: "include",
    confidence: "medium",
    ambiguity: {
      isAmbiguous: true,
      reason: "Склад может означать хранение или обработку заказов",
      clarificationQuestion: "Нужны складские услуги или фулфилмент?",
    },
  };
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (url.hostname === "api.moonshot.ai") {
      kimiCalls += 1;
      return new Response(
        [
          `data: ${JSON.stringify({
            model: "kimi-k3",
            choices: [{
              index: 0,
              delta: {
                content: JSON.stringify({
                  ...semanticIntent,
                  providerNeutralCategoryHeads: [],
                }),
              },
              finish_reason: null,
            }],
          })}\n\n`,
          `data: ${JSON.stringify({
            model: "kimi-k3",
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "stop",
              usage: { prompt_tokens: 350, completion_tokens: 180, total_tokens: 530 },
            }],
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    assert.equal(url.hostname, "api.geoapify.com");
    if (url.pathname === "/v1/geocode/search") {
      fallbackCalls.push(url);
      return Response.json({ type: "FeatureCollection", features: [] });
    }
    assert.equal(url.pathname, "/v2/places");
    placesCalls.push(url);
    return Response.json({ type: "FeatureCollection", features: [] });
  };

  const input = {
    description: "warehouse semantic confirmation e2e",
    primaryQuery: "склад",
    relatedQueries: [],
    excludeQueries: [],
    location: "Москва",
    center: [37.6176, 55.7558],
    radiusKm: 5,
    services: [],
    locale: "ru-RU",
    countryCodes: ["RU"],
  };
  try {
    const worker = await getWorker();
    const planResponse = await worker.fetch(
      new Request("http://localhost/api/search/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(planResponse.status, 200);
    const plan = await planResponse.json();
    assert.equal(plan.status, "needs_confirmation");
    assert.equal(plan.schemaVersion, "2.2");
    assert.equal(plan.resolution.alternatives.length, 2);
    assert.equal(placesCalls.length, 0);
    assert.equal(kimiCalls, 1);
    const selected = plan.resolution.alternatives[0];

    const tamperedResponse = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...input,
          confirmationToken: plan.confirmation.token,
          confirmedAlternative: {
            alternativeId: selected.alternativeId,
            alternativeHash: selected.alternativeHash,
            semanticIntent: {
              ...selected.semanticIntent,
              normalizedGoal: `${selected.semanticIntent.normalizedGoal} подмена`,
            },
          },
        }),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(tamperedResponse.status, 409);
    assert.equal(placesCalls.length, 0);

    const nowSeconds = Math.floor(Date.now() / 1_000);
    const legacyToken = await signedLegacyV1Token(signingSecret, {
      requestCacheKey: plan.requestCacheKey,
      sourcePlanHash: plan.planHash,
      allowedConceptIds: ["logistics.warehouse"],
      taxonomyVersion: "legacy",
      providerCatalogVersion: plan.providerCatalogVersion,
      decisionPolicyVersion: "legacy",
      iat: nowSeconds,
      exp: nowSeconds + 600,
    });
    const legacyResponse = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...input,
          confirmationToken: legacyToken,
          confirmedConceptIds: ["logistics.warehouse"],
        }),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(legacyResponse.status, 409);
    assert.equal(placesCalls.length, 0);

    const searchResponse = await worker.fetch(
      new Request("http://localhost/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...input,
          confirmationToken: plan.confirmation.token,
          confirmedAlternative: {
            alternativeId: selected.alternativeId,
            alternativeHash: selected.alternativeHash,
            semanticIntent: selected.semanticIntent,
          },
        }),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(searchResponse.status, 200);
    const result = await searchResponse.json();
    assert.equal(result.plan.resolution.method, "user_confirmed");
    assert.equal(result.plan.parentPlanHash, plan.planHash);
    assert.deepEqual(result.plan.executionPreview, selected.executionPreview);
    assert.deepEqual(
      placesCalls.map((url) => url.searchParams.get("categories")),
      selected.executionPreview.retrievalArms
        .filter((arm) => !arm.usesNameFallback)
        .map((arm) => arm.categoryLabels.join(",")),
    );
    assert.equal(
      fallbackCalls.length,
      selected.executionPreview.retrievalArms.filter(
        (arm) => arm.usesNameFallback,
      ).length,
    );
    assert.equal(kimiCalls, 1, "confirmation must not re-run Kimi");

    const placesBeforeUnsignedPlan = placesCalls.length;
    delete process.env.SEARCH_PLAN_SIGNING_SECRET;
    const unsignedPlanResponse = await worker.fetch(
      new Request("http://localhost/api/search/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...input,
          description: "warehouse without signing capability",
        }),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(unsignedPlanResponse.status, 503);
    const unsignedFailure = await unsignedPlanResponse.json();
    assert.equal(unsignedFailure.code, "SEARCH_PLANNER_UNAVAILABLE");
    assert.equal(unsignedFailure.plan.status, "needs_confirmation");
    assert.equal(unsignedFailure.plan.confirmation.token, null);
    assert.equal(placesCalls.length, placesBeforeUnsignedPlan);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("SemanticIntentV2 executes through the production search orchestrator", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  const previousEnv = {
    QUERY_INTELLIGENCE_MODE: process.env.QUERY_INTELLIGENCE_MODE,
    SEARCH_PROVIDER: process.env.SEARCH_PROVIDER,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    KIMI_API_KEY: process.env.KIMI_API_KEY,
  };
  let kimiCalls = 0;
  process.env.QUERY_INTELLIGENCE_MODE = "kimi";
  process.env.SEARCH_PROVIDER = "demo";
  process.env.MOONSHOT_API_KEY = "fake-kimi-orchestrator-key";
  delete process.env.KIMI_API_KEY;
  globalThis.fetch = async (_input, init) => {
    kimiCalls += 1;
    const body = JSON.parse(String(init?.body));
    assert.equal(JSON.stringify(body).includes('"candidates"'), false);
    const encoded = {
      schemaVersion: "2.2",
      normalizedGoal: "найти барбершопы и мужские парикмахерские",
      entityKind: "physical_business",
      physicalLocationRequirement: "required",
      industries: ["уход за внешностью"],
      coreBusinessTypes: ["барбершоп"],
      adjacentBusinessTypes: ["мужская парикмахерская"],
      excludedBusinessTypes: ["груминг животных"],
      productsAndServices: ["стрижка бороды"],
      includeSignals: ["барбершоп", "стрижка бороды"],
      excludeSignals: ["груминг животных"],
      retrievalTerms: {
        precision: ["барбершоп", "hairdresser"],
        recall: ["мужская парикмахерская", "стрижка бороды", "barbershop"],
        exclude: ["груминг животных"],
      },
      brandSearch: "include",
      confidence: "high",
      ambiguity: {
        isAmbiguous: false,
        reason: null,
        clarificationQuestion: null,
      },
    };
    return new Response(
      [
        `data: ${JSON.stringify({
          model: "kimi-k3",
          choices: [{
            index: 0,
            delta: {
              content: JSON.stringify({
                ...encoded,
                providerNeutralCategoryHeads: ["hairdresser"],
              }),
            },
            finish_reason: null,
          }],
        })}\n\n`,
        `data: ${JSON.stringify({
          model: "kimi-k3",
          choices: [{
            index: 0,
            delta: {},
            finish_reason: "stop",
            usage: { prompt_tokens: 300, completion_tokens: 150, total_tokens: 450 },
          }],
        })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  };

  try {
    const worker = await getWorker();
    const response = await worker.fetch(
      new Request("http://localhost/api/search?stream=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          description: "Нужны места для ухода за бородой",
          primaryQuery: "где приводят бороду в порядок",
          excludeQueries: ["груминг животных"],
          location: "Москва",
          radiusKm: 5,
          locale: "ru-RU",
          countryCodes: ["RU"],
        }),
      }),
      runtimeEnv,
      runtimeContext,
    );
    assert.equal(response.status, 200);
    const records = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const result = records.find((record) => record.type === "result")?.data;
    assert.ok(result);
    assert.equal(result.mode, "demo");
    assert.equal(result.plan.schemaVersion, "2.2");
    assert.equal(result.plan.semanticIntent.coreBusinessTypes[0], "барбершоп");
    assert.equal(result.plan.ai.validation, "passed");
    assert.ok(records.some(
      (record) => record.type === "progress" && record.stage === "provider_compilation",
    ));
    assert.equal(kimiCalls, 1);
    assert.equal(JSON.stringify(result).includes("fake-kimi-orchestrator-key"), false);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
