import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import {
  GEOAPIFY_CAPABILITY_REGISTRY,
  GEOAPIFY_COMPILER_POLICY_VERSION,
} from "../lib/search-planner/catalogs/geoapify.ts";
import {
  DECISION_POLICY_VERSION,
  KIMI_PROMPT_CONTENT_VERSION,
} from "../lib/search-planner/planner.ts";
import {
  KIMI_MODEL_POLICY_VERSION,
  KIMI_TRANSPORT_SCHEMA_VERSION,
} from "../lib/search-planner/kimi-client.ts";
import {
  SEARCH_PLAN_SCHEMA_VERSION,
  SEMANTIC_INTENT_SCHEMA_VERSION,
} from "../lib/search-planner/types.ts";
import {
  SEARCH_CANARY_CASES,
  SEARCH_CANARY_RUBRIC,
  collectGeoapifyProviderFacts,
  countGeoapifyProviderFactViolations,
  isRetryableSearchCanaryCode,
  readBoundedJsonResponse,
  runCanaryAttemptWithWatchdog,
  summarizeSearchCanary,
  validateSearchCanaryCoverage,
} from "./lib/search-live-canary.mjs";
import {
  currentSearchCanaryArtifactFingerprints,
  SEARCH_CANARY_PRODUCTION_BUNDLE_URL,
} from "./lib/search-canary-artifacts.mjs";
import {
  applySearchCanaryKimiProfileToEnv,
  resolveSearchCanaryKimiProfile,
  searchCanaryRuntimeProfile,
} from "./lib/search-canary-profile.mjs";

if (process.env.RUN_SEARCH_LIVE_CANARY !== "1") {
  process.stdout.write(
    "Production search live canary skipped. Set RUN_SEARCH_LIVE_CANARY=1 explicitly.\n",
  );
  process.exit(0);
}

const kimiKey = process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY;
const geoapifyKey = process.env.GEOAPIFY_API_KEY;
if (!kimiKey || !geoapifyKey) {
  throw new Error("Server-side Kimi and Geoapify API keys are required");
}

process.env.QUERY_INTELLIGENCE_MODE = "kimi";
process.env.SEARCH_PROVIDER = "geoapify";
process.env.KIMI_REQUEST_TIMEOUT_MS = "45000";
process.env.GEOAPIFY_PLACES_LIMIT = "20";
process.env.GEOAPIFY_DETAILS_LIMIT = "3";
process.env.GEOAPIFY_CATEGORY_HINTS_ENABLED = "true";
process.env.KIMI_LEAD_CLASSIFICATION_ENABLED = "0";
process.env.KIMI_BASE_URL = "https://api.moonshot.ai/v1";
const canaryProfile = resolveSearchCanaryKimiProfile(
  process.env.SEARCH_CANARY_KIMI_PROFILE,
);
process.env.SEARCH_CANARY_KIMI_PROFILE = canaryProfile.id;
applySearchCanaryKimiProfileToEnv(canaryProfile, process.env);
process.env.KIMI_MIN_START_INTERVAL_MS = "20000";
process.env.KIMI_ADMISSION_TIMEOUT_MS = "20000";
process.env.KIMI_CIRCUIT_FAILURE_THRESHOLD = "3";
process.env.SEARCH_REQUEST_DEADLINE_MS = "60000";
const factObserverChannel = randomBytes(32).toString("hex");
process.env.SEARCH_CANARY_FACT_OBSERVER_CHANNEL = factObserverChannel;
const factObserverSymbol = Symbol.for(
  `lead-radar.geoapify-canary-fact-observer.v1.${factObserverChannel}`,
);

const REVIEW_LIMIT = 10;
const MANUAL_WAIT_MS = 10 * 60 * 1_000;
const REVIEW_PORT = Number(process.env.CANARY_REVIEW_PORT ?? 32_123);
const reviewCapability = randomBytes(24).toString("hex");
const identitySalt = randomBytes(32);
const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

const { productionBundleSha256, canaryHarnessSha256 } =
  await currentSearchCanaryArtifactFingerprints();

validateSearchCanaryCoverage(SEARCH_CANARY_CASES);

