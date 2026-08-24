import assert from "node:assert/strict";
import test from "node:test";

import { POST as geocode } from "../app/api/geocode/route.ts";
import { GET as metroStations } from "../app/api/metro-stations/route.ts";
import { externalMapTarget } from "../lib/provider-links.ts";
import { getRussianMetroSystem } from "../lib/metro.ts";
import { verifyTwoGisMetroStationSelection } from "../lib/providers/2gis-location.ts";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("2GIS mode routes address geocoding through the 2GIS Geocoder endpoint", { concurrency: false }, async () => {
  const previousProvider = process.env.SEARCH_PROVIDER;
  const previousKey = process.env.DGIS_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.SEARCH_PROVIDER = "2gis";
  process.env.DGIS_API_KEY = "test-geocoder-key";
  let upstreamUrl;
  globalThis.fetch = async (input) => {
    upstreamUrl = new URL(String(input));
    return jsonResponse({
      meta: { code: 200 },
      result: {
        total: 1,
        items: [{ point: { lon: 37.6176, lat: 55.7558 } }],
      },
    });
  };

  try {
    const response = await geocode(new Request("http://localhost/api/geocode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: "Москва, ул. Лесная, 7" }),
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      coordinates: [37.6176, 55.7558],
      location: "Москва, ул. Лесная, 7",
      provider: "2gis",
    });
    assert.equal(upstreamUrl.hostname, "catalog.api.2gis.com");
    assert.equal(upstreamUrl.pathname, "/3.0/items/geocode");
    assert.equal(upstreamUrl.searchParams.get("q"), "Москва, ул. Лесная, 7");
    assert.equal(upstreamUrl.searchParams.get("key"), "test-geocoder-key");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProvider === undefined) delete process.env.SEARCH_PROVIDER;
    else process.env.SEARCH_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.DGIS_API_KEY;
    else process.env.DGIS_API_KEY = previousKey;
  }
});

test("2GIS mode routes the metro directory through Places station.metro", { concurrency: false }, async () => {
  const previousProvider = process.env.SEARCH_PROVIDER;
  const previousKey = process.env.DGIS_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.SEARCH_PROVIDER = "2gis";
  process.env.DGIS_API_KEY = "test-metro-key";
  let upstreamUrl;
  globalThis.fetch = async (input) => {
    upstreamUrl = new URL(String(input));
    return jsonResponse({
      meta: { code: 200 },
      result: {
        total: 1,
        items: [{
          id: "station-1",
          type: "station.metro",
          name: "Площадь Ленина",
          point: { lon: 82.9146, lat: 55.0408 },
        }],
      },
    });
  };

  try {
    const response = await metroStations(
      new Request("http://localhost/api/metro-stations?city=novosibirsk"),
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.provider, "2gis");
    assert.deepEqual(body.attribution, ["2GIS"]);
    assert.equal(body.stations[0].id, "2gis:station-1");
    assert.equal(upstreamUrl.hostname, "catalog.api.2gis.com");
    assert.equal(upstreamUrl.pathname, "/3.0/items");
    assert.equal(upstreamUrl.searchParams.get("type"), "station.metro");
    assert.equal(upstreamUrl.searchParams.get("location"), "82.9204,55.0302");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProvider === undefined) delete process.env.SEARCH_PROVIDER;
    else process.env.SEARCH_PROVIDER = previousProvider;
    if (previousKey === undefined) delete process.env.DGIS_API_KEY;
    else process.env.DGIS_API_KEY = previousKey;
  }
});

test("2GIS metro selection is rechecked through the by-id endpoint", async () => {
  const system = getRussianMetroSystem("moscow");
  assert.ok(system);
  let upstreamUrl;
  const station = await verifyTwoGisMetroStationSelection(
    system,
    {
      stationId: "2gis:station-verified",
      stationName: "Белорусская",
      coordinates: [37.5859, 55.7767],
    },
    "test-details-key",
    {
      fetch: async (input) => {
        upstreamUrl = new URL(String(input));
        return jsonResponse({
          meta: { code: 200 },
          result: {
            total: 1,
            items: [{
              id: "station-verified",
              name: "Белорусская",
              point: { lon: 37.5859, lat: 55.7767 },
            }],
          },
        });
      },
    },
  );
  assert.equal(station.id, "2gis:station-verified");
  assert.equal(upstreamUrl.pathname, "/3.0/items/byid");
  assert.equal(upstreamUrl.searchParams.get("id"), "station-verified");
});

test("2GIS lead details open the matching 2GIS firm instead of OpenStreetMap", () => {
  const target = externalMapTarget({
    providerId: "2gis",
    discoverySource: "2gis",
    name: "Тестовая компания",
    address: "Москва",
    coordinates: [37.6176, 55.7558],
    sources: [{ provider: "2gis", externalId: "70000001012345678" }],
  });
  assert.deepEqual(target, {
    href: "https://2gis.ru/firm/70000001012345678",
    label: "Открыть в 2GIS",
  });
});
