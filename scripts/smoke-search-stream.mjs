const baseUrl = process.env.LEAD_RADAR_BASE_URL?.trim() || "http://127.0.0.1:3000";
const primaryQuery =
  process.env.SMOKE_SEARCH_QUERY?.trim() || "место где приводят бороду в порядок";
const center = [37.6173, 55.7558];

const response = await fetch(`${baseUrl}/api/search?stream=1`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    description: primaryQuery,
    primaryQuery,
    relatedQueries: [],
    excludeQueries: [],
    location: "Москва",
    center,
    radiusKm: 3,
    services: ["Создание сайта", "Внедрение CRM"],
    locale: "ru-RU",
    countryCodes: ["RU"],
  }),
});

if (!response.body) {
  throw new Error(`Search stream is unavailable (HTTP ${response.status})`);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
const stages = [];
let terminal = null;

function acceptLine(line) {
  if (!line.trim()) return;
  const record = JSON.parse(line);
  if (record.type === "progress") stages.push(record.stage);
  if (record.type === "result" || record.type === "error") {
    if (terminal) throw new Error("Search stream returned more than one terminal event");
    terminal = record;
  }
}

while (true) {
  const { value, done } = await reader.read();
  buffer += decoder.decode(value, { stream: !done });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) acceptLine(line);
  if (done) break;
}
if (buffer.trim()) acceptLine(buffer);
if (!terminal) throw new Error("Search stream ended without a terminal event");

if (terminal.type === "error") {
  process.stdout.write(
    `${JSON.stringify({
      decision: "FAIL",
      httpStatus: response.status,
      terminal: "error",
      code: terminal.code ?? null,
      planStatus: terminal.plan?.status ?? null,
      progressStages: [...new Set(stages)],
    })}\n`,
  );
  process.exitCode = 1;
} else {
  const data = terminal.data;
  process.stdout.write(
    `${JSON.stringify({
      decision: "PASS",
      httpStatus: response.status,
      terminal: "result",
      progressStages: [...new Set(stages)],
      conceptIds: data.plan?.resolution?.selectedConceptIds ?? [],
      plannerMethod: data.plan?.resolution?.method ?? null,
      kimiUsed: data.plan?.ai?.used ?? false,
      plannerCacheHit: data.plan?.ai?.cacheHit ?? false,
      provider: data.provider?.id ?? data.mode,
      cardsFound: data.summary?.cardsFound ?? null,
      leadCount: Array.isArray(data.leads) ? data.leads.length : null,
      withWebsite: Array.isArray(data.leads)
        ? data.leads.filter((lead) => lead.website?.sourceStatus === "listed").length
        : null,
      withPhone: Array.isArray(data.leads)
        ? data.leads.filter((lead) => Boolean(lead.phone)).length
        : null,
      rawResponsesStored: data.provider?.policy?.rawResponsesStored ?? null,
    })}\n`,
  );
}