const workerUrl = new URL(SEARCH_CANARY_PRODUCTION_BUNDLE_URL);
workerUrl.searchParams.set("search-canary", `${process.pid}-${Date.now()}`);
const { default: worker } = await import(workerUrl.href);
const runtimeEnv = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const runtimeContext = {
  waitUntil() {},
  passThroughOnException() {},
};

function safeText(value, maximum = 100) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}|]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function identityHash(externalId) {
  return createHmac("sha256", identitySalt)
    .update(`geoapify\0${safeText(externalId, 500)}`)
    .digest("hex");
}

function haversineKm(left, right) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const [leftLon, leftLat] = left;
  const [rightLon, rightLat] = right;
  const latitudeDelta = radians(rightLat - leftLat);
  const longitudeDelta = radians(rightLon - leftLon);
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(leftLat)) *
      Math.cos(radians(rightLat)) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function controlledError(code, diagnostics = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, diagnostics);
  return error;
}

async function runProductionSearchAttempt(entry, signal) {
  const startedAt = Date.now();
  const providerFacts = new Map();
  const previousObserver = globalThis[factObserverSymbol];
  globalThis[factObserverSymbol] = (facts) => {
    collectGeoapifyProviderFacts(providerFacts, facts);
  };
  try {
    const response = await worker.fetch(
    new Request("http://localhost/api/search?stream=1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        description: entry.description,
        primaryQuery: entry.query,
        relatedQueries: entry.relatedQueries,
        excludeQueries: entry.excludeQueries,
        location: entry.city,
        locationMode: "radius",
        center: entry.center,
        radiusKm: entry.radiusKm,
        services: [],
        locale: entry.locale,
        countryCodes: [entry.countryCode],
      }),
    }),
    runtimeEnv,
    runtimeContext,
  );
    if (!response.body) throw controlledError("CANARY_EMPTY_STREAM");
    const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let firstProgressMs = null;
  let result = null;
  let terminalError = null;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw controlledError("CANARY_INVALID_NDJSON");
      }
      if (event.type === "progress" && firstProgressMs === null) {
        firstProgressMs = Date.now() - startedAt;
      } else if (event.type === "result") {
        result = event.data;
      } else if (event.type === "error") {
        terminalError = event.code ?? "CANARY_SEARCH_ERROR";
      }
    }
    if (done) break;
  }
  if (!response.ok || terminalError || !result) {
    throw controlledError(
      terminalError ?? `CANARY_HTTP_${response.status}`,
      {
        firstProgressMs: firstProgressMs ?? Date.now() - startedAt,
        terminalMs: Date.now() - startedAt,
      },
    );
  }
    return {
      payload: result,
      providerFacts,
      firstProgressMs: firstProgressMs ?? Date.now() - startedAt,
      terminalMs: Date.now() - startedAt,
    };
  } finally {
    if (previousObserver === undefined) {
      delete globalThis[factObserverSymbol];
    } else {
      globalThis[factObserverSymbol] = previousObserver;
    }
  }
}

async function runProductionSearch(entry) {
  const controller = new AbortController();
  return runCanaryAttemptWithWatchdog(
    runProductionSearchAttempt(entry, controller.signal),
    controller,
  );
}

