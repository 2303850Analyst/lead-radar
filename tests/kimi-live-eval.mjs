import { mkdir, readFile, writeFile } from "node:fs/promises";

import { createKimiClientFromEnv } from "../lib/search-planner/kimi-client.ts";
import { createSearchPlan } from "../lib/search-planner/planner.ts";

import {
  assertAggregateOnly,
  percentile,
  ratio,
  roundMetric,
} from "./helpers/evaluation-metrics.mjs";

const enabled = process.env.RUN_KIMI_LIVE_EVAL === "1";
if (!enabled) {
  process.stdout.write(
    "Kimi live evaluation skipped. Set RUN_KIMI_LIVE_EVAL=1 explicitly to run it.\n",
  );
  process.exit(0);
}

const client = createKimiClientFromEnv(process.env);
if (!client) {
  process.stderr.write(
    "Kimi live evaluation requires a server-side MOONSHOT_API_KEY or KIMI_API_KEY.\n",
  );
  process.exit(2);
}

const ALL_CASES = [
  {
    id: "live-ru-barbershop",
    kind: "selected",
    input: {
      primaryQuery: "место где приводят бороду в порядок",
      locale: "ru-RU",
      countryCodes: ["RU"],
    },
    expectedStatus: "ready",
    expectedConceptId: "personal_care.barbershop",
  },
  {
    id: "live-by-pharmacy",
    kind: "selected",
    input: {
      primaryQuery: "дзе можна купіць лекі па рэцэпце",
      locale: "be-BY",
      countryCodes: ["BY"],
    },
    expectedStatus: "ready",
    expectedConceptId: "health.pharmacy",
  },
  {
    id: "live-kz-car-wash",
    kind: "selected",
    input: {
      primaryQuery: "көліктің кузовын жуып береді",
      locale: "kk-KZ",
      countryCodes: ["KZ"],
    },
    expectedStatus: "ready",
    expectedConceptId: "automotive.car_wash",
  },
  {
    id: "live-ru-ambiguous-warehouse",
    kind: "ambiguous",
    input: {
      primaryQuery: "склад",
      locale: "ru-RU",
      countryCodes: ["RU"],
    },
    expectedStatus: "needs_confirmation",
    expectedAlternativeConceptIds: [
      "logistics.fulfillment",
      "logistics.warehouse",
    ],
  },
  {
    id: "live-ru-unsupported-cloud-crm",
    kind: "unsupported",
    input: {
      primaryQuery: "облачная CRM без офиса",
      locale: "ru-RU",
      countryCodes: ["RU"],
    },
    expectedStatus: "unsupported",
  },
];

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

const maxCases = boundedInteger(process.env.KIMI_LIVE_MAX_CASES, 5, 1, 5);
const minStartIntervalMs = boundedInteger(
  process.env.KIMI_MIN_START_INTERVAL_MS,
  20_000,
  0,
  120_000,
);
const cases = ALL_CASES.slice(0, maxCases);
let lastStartAt = 0;

async function waitForTierZeroSlot() {
  const remaining = lastStartAt + minStartIntervalMs - Date.now();
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  lastStartAt = Date.now();
}

