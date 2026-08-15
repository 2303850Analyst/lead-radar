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
  assert.match(html, /Официальный API/);
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
  assert.equal(health.yandexConfigured, false);
  assert.equal(health.yandexLiveUiEnabled, false);
  const packageMetadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageMetadata.name, "lead-radar");
  assert.equal(health.version, packageMetadata.version);
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