async function runLiteralBaseline(entry) {
  const url = new URL("https://api.geoapify.com/v1/geocode/search");
  url.searchParams.set(
    "text",
    `${entry.literalBaselineQuery}, ${entry.city}`,
  );
  url.searchParams.set("type", "amenity");
  url.searchParams.set(
    "filter",
    `circle:${entry.center[0]},${entry.center[1]},${Math.round(entry.radiusKm * 1_000)}`,
  );
  url.searchParams.set("bias", `proximity:${entry.center[0]},${entry.center[1]}`);
  url.searchParams.set("lang", entry.locale.slice(0, 2));
  url.searchParams.set("limit", String(REVIEW_LIMIT));
  url.searchParams.set("apiKey", geoapifyKey);
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw controlledError("CANARY_BASELINE_NETWORK_ERROR");
  }
  if (!response.ok) {
    throw controlledError(`CANARY_BASELINE_HTTP_${response.status}`);
  }
  let payload;
  try {
    payload = await readBoundedJsonResponse(response, 1024 * 1024);
  } catch {
    throw controlledError("CANARY_BASELINE_INVALID_JSON");
  }
  if (!Array.isArray(payload?.features)) {
    throw controlledError("CANARY_BASELINE_INVALID_RESPONSE");
  }
  const seen = new Set();
  return payload.features.flatMap((feature) => {
    const properties = feature?.properties;
    const coordinates = feature?.geometry?.coordinates;
    const name = safeText(properties?.name);
    if (
      !properties ||
      !name ||
      properties.country_code?.toUpperCase() !== entry.countryCode ||
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      !coordinates.slice(0, 2).every(Number.isFinite) ||
      haversineKm(entry.center, coordinates.slice(0, 2)) > entry.radiusKm + 0.25
    ) {
      return [];
    }
    const externalId = safeText(
      properties.place_id ??
        feature.id ??
        `${name}-${coordinates.slice(0, 2).join(",")}`,
      300,
    );
    if (seen.has(externalId)) return [];
    seen.add(externalId);
    return [{
      name,
      category: safeText(
        Array.isArray(properties.categories)
          ? properties.categories.slice(0, 3).join(", ")
          : "",
      ),
      coordinates: coordinates.slice(0, 2),
      identityHashes: [identityHash(externalId)],
    }];
  })
    .slice(0, REVIEW_LIMIT)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function reviewCandidates(leads) {
  return leads
    .slice(0, REVIEW_LIMIT)
    .map((lead, index) => {
      const externalIds = (lead.sources ?? [])
        .filter((source) => source?.provider === "geoapify")
        .map((source) => safeText(source.externalId, 500))
        .filter(Boolean)
        .sort();
      if (!externalIds.length) externalIds.push(safeText(lead.id, 500));
      return {
        rank: index + 1,
        name: safeText(lead.name),
        category: safeText(lead.category),
        relevance: safeText(lead.relevance?.status ?? "not_checked", 20),
        categoryEvidence: [
          ...new Set(
            (lead.relevance?.evidence ?? [])
              .filter((fact) => fact?.field === "providerCategoryIds")
              .map((fact) => safeText(fact.value, 100))
              .filter(Boolean),
          ),
        ].slice(0, 6),
        identityHashes: [...new Set(externalIds.map(identityHash))],
      };
    });
}

function publicReviewCandidates(candidates) {
  return candidates.map((candidate) => {
    const publicCandidate = { ...candidate };
    delete publicCandidate.identityHashes;
    return publicCandidate;
  });
}