function numberFromEnv(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function estimatedCostUsd(inputTokens, outputTokens) {
  const inputRate = numberFromEnv("KIMI_INPUT_USD_PER_MILLION");
  const outputRate = numberFromEnv("KIMI_OUTPUT_USD_PER_MILLION");
  if (inputRate === null || outputRate === null) return null;
  return (inputTokens / 1_000_000) * inputRate +
    (outputTokens / 1_000_000) * outputRate;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameValues(left, right) {
  const leftSorted = sortedUnique(left);
  const rightSorted = sortedUnique(right);
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
}

function expectedOutcomeMatches(entry, plan) {
  if (plan.status !== entry.expectedStatus) return false;
  if (entry.kind === "selected") {
    return (
      plan.resolution.selectedConceptIds.length === 1 &&
      plan.resolution.selectedConceptIds[0] === entry.expectedConceptId
    );
  }
  if (entry.kind === "ambiguous") {
    return sameValues(
      plan.resolution.alternatives.map((alternative) => alternative.conceptId),
      entry.expectedAlternativeConceptIds,
    );
  }
  return (
    entry.kind === "unsupported" &&
    plan.resolution.selectedConceptIds.length === 0 &&
    plan.resolution.alternatives.length === 0
  );
}

const startedAt = new Date();
const sanitizedCases = [];
let modelCanary = {
  checked: false,
  configuredModelAvailable: null,
  modelCount: null,
  latencyMs: null,
};

try {
  if (process.env.KIMI_LIVE_SKIP_MODELS_CANARY !== "1") {
    await waitForTierZeroSlot();
    const canary = await client.listModels();
    modelCanary = {
      checked: true,
      configuredModelAvailable: canary.configuredModelAvailable,
      modelCount: canary.modelIds.length,
      latencyMs: canary.latencyMs,
    };
  }

  for (const entry of cases) {
    await waitForTierZeroSlot();
    const wallStartedAt = Date.now();
    try {
      const plan = await createSearchPlan(entry.input, {
        mode: "kimi",
        kimiClient: client,
      });
      const selectedConceptId = plan.resolution.selectedConceptIds[0] ?? null;
      const alternativeConceptIds = sortedUnique(
        plan.resolution.alternatives.map((alternative) => alternative.conceptId),
      );
      const outcomeMatches = expectedOutcomeMatches(entry, plan);
      const kimiOutputValid = plan.ai.used && plan.ai.validation === "passed";
      sanitizedCases.push({
        id: entry.id,
        kind: entry.kind,
        status: plan.status,
        expectedStatus: entry.expectedStatus,
        selectedConceptId,
        expectedConceptId: entry.expectedConceptId ?? null,
        alternativeConceptIds,
        expectedAlternativeConceptIds:
          entry.expectedAlternativeConceptIds ?? [],
        correct: outcomeMatches && kimiOutputValid,
        kimiUsed: plan.ai.used,
        schemaValidation: plan.ai.validation,
        modelId: plan.ai.modelId,
        apiLatencyMs: plan.ai.latencyMs,
        wallLatencyMs: Date.now() - wallStartedAt,
        providerSelectorsExposed: plan.executionPreview?.categoryLabels.length ?? 0,
        usage: {
          inputTokens: plan.ai.inputTokens,
          outputTokens: plan.ai.outputTokens,
        },
        errorCode: null,
      });
    } catch (error) {
      sanitizedCases.push({
        id: entry.id,
        kind: entry.kind,
        status: "error",
        expectedStatus: entry.expectedStatus,
        selectedConceptId: null,
        expectedConceptId: entry.expectedConceptId ?? null,
        alternativeConceptIds: [],
        expectedAlternativeConceptIds:
          entry.expectedAlternativeConceptIds ?? [],
        correct: false,
        kimiUsed: false,
        schemaValidation: "failed",
        modelId: client.modelId,
        apiLatencyMs: null,
        wallLatencyMs: Date.now() - wallStartedAt,
        providerSelectorsExposed: 0,
        usage: { inputTokens: null, outputTokens: null },
        errorCode:
          typeof error === "object" && error && "code" in error
            ? String(error.code)
            : "UNCLASSIFIED_LIVE_ERROR",
      });
    }
  }
} catch (error) {
  sanitizedCases.push({
    id: "models-canary",
    kind: "canary",
    status: "error",
    expectedStatus: "available",
    selectedConceptId: null,
    expectedConceptId: null,
    alternativeConceptIds: [],
    expectedAlternativeConceptIds: [],
    correct: false,
    kimiUsed: false,
    schemaValidation: "not_run",
    modelId: client.modelId,
    apiLatencyMs: null,
    wallLatencyMs: null,
    providerSelectorsExposed: 0,
    usage: { inputTokens: null, outputTokens: null },
    errorCode:
      typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "UNCLASSIFIED_CANARY_ERROR",
  });
}

const apiLatencies = sanitizedCases
  .map((entry) => entry.apiLatencyMs)
  .filter((value) => typeof value === "number");
const wallLatencies = sanitizedCases
  .map((entry) => entry.wallLatencyMs)
  .filter((value) => typeof value === "number");
const inputTokens = sanitizedCases.reduce(
  (sum, entry) => sum + (entry.usage.inputTokens ?? 0),
  0,
);
const outputTokens = sanitizedCases.reduce(
  (sum, entry) => sum + (entry.usage.outputTokens ?? 0),
  0,
);
const evaluatedCases = sanitizedCases.filter((entry) => entry.id !== "models-canary");
const correctCases = evaluatedCases.filter((entry) => entry.correct).length;
const report = {
  evaluation: "LeadRadar Kimi live canary",
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  modelId: client.modelId,
  baseUrlHost: new URL(client.baseUrl).hostname,
  tierProfile: "tier0-safe",
  sampleCount: evaluatedCases.length,
  modelCanary,
  metrics: {
    exactConceptAccuracy: roundMetric(ratio(correctCases, evaluatedCases.length)),
    schemaPassCount: evaluatedCases.filter(
      (entry) => entry.schemaValidation === "passed",
    ).length,
    p50ApiLatencyMs: percentile(apiLatencies, 0.5),
    p95ApiLatencyMs: percentile(apiLatencies, 0.95),
    p50WallLatencyMs: percentile(wallLatencies, 0.5),
    p95WallLatencyMs: percentile(wallLatencies, 0.95),
    inputTokens,
    outputTokens,
    estimatedCostUsd: roundMetric(estimatedCostUsd(inputTokens, outputTokens), 6),
  },
  hardGates: {
    modelAvailable:
      !modelCanary.checked || modelCanary.configuredModelAvailable === true,
    allCasesCorrect: evaluatedCases.length === cases.length && correctCases === cases.length,
    allStructuredOutputsValid:
      evaluatedCases.length === cases.length &&
      evaluatedCases.every((entry) => entry.schemaValidation === "passed"),
    allCasesUsedKimi:
      evaluatedCases.length === cases.length &&
      evaluatedCases.every((entry) => entry.kimiUsed),
    allUsageReported:
      evaluatedCases.length === cases.length &&
      evaluatedCases.every(
        (entry) =>
          typeof entry.usage.inputTokens === "number" &&
          typeof entry.usage.outputTokens === "number",
      ),
    noUnclassifiedErrors: sanitizedCases.every(
      (entry) =>
        entry.errorCode === null ||
        !entry.errorCode.startsWith("UNCLASSIFIED_"),
    ),
  },
  sanitizedCases,
};

if (!assertAggregateOnly(report)) {
  throw new Error("Live evaluation report failed aggregate-only validation");
}

const packageMetadata = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
report.appVersion = packageMetadata.version;
report.decision = Object.values(report.hardGates).every(Boolean) ? "PASS" : "FAIL";

const outputDirectory = new URL("../work/evaluations/", import.meta.url);
await mkdir(outputDirectory, { recursive: true });
const timestamp = startedAt.toISOString().replace(/[:.]/g, "-");
const outputUrl = new URL(`kimi-live-summary-${timestamp}.json`, outputDirectory);
await writeFile(outputUrl, `${JSON.stringify(report, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});

process.stdout.write(
  `${JSON.stringify({
    decision: report.decision,
    sampleCount: report.sampleCount,
    modelId: report.modelId,
    metrics: report.metrics,
    reportFile: outputUrl.pathname,
  }, null, 2)}\n`,
);
if (report.decision !== "PASS") process.exitCode = 1;