const startedAt = new Date();
const sessionId = startedAt.toISOString().replace(/[:.]/g, "-");
const runtimeRecords = [];
const reviewPacket = [];
const reviewIdentityPacket = new Map();
for (let index = 0; index < SEARCH_CANARY_CASES.length; index += 1) {
  const entry = SEARCH_CANARY_CASES[index];
  const semanticJourneyStartedAt = Date.now();
  process.stdout.write(
    `\nCANARY ${index + 1}/${SEARCH_CANARY_CASES.length} ${entry.id} started\n`,
  );
  let search = null;
  let baseline = [];
  let semanticSucceeded = false;
  let baselineSucceeded = false;
  let errorCode = null;
  let attemptCount = 0;
  let firstAttemptSucceeded = false;
  const failedAttemptCodes = [];
  const attemptTimings = [];
  let lastFailureDiagnostics = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    attemptCount = attempt;
    const attemptStartedAt = Date.now();
    try {
      search = await runProductionSearch(entry);
      attemptTimings.push({
        succeeded: true,
        firstProgressMs: search.firstProgressMs,
        encoderMs: search.payload?.plan?.ai?.latencyMs ?? null,
        terminalMs: search.terminalMs,
      });
      semanticSucceeded = true;
      firstAttemptSucceeded = attempt === 1;
      errorCode = null;
      break;
    } catch (error) {
      errorCode = error?.code ?? "CANARY_UNCLASSIFIED_SEARCH_ERROR";
      if (errorCode === "CANARY_ATTEMPT_DID_NOT_SETTLE") throw error;
      failedAttemptCodes.push(errorCode);
      lastFailureDiagnostics = {
        firstProgressMs: Number.isFinite(error?.firstProgressMs)
          ? error.firstProgressMs
          : null,
        terminalMs: Number.isFinite(error?.terminalMs)
          ? error.terminalMs
          : Date.now() - attemptStartedAt,
      };
      attemptTimings.push({
        succeeded: false,
        firstProgressMs: lastFailureDiagnostics.firstProgressMs,
        encoderMs: null,
        terminalMs: lastFailureDiagnostics.terminalMs,
      });
      if (attempt === 2 || !isRetryableSearchCanaryCode(errorCode)) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  const semanticJourneyMs = Date.now() - semanticJourneyStartedAt;
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    baseline = await runLiteralBaseline(entry);
    baselineSucceeded = true;
  } catch (error) {
    errorCode ??= error?.code ?? "CANARY_UNCLASSIFIED_BASELINE_ERROR";
  }

  const payload = search?.payload;
  const plan = payload?.plan;
  const leads = Array.isArray(payload?.leads) ? payload.leads : [];
  const semantic = reviewCandidates(leads);
  const geographyLeaks = leads.filter(
    (lead) =>
      !Array.isArray(lead.location?.coordinates) ||
      lead.location.coordinates.length !== 2 ||
      !lead.location.coordinates.every(Number.isFinite) ||
      haversineKm(entry.center, lead.location.coordinates) > entry.radiusKm + 0.25,
  ).length;
  const serialized = payload ? JSON.stringify(payload) : "";
  const secretLeaks =
    Number(Boolean(kimiKey && serialized.includes(kimiKey))) +
    Number(Boolean(geoapifyKey && serialized.includes(geoapifyKey)));
  const record = {
    id: entry.id,
    semanticSucceeded,
    baselineSucceeded,
    kimiUsed: plan?.ai?.used === true,
    schemaPassed: plan?.ai?.validation === "passed",
    executablePlan:
      plan?.status === "ready" &&
      Boolean(plan.executionPreview?.retrievalArms?.length),
    firstProgressMs:
      search?.firstProgressMs ?? lastFailureDiagnostics?.firstProgressMs ?? 60_001,
    encoderMs: plan?.ai?.latencyMs ?? 60_001,
    terminalMs:
      search?.terminalMs ?? lastFailureDiagnostics?.terminalMs ?? 60_001,
    inputTokens: plan?.ai?.inputTokens ?? 0,
    outputTokens: plan?.ai?.outputTokens ?? 0,
    usageReported:
      typeof plan?.ai?.inputTokens === "number" &&
      typeof plan?.ai?.outputTokens === "number",
    geographyLeaks,
    secretLeaks,
    inventedFactViolations: countGeoapifyProviderFactViolations(
      leads,
      search?.providerFacts ?? new Map(),
    ),
    rawResponsesStored: payload
      ? payload.provider?.policy?.rawResponsesStored !== false
      : false,
    categoryResolutionStatus:
      payload?.provider?.coverage?.categoryResolution?.status ?? "unreported",
    categoryResolutionRequests:
      payload?.provider?.coverage?.categoryResolution?.requests ?? 0,
    attemptCount,
    firstAttemptSucceeded,
    failedAttemptCodes,
    attemptTimings,
    semanticJourneyMs,
    semanticCandidateCount: semantic.length,
    baselineCandidateCount: baseline.length,
    semanticReviewed: semantic.length,
    semanticRelevant: 0,
    semanticRelevantIdentityGroups: [],
    baselineReviewed: baseline.length,
    baselineRelevant: 0,
    baselineRelevantIdentityGroups: [],
    modelId: plan?.ai?.modelId ?? null,
    promptVersion: plan?.promptVersion ?? null,
    errorCode,
  };
  runtimeRecords.push(record);
  reviewPacket.push({
    id: entry.id,
    city: entry.city,
    query: entry.query,
    intent: {
      description: entry.description,
      relatedQueries: entry.relatedQueries,
      excludeQueries: entry.excludeQueries,
    },
    semantic: publicReviewCandidates(semantic),
    baseline: publicReviewCandidates(baseline),
    diagnostics: {
      semanticSucceeded,
      baselineSucceeded,
      kimiUsed: record.kimiUsed,
      schemaPassed: record.schemaPassed,
      executablePlan: record.executablePlan,
      firstProgressMs: record.firstProgressMs,
      encoderMs: record.encoderMs,
      terminalMs: record.terminalMs,
      errorCode,
      attemptCount,
      firstAttemptSucceeded,
      failedAttemptCodes,
    },
  });
  reviewIdentityPacket.set(entry.id, { semantic, baseline });
  process.stdout.write(
    `CASE_AGGREGATE ${JSON.stringify({
      id: entry.id,
      semanticCandidates: semantic.length,
      baselineCandidates: baseline.length,
      kimiUsed: record.kimiUsed,
      schemaPassed: record.schemaPassed,
      executablePlan: record.executablePlan,
      firstProgressMs: record.firstProgressMs,
      encoderMs: record.encoderMs,
      terminalMs: record.terminalMs,
      errorCode,
      attemptCount,
      failedAttemptCodes,
      categoryResolutionStatus: record.categoryResolutionStatus,
      categoryResolutionRequests: record.categoryResolutionRequests,
    })}\n`,
  );
}

const outputDirectory = new URL("../work/evaluations/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
const manualTemplate = {
  sessionId,
  cases: Object.fromEntries(
    runtimeRecords.map((record) => [
      record.id,
      { semanticRelevantRanks: [], baselineRelevantRanks: [] },
    ]),
  ),
};
process.stdout.write(
  `\nMANUAL_REVIEW_REQUIRED\nMANUAL_REVIEW_URL=http://127.0.0.1:${REVIEW_PORT}/review/${reviewCapability}\n` +
    `MANUAL_REVIEW_TEMPLATE=${JSON.stringify(manualTemplate)}\n` +
    `Open the URL, apply its rubric, then POST the completed template to http://127.0.0.1:${REVIEW_PORT}/submit/${reviewCapability}. ` +
    "Candidate data is never written to disk.\n",
);

function validateManualReviewSubmission(value) {
  if (
    value?.sessionId !== sessionId ||
    !value.cases ||
    typeof value.cases !== "object" ||
    Object.keys(value.cases).length !== runtimeRecords.length
  ) {
    return false;
  }
  return runtimeRecords.every((record) => {
    const review = value.cases[record.id];
    const semanticRanks = review?.semanticRelevantRanks;
    const baselineRanks = review?.baselineRelevantRanks;
    return (
      review &&
      Array.isArray(semanticRanks) &&
      Array.isArray(baselineRanks) &&
      new Set(semanticRanks).size === semanticRanks.length &&
      new Set(baselineRanks).size === baselineRanks.length &&
      semanticRanks.every(
        (rank) =>
          Number.isInteger(rank) &&
          rank >= 1 &&
          rank <= record.semanticCandidateCount,
      ) &&
      baselineRanks.every(
        (rank) =>
          Number.isInteger(rank) &&
          rank >= 1 &&
          rank <= record.baselineCandidateCount,
      )
    );
  });
}

const manualReview = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    server.close();
    reject(new Error("Manual review timed out"));
  }, MANUAL_WAIT_MS);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${REVIEW_PORT}`);
    if (
      request.method === "GET" &&
      url.pathname === `/review/${reviewCapability}`
    ) {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({
        sessionId,
        rubric: SEARCH_CANARY_RUBRIC,
        submission: manualTemplate,
        cases: reviewPacket,
      }));
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === `/submit/${reviewCapability}`
    ) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65_536) request.destroy();
      });
      request.on("end", () => {
        try {
          const value = JSON.parse(body);
          if (!validateManualReviewSubmission(value)) {
            throw new Error("INVALID_REVIEW");
          }
          response.writeHead(202, { "content-type": "application/json" });
          response.end('{"accepted":true}');
          clearTimeout(timeout);
          server.close();
          resolve(value);
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end('{"error":"INVALID_REVIEW"}');
        }
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"NOT_FOUND"}');
  });
  server.on("error", (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  server.listen(REVIEW_PORT, "127.0.0.1");
});
for (const record of runtimeRecords) {
  const review = manualReview.cases[record.id];
  const packet = reviewPacket.find((entry) => entry.id === record.id);
  const identityPacket = reviewIdentityPacket.get(record.id);
  const semanticRanks = review?.semanticRelevantRanks;
  const baselineRanks = review?.baselineRelevantRanks;
  if (!review || !packet || !identityPacket) {
    throw new Error(`Missing validated manual review for ${record.id}`);
  }
  record.semanticRelevant = semanticRanks.length;
  record.baselineRelevant = baselineRanks.length;
  record.semanticRelevantIdentityGroups = semanticRanks.map(
    (rank) => identityPacket.semantic[rank - 1].identityHashes,
  );
  record.baselineRelevantIdentityGroups = baselineRanks.map(
    (rank) => identityPacket.baseline[rank - 1].identityHashes,
  );
}

const modelIds = [...new Set(runtimeRecords.map((record) => record.modelId).filter(Boolean))];
if (modelIds.length !== 1 || modelIds[0] !== canaryProfile.model) {
  throw new Error("Canary model identity does not match the selected server profile");
}
const effectivePromptVersion =
  `${KIMI_PROMPT_CONTENT_VERSION}+${canaryProfile.cacheIdentity}`;
const promptVersions = [
  ...new Set(runtimeRecords.map((record) => record.promptVersion).filter(Boolean)),
];
if (
  promptVersions.length !== 1 ||
  promptVersions[0] !== effectivePromptVersion
) {
  throw new Error("Canary prompt identity does not match the selected server profile");
}
const inputUsdPerMillion = canaryProfile.pricingUsdPerMillion.input;
const outputUsdPerMillion = canaryProfile.pricingUsdPerMillion.output;
const versions = {
  appVersion: packageMetadata.version,
  modelId: modelIds.length === 1 ? modelIds[0] : "mixed-or-unreported",
  modelPolicyVersion: KIMI_MODEL_POLICY_VERSION,
  transportSchemaVersion: KIMI_TRANSPORT_SCHEMA_VERSION,
  promptVersion: promptVersions[0],
  semanticIntentSchemaVersion: SEMANTIC_INTENT_SCHEMA_VERSION,
  searchPlanSchemaVersion: SEARCH_PLAN_SCHEMA_VERSION,
  decisionPolicyVersion: DECISION_POLICY_VERSION,
  compilerPolicyVersion: GEOAPIFY_COMPILER_POLICY_VERSION,
  providerCatalogVersion: GEOAPIFY_CAPABILITY_REGISTRY.version,
  providerCatalogChecksum: GEOAPIFY_CAPABILITY_REGISTRY.checksum,
  productionBundleSha256,
  canaryHarnessSha256,
  runtimeProfile: searchCanaryRuntimeProfile(canaryProfile),
  inputUsdPerMillion,
  outputUsdPerMillion,
};
const report = summarizeSearchCanary(runtimeRecords, versions);
const finalReport = {
  ...report,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
};
const serializedReport = JSON.stringify(finalReport);
if (
  serializedReport.includes(kimiKey) ||
  serializedReport.includes(geoapifyKey) ||
  /\+\d[\d ()-]{8,}/.test(serializedReport) ||
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(serializedReport)
) {
  throw new Error("Aggregate report failed privacy validation");
}
const reportUrl = new URL(`search-live-canary-summary-${sessionId}.json`, outputDirectory);
await writeFile(reportUrl, `${JSON.stringify(finalReport, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
await new Promise((resolve) => process.stdout.write(
  `\n${JSON.stringify({
    decision: finalReport.decision,
    sampleCounts: finalReport.sampleCounts,
    metrics: finalReport.metrics,
    hardGates: finalReport.hardGates,
    sloObservations: finalReport.sloObservations,
    reportFile: reportUrl.pathname,
  }, null, 2)}\n`,
  resolve,
));
process.exit(finalReport.decision === "PASS" ? 0 : 1);
