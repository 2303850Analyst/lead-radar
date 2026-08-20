import { createHash } from "node:crypto";

const REQUIRED_CITIES = [
  "Москва",
  "Екатеринбург",
  "Новосибирск",
  "Минск",
  "Алматы",
];
const REQUIRED_COUNTRY_CODES = ["RU", "BY", "KZ"];
const RETRYABLE_SEARCH_CANARY_CODES = new Set([
  "SEARCH_PLANNER_UNAVAILABLE",
  "SEARCH_DEADLINE_EXCEEDED",
  "GEOAPIFY_TIMEOUT",
  "GEOAPIFY_RATE_LIMIT",
  "GEOAPIFY_NETWORK_ERROR",
  "GEOAPIFY_UPSTREAM_ERROR",
]);
const SEARCH_CANARY_RETRIEVAL_ARM_TYPES = new Set([
  "precision",
  "recall",
  "adjacent",
  "fallback",
  "legacy",
]);
const SEARCH_CANARY_RETRIEVAL_ARM_ROLES = Object.freeze({
  precision: "primary",
  recall: "primary",
  adjacent: "adjacent",
  fallback: "fallback",
  legacy: "primary",
});
const SEARCH_CANARY_CATEGORY_RESOLUTION_STATUSES = new Set([
  "disabled",
  "not_needed",
  "resolved",
  "no_match",
  "degraded",
]);

export const SEARCH_CANARY_ATTAINABLE_POLICY = Object.freeze({
  version: "search-live-attainable-v1/2026-08-20.1",
  topK: 10,
  maxPoolCandidatesPerCase: 50,
  attainableAt10Threshold: 0.95,
  literalBaselineLimit: 10,
  manualReviewTimeoutMs: 45 * 60 * 1_000,
  measurementScope: "executed_production_candidate_pool",
  addedProviderWork: Object.freeze({
    requests: 0,
    cards: 0,
    details: 0,
  }),
});

export const SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS = Object.freeze({
  plannedRetrievalArms: 4,
  completedRetrievalArms: 4,
  retrievalRequests: 4,
  cardsAccepted: 200,
  detailsRequests: 3,
  categoryResolutionRequests: 1,
  totalProviderRequests: 8,
});

export function resolveSearchCanaryProviderObservation(
  value,
  { required = false } = {},
) {
  if (typeof required !== "boolean") {
    throw new Error("Invalid search canary provider coverage options");
  }
  if (value === undefined || value === null) {
    if (required) throw new Error("Missing search canary provider coverage");
    return {
      counts: {},
      executedArms: [],
      categoryResolutionStatus: "unreported",
    };
  }
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.categoryResolution === null ||
    typeof value.categoryResolution !== "object" ||
    Array.isArray(value.categoryResolution) ||
    !SEARCH_CANARY_CATEGORY_RESOLUTION_STATUSES.has(
      value.categoryResolution.status,
    )
  ) {
    throw new Error("Invalid search canary provider coverage");
  }
  const counts = {
    plannedRetrievalArms: value.retrievalArms,
    completedRetrievalArms: value.completedRetrievalArms,
    retrievalRequests: value.upstreamRequests,
    cardsAccepted: value.cardsAccepted,
    detailsRequests: value.detailsRequested,
    categoryResolutionRequests: value.categoryResolution.requests,
  };
  counts.totalProviderRequests =
    counts.retrievalRequests +
    counts.detailsRequests +
    counts.categoryResolutionRequests;
  if (
    Object.entries(counts).some(
      ([field, count]) =>
        !Number.isInteger(count) ||
        count < 0 ||
        count > SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS[field],
    ) ||
    counts.completedRetrievalArms > counts.plannedRetrievalArms ||
    counts.completedRetrievalArms > counts.retrievalRequests ||
    counts.detailsRequests > counts.cardsAccepted ||
    (["disabled", "not_needed"].includes(value.categoryResolution.status) &&
      counts.categoryResolutionRequests !== 0) ||
    (["resolved", "no_match"].includes(value.categoryResolution.status) &&
      counts.categoryResolutionRequests !== 1) ||
    !Array.isArray(value.executedRetrievalArms) ||
    value.executedRetrievalArms.length !== counts.completedRetrievalArms
  ) {
    throw new Error("Invalid bounded search canary provider coverage");
  }
  return {
    counts,
    executedArms: value.executedRetrievalArms.map((arm) => ({
      id: arm?.id,
      planArmId: arm?.planArmId,
      type: arm?.type,
      role: arm?.role,
    })),
    categoryResolutionStatus: value.categoryResolution.status,
  };
}

export function isRetryableSearchCanaryCode(code) {
  return typeof code === "string" && RETRYABLE_SEARCH_CANARY_CODES.has(code);
}

export async function runCanaryAttemptWithWatchdog(
  attemptPromise,
  controller,
  { timeoutMs = 65_000, settleTimeoutMs = 5_000 } = {},
) {
  if (
    !attemptPromise ||
    typeof attemptPromise.then !== "function" ||
    !(controller instanceof AbortController) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isInteger(settleTimeoutMs) ||
    settleTimeoutMs < 1
  ) {
    throw new Error("Invalid canary watchdog input");
  }
  let watchdogError = null;
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => {
      watchdogError = Object.assign(new Error("CANARY_HARNESS_TIMEOUT"), {
        code: "CANARY_HARNESS_TIMEOUT",
        firstProgressMs: timeoutMs,
        terminalMs: timeoutMs,
      });
      controller.abort();
      reject(watchdogError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([attemptPromise, watchdog]);
  } catch (error) {
    if (!watchdogError) throw error;
    const settled = await Promise.race([
      Promise.resolve(attemptPromise).then(
        () => true,
        () => true,
      ),
      new Promise((resolve) =>
        setTimeout(() => resolve(false), settleTimeoutMs),
      ),
    ]);
    if (!settled) {
      throw Object.assign(new Error("CANARY_ATTEMPT_DID_NOT_SETTLE"), {
        code: "CANARY_ATTEMPT_DID_NOT_SETTLE",
        firstProgressMs: timeoutMs,
        terminalMs: timeoutMs + settleTimeoutMs,
      });
    }
    throw watchdogError;
  } finally {
    clearTimeout(timer);
  }
}

export const SEARCH_CANARY_CASES = Object.freeze([
  {
    id: "canary-moscow-sports-hall",
    city: "Москва",
    center: [37.6176, 55.7558],
    radiusKm: 10,
    locale: "ru-RU",
    countryCode: "RU",
    query: "спортивный зал для взрослых",
    literalBaselineQuery: "спортивный зал",
    description: "Найти действующие спортивные и тренажёрные залы",
    relatedQueries: ["фитнес-клуб", "тренажёрный зал"],
    excludeQueries: ["магазин спортивных товаров"],
    legacyNovel: true,
    mixedLanguage: false,
  },
  {
    id: "canary-moscow-optician",
    city: "Москва",
    center: [37.6176, 55.7558],
    radiusKm: 10,
    locale: "ru-RU",
    countryCode: "RU",
    query: "салон оптики где подбирают очки",
    literalBaselineQuery: "оптика",
    description: "Найти салоны оптики с подбором очков",
    relatedQueries: ["оптика", "подбор линз"],
    excludeQueries: ["офтальмологическая клиника"],
    legacyNovel: true,
    mixedLanguage: false,
  },
  {
    id: "canary-yekaterinburg-music-school",
    city: "Екатеринбург",
    center: [60.5975, 56.8389],
    radiusKm: 10,
    locale: "ru-RU",
    countryCode: "RU",
    query: "музыкальная школа",
    literalBaselineQuery: "музыкальная школа",
    description: "Найти музыкальные школы и студии обучения музыке",
    relatedQueries: ["уроки музыки", "обучение игре на инструментах"],
    excludeQueries: ["магазин музыкальных инструментов"],
    legacyNovel: true,
    mixedLanguage: false,
  },
  {
    id: "canary-yekaterinburg-massage",
    city: "Екатеринбург",
    center: [60.5975, 56.8389],
    radiusKm: 10,
    locale: "ru-RU",
    countryCode: "RU",
    query: "студия массажа",
    literalBaselineQuery: "массаж",
    description: "Найти студии и кабинеты массажа",
    relatedQueries: ["массажный салон", "кабинет массажа"],
    excludeQueries: ["магазин массажного оборудования"],
    legacyNovel: true,
    mixedLanguage: false,
  },
  {
    id: "canary-novosibirsk-tanning",
    city: "Новосибирск",
    center: [82.9204, 55.0302],
    radiusKm: 10,
    locale: "ru-RU",
    countryCode: "RU",
    query: "студия загара солярий",
    literalBaselineQuery: "солярий",
    description: "Найти студии загара и солярии",
    relatedQueries: ["солярий", "салон загара"],
    excludeQueries: ["продажа оборудования для солярия"],
    legacyNovel: true,
    mixedLanguage: false,
  },
  {
    id: "canary-novosibirsk-dentist-control",
    city: "Новосибирск",
    center: [82.9204, 55.0302],
    radiusKm: 10,
    locale: "ru-RU",
    countryCode: "RU",
    query: "стоматология",
    literalBaselineQuery: "стоматология",
    description: "Найти стоматологические клиники",
    relatedQueries: ["лечение зубов", "зубная клиника"],
    excludeQueries: ["магазин стоматологических материалов"],
    legacyNovel: false,
    mixedLanguage: false,
  },
  {
    id: "canary-minsk-veterinary",
    city: "Минск",
    center: [27.5615, 53.9045],
    radiusKm: 10,
    locale: "be-BY",
    countryCode: "BY",
    query: "ветэрынарныя паслугі для жывёл",
    literalBaselineQuery: "ветэрынар",
    description: "Знайсці ветэрынарныя арганізацыі і паслугі для жывёл",
    relatedQueries: ["ветэрынарная клініка", "лячэнне жывёл"],
    excludeQueries: ["зоамагазін"],
    legacyNovel: true,
    mixedLanguage: false,
  },
  {
    id: "canary-minsk-cinema",
    city: "Минск",
    center: [27.5615, 53.9045],
    radiusKm: 10,
    locale: "be-BY",
    countryCode: "BY",
    query: "кінотеатр",
    literalBaselineQuery: "кінотеатр",
    description: "Знайсці дзеючыя кінатэатры",
    relatedQueries: ["кіназала", "паказ фільмаў"],
    excludeQueries: ["хатні кінатэатр"],
    legacyNovel: true,
    mixedLanguage: false,
  },
  {
    id: "canary-almaty-kindergarten",
    city: "Алматы",
    center: [76.9455, 43.2389],
    radiusKm: 10,
    locale: "kk-KZ",
    countryCode: "KZ",
    query: "балабақша kindergarten",
    literalBaselineQuery: "балабақша",
    description: "Алматыдағы балабақшаларды табу",
    relatedQueries: ["балалар орталығы", "мектепке дейінгі білім"],
    excludeQueries: ["балалар дүкені"],
    legacyNovel: true,
    mixedLanguage: true,
  },
  {
    id: "canary-almaty-tattoo",
    city: "Алматы",
    center: [76.9455, 43.2389],
    radiusKm: 10,
    locale: "kk-KZ",
    countryCode: "KZ",
    query: "тату студия tattoo studio",
    literalBaselineQuery: "тату студия",
    description: "Татуировка жасайтын студияларды табу",
    relatedQueries: ["тату салон", "tattoo artist"],
    excludeQueries: ["тату жабдықтары дүкені"],
    legacyNovel: true,
    mixedLanguage: true,
  },
  {
    id: "canary-moscow-bookstore",
    city: "Москва",
    center: [37.6176, 55.7558],
    radiusKm: 10,
    locale: "ru-RU",
    countryCode: "RU",
    query: "книжный магазин",
    literalBaselineQuery: "книжный магазин",
    description: "Найти магазины, которые продают книги",
    relatedQueries: ["книжная лавка", "магазин книг"],
    excludeQueries: ["библиотека"],
    legacyNovel: true,
    mixedLanguage: false,
  },
  {
    id: "canary-moscow-barbershop-control",
    city: "Москва",
    center: [37.6176, 55.7558],
    radiusKm: 10,
    locale: "ru-RU",
    countryCode: "RU",
    query: "барбершоп",
    literalBaselineQuery: "барбершоп",
    description: "Найти барбершопы и мужские парикмахерские",
    relatedQueries: ["мужская парикмахерская", "стрижка бороды"],
    excludeQueries: ["обычный салон красоты"],
    legacyNovel: false,
    mixedLanguage: false,
  },
]);

export function searchCanaryCaseSetChecksum(cases = SEARCH_CANARY_CASES) {
  return createHash("sha256").update(JSON.stringify(cases)).digest("hex");
}

export async function readBoundedJsonResponse(response, maxBytes) {
  if (!(response instanceof Response) || !Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Invalid bounded response reader input");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Response exceeds the byte limit");
  }
  if (!response.body) return JSON.parse(await response.text());
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("Response exceeds the byte limit");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

function boundedProviderText(value, maximum = 500) {
  return typeof value === "string"
    ? value
        .normalize("NFKC")
        .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, maximum)
        .trim()
    : "";
}

function normalizedProviderText(value) {
  return boundedProviderText(value).toLocaleLowerCase();
}

function canonicalProviderUrl(value) {
  const text = boundedProviderText(value);
  if (!text) return "";
  try {
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(text)
      ? text
      : `https://${text}`;
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function validProviderCoordinates(value) {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  );
}

/**
 * Reduces an upstream Geoapify FeatureCollection to the minimal in-memory facts
 * needed to prove that normalized lead fields were observed. Raw features are
 * never returned, logged or persisted by the canary.
 */
export function collectGeoapifyProviderFacts(store, observedFacts) {
  if (!(store instanceof Map) || !Array.isArray(observedFacts)) return;
  for (const observed of observedFacts) {
    if (!observed || typeof observed !== "object") continue;
    const externalId = boundedProviderText(observed.externalId);
    if (!externalId) continue;
    const fact = store.get(externalId) ?? {
      names: new Set(),
      addresses: new Set(),
      coordinates: [],
      categories: new Set(),
      categoryLabels: new Set(),
      phones: new Set(),
      emails: new Set(),
      websites: new Set(),
      telegram: new Set(),
      vk: new Set(),
      detailsObserved: false,
    };
    const name = normalizedProviderText(observed.name);
    const address = normalizedProviderText(observed.address);
    if (name) fact.names.add(name);
    if (address) fact.addresses.add(address);
    if (validProviderCoordinates(observed.coordinates)) {
      fact.coordinates.push(observed.coordinates.slice(0, 2));
    }
    for (const category of Array.isArray(observed.categories)
      ? observed.categories.slice(0, 32)
      : []) {
      const normalized = normalizedProviderText(category);
      if (normalized) fact.categories.add(normalized);
    }
    const categoryLabel = normalizedProviderText(observed.categoryLabel);
    if (categoryLabel) fact.categoryLabels.add(categoryLabel);
    const phone = normalizedProviderText(observed.phone);
    const email = normalizedProviderText(observed.email);
    const website = canonicalProviderUrl(observed.website);
    const telegram = canonicalProviderUrl(observed.telegram);
    const vk = canonicalProviderUrl(observed.vk);
    if (phone) fact.phones.add(phone);
    if (email) fact.emails.add(email);
    if (website) fact.websites.add(website);
    if (telegram) fact.telegram.add(telegram);
    if (vk) fact.vk.add(vk);
    if (observed.detailsObserved === true) fact.detailsObserved = true;
    store.set(externalId, fact);
  }
}

function providerDistanceMeters(left, right) {
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(right[1] - left[1]);
  const longitudeDelta = radians(right[0] - left[0]);
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(radians(left[1])) *
      Math.cos(radians(right[1])) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

/** Counts normalized output fields that cannot be traced to transient facts. */
export function countGeoapifyProviderFactViolations(leads, store) {
  if (!Array.isArray(leads) || !(store instanceof Map)) return 1;
  let violations = 0;
  for (const lead of leads) {
    const sources = Array.isArray(lead?.sources) ? lead.sources : [];
    if (
      lead?.discovery?.source !== "geoapify" ||
      !sources.length ||
      sources.some(
        (source) =>
          source?.provider !== "geoapify" ||
          !boundedProviderText(source.externalId),
      )
    ) {
      violations += 1;
    }
    const sourceIds = sources
      .filter((source) => source?.provider === "geoapify")
      .map((source) => boundedProviderText(source.externalId))
      .filter(Boolean);
    const facts = sourceIds.map((externalId) => store.get(externalId));
    if (!sourceIds.length || facts.some((fact) => !fact)) violations += 1;
    const observed = facts.filter(Boolean);
    const name = normalizedProviderText(lead?.name);
    const address = normalizedProviderText(lead?.location?.address);
    if (!name || !observed.some((fact) => fact.names.has(name))) violations += 1;
    if (!address || !observed.some((fact) => fact.addresses.has(address))) {
      violations += 1;
    }
    const coordinates = lead?.location?.coordinates;
    if (
      !validProviderCoordinates(coordinates) ||
      !observed.some((fact) =>
        fact.coordinates.some(
          (candidate) => providerDistanceMeters(coordinates, candidate) <= 25,
        ),
      )
    ) {
      violations += 1;
    }
    const tags = Array.isArray(lead?.tags)
      ? lead.tags.map(normalizedProviderText).filter(Boolean)
      : [];
    if (
      tags.length > 32 ||
      tags.some(
        (tag) => !observed.some((fact) => fact.categories.has(tag)),
      )
    ) {
      violations += 1;
    }
    const leadCategory = normalizedProviderText(lead?.category);
    if (
      !leadCategory ||
      !observed.some((fact) => fact.categoryLabels.has(leadCategory))
    ) {
      violations += 1;
    }
    const contactChecks = [
      [lead?.phone, "phones"],
      [lead?.email, "emails"],
    ];
    for (const [value, field] of contactChecks) {
      const normalized = normalizedProviderText(value);
      if (normalized && !observed.some((fact) => fact[field].has(normalized))) {
        violations += 1;
      }
    }
    const websiteStatus = lead?.website?.sourceStatus;
    if (lead?.website?.verifiedStatus !== "not_checked") violations += 1;
    const websiteInput = lead?.website?.url;
    const website = canonicalProviderUrl(websiteInput);
    if (websiteInput && (!website || !observed.some((fact) => fact.websites.has(website)))) {
      violations += 1;
    }
    if (websiteStatus === "listed" && !website) violations += 1;
    if (
      websiteStatus === "not_listed" &&
      (websiteInput ||
        !observed.some(
          (fact) => fact.detailsObserved && fact.websites.size === 0,
        ))
    ) {
      violations += 1;
    }
    if (websiteStatus === "not_checked" && websiteInput) violations += 1;
    if (
      !["listed", "not_listed", "not_checked"].includes(websiteStatus)
    ) {
      violations += 1;
    }
    for (const field of ["telegram", "vk"]) {
      const socialInput = lead?.socials?.[field];
      const social = canonicalProviderUrl(socialInput);
      if (
        socialInput &&
        (!social || !observed.some((fact) => fact[field].has(social)))
      ) {
        violations += 1;
      }
    }
  }
  return violations;
}

function unique(values) {
  return [...new Set(values)];
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function round(value, digits = 4) {
  return value === null ? null : Number(value.toFixed(digits));
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function validIdentityGroups(value, expectedCount) {
  return (
    Array.isArray(value) &&
    value.length === expectedCount &&
    value.every(
      (group) =>
        Array.isArray(group) &&
        group.length >= 1 &&
        group.length <= 16 &&
        new Set(group).size === group.length &&
        group.every(
          (identity) =>
            typeof identity === "string" && /^[a-f0-9]{64}$/.test(identity),
        ),
    )
  );
}

function countIdentityComponents(groups) {
  const parent = new Map();
  const find = (identity) => {
    const current = parent.get(identity) ?? identity;
    if (!parent.has(identity)) parent.set(identity, identity);
    if (current === identity) return identity;
    const root = find(current);
    parent.set(identity, root);
    return root;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  for (const group of groups) {
    const [first, ...rest] = group;
    find(first);
    for (const identity of rest) union(first, identity);
  }
  return new Set([...parent.keys()].map(find)).size;
}

export function resolveSearchCanaryPoolReview(candidateCount, relevantRanks) {
  if (
    !Number.isInteger(candidateCount) ||
    candidateCount < 0 ||
    candidateCount > SEARCH_CANARY_ATTAINABLE_POLICY.maxPoolCandidatesPerCase ||
    !Array.isArray(relevantRanks) ||
    new Set(relevantRanks).size !== relevantRanks.length ||
    !relevantRanks.every(
      (rank) =>
        Number.isInteger(rank) && rank >= 1 && rank <= candidateCount,
    )
  ) {
    throw new Error("Invalid bounded production-pool review");
  }

  const top10CandidateCount = Math.min(
    SEARCH_CANARY_ATTAINABLE_POLICY.topK,
    candidateCount,
  );
  return {
    poolCandidateCount: candidateCount,
    poolReviewed: candidateCount,
    poolRelevant: relevantRanks.length,
    top10CandidateCount,
    top10Reviewed: top10CandidateCount,
    top10Relevant: relevantRanks.filter(
      (rank) => rank <= SEARCH_CANARY_ATTAINABLE_POLICY.topK,
    ).length,
  };
}

function validSearchCanaryArmSummary(arm) {
  if (
    arm === null ||
    typeof arm !== "object" ||
    Array.isArray(arm) ||
    Object.keys(arm).length !== 3 ||
    !Object.hasOwn(arm, "id") ||
    !Object.hasOwn(arm, "type") ||
    !Object.hasOwn(arm, "role") ||
    typeof arm.id !== "string" ||
    !SEARCH_CANARY_RETRIEVAL_ARM_TYPES.has(arm.type) ||
    SEARCH_CANARY_RETRIEVAL_ARM_ROLES[arm.type] !== arm.role
  ) {
    return false;
  }
  const idMatch = /^arm-([a-z]+)-[a-f0-9]{8}$/.exec(arm.id);
  return idMatch?.[1] === arm.type;
}

function validSearchCanaryExecutedArmSummary(arm) {
  if (
    arm === null ||
    typeof arm !== "object" ||
    Array.isArray(arm) ||
    Object.keys(arm).length !== 4 ||
    typeof arm.planArmId !== "string"
  ) {
    return false;
  }
  const effectiveArm = {
    id: arm.id,
    type: arm.type,
    role: arm.role,
  };
  return (
    /^arm-[a-z]+-[a-f0-9]{8}$/.test(arm.planArmId) &&
    validSearchCanaryArmSummary(effectiveArm)
  );
}

export function validateSearchCanaryExecutedArms(
  executedArms,
  plannedArms,
  {
    categoryResolutionStatus,
    categoryResolutionRequests,
    plannedRetrievalArms,
    completedRetrievalArms,
  } = {},
) {
  if (
    !Array.isArray(executedArms) ||
    !Array.isArray(plannedArms) ||
    !Number.isInteger(categoryResolutionRequests) ||
    !Number.isInteger(plannedRetrievalArms) ||
    !Number.isInteger(completedRetrievalArms) ||
    plannedArms.length !== plannedRetrievalArms ||
    executedArms.length !== completedRetrievalArms ||
    executedArms.length >
      SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS.completedRetrievalArms ||
    executedArms.length > plannedArms.length ||
    plannedArms.length >
      SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS.plannedRetrievalArms ||
    !SEARCH_CANARY_CATEGORY_RESOLUTION_STATUSES.has(categoryResolutionStatus) ||
    new Set(executedArms.map((arm) => arm?.id)).size !== executedArms.length ||
    new Set(executedArms.map((arm) => arm?.planArmId)).size !==
      executedArms.length ||
    new Set(plannedArms.map((arm) => arm?.id)).size !== plannedArms.length ||
    !executedArms.every(validSearchCanaryExecutedArmSummary) ||
    !plannedArms.every(validSearchCanaryArmSummary)
  ) {
    throw new Error("Invalid executed search canary arm provenance");
  }

  let replacementCount = 0;
  const effectiveArms = executedArms.map((executed, index) => {
    const planned = plannedArms[index];
    if (
      executed.planArmId !== planned.id ||
      executed.type !== planned.type ||
      executed.role !== planned.role
    ) {
      throw new Error("Executed search canary arm is not a signed-plan prefix");
    }
    if (executed.id !== executed.planArmId) {
      replacementCount += 1;
      if (
        replacementCount > 1 ||
        !["resolved", "degraded"].includes(categoryResolutionStatus) ||
        categoryResolutionRequests !== 1 ||
        executed.type !== "fallback" ||
        executed.role !== "fallback"
      ) {
        throw new Error("Invalid runtime fallback arm replacement");
      }
    }
    return { id: executed.id, type: executed.type, role: executed.role };
  });

  return effectiveArms;
}

export function validateSearchCanaryPoolProvenance(
  candidates,
  allowedArms,
) {
  if (
    !Array.isArray(candidates) ||
    candidates.length > SEARCH_CANARY_ATTAINABLE_POLICY.maxPoolCandidatesPerCase ||
    !Array.isArray(allowedArms) ||
    allowedArms.length >
      SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS.completedRetrievalArms ||
    new Set(allowedArms.map((arm) => arm?.id)).size !== allowedArms.length ||
    !allowedArms.every(validSearchCanaryArmSummary)
  ) {
    throw new Error("Invalid search canary candidate pool or executed arm allowlist");
  }
  const allowedArmById = new Map(allowedArms.map((arm) => [arm.id, arm]));
  const seenIdentities = new Set();
  for (const candidate of candidates) {
    const identities = candidate?.identityHashes;
    const retrievalArms = candidate?.retrievalArms;
    if (
      !Array.isArray(identities) ||
      identities.length < 1 ||
      identities.length > 16 ||
      new Set(identities).size !== identities.length ||
      !identities.every(
        (identity) =>
          typeof identity === "string" && /^[a-f0-9]{64}$/.test(identity),
      ) ||
      identities.some((identity) => seenIdentities.has(identity)) ||
      !Array.isArray(retrievalArms) ||
      retrievalArms.length < 1 ||
      retrievalArms.length >
        SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS.completedRetrievalArms ||
      new Set(retrievalArms.map((arm) => arm?.id)).size !== retrievalArms.length ||
      !retrievalArms.every((arm) => {
        if (!validSearchCanaryArmSummary(arm)) return false;
        const allowed = allowedArmById.get(arm.id);
        return allowed?.type === arm.type && allowed?.role === arm.role;
      })
    ) {
      throw new Error("Invalid search canary pool identity or arm provenance");
    }
    for (const identity of identities) seenIdentities.add(identity);
  }
  return true;
}

export function validateSearchCanaryCoverage(cases) {
  if (!Array.isArray(cases) || cases.length < SEARCH_CANARY_THRESHOLDS.cases) {
    throw new Error("Search canary requires at least 12 cases");
  }
  if (new Set(cases.map((entry) => entry.id)).size !== cases.length) {
    throw new Error("Search canary case IDs must be unique");
  }
  for (const entry of cases) {
    if (
      !entry.id ||
      !entry.city ||
      !entry.query ||
      typeof entry.literalBaselineQuery !== "string" ||
      entry.literalBaselineQuery.trim().length < 2 ||
      entry.literalBaselineQuery.length > 80 ||
      !Array.isArray(entry.center) ||
      entry.center.length !== 2 ||
      !entry.center.every(Number.isFinite) ||
      !Number.isFinite(entry.radiusKm) ||
      entry.radiusKm <= 0 ||
      entry.radiusKm > 25
    ) {
      throw new Error(`Invalid search canary case: ${entry.id ?? "unknown"}`);
    }
  }
  const cities = unique(cases.map((entry) => entry.city));
  const countryCodes = unique(cases.map((entry) => entry.countryCode));
  const missingCities = REQUIRED_CITIES.filter((city) => !cities.includes(city));
  const missingCountries = REQUIRED_COUNTRY_CODES.filter(
    (countryCode) => !countryCodes.includes(countryCode),
  );
  if (missingCities.length || missingCountries.length) {
    throw new Error("Search canary does not cover the required CIS geography");
  }
  const novelBusinessTypes = cases.filter((entry) => entry.legacyNovel).length;
  const mixedLanguageCases = cases.filter((entry) => entry.mixedLanguage).length;
  if (novelBusinessTypes < 8 || mixedLanguageCases < 2) {
    throw new Error("Search canary lacks open-world or mixed-language coverage");
  }
  return {
    cases: cases.length,
    cities,
    countryCodes,
    novelBusinessTypes,
    mixedLanguageCases,
  };
}

function boundedReview(record) {
  const providerCoverage = record.providerCoverage;
  const providerCoverageFields = Object.keys(
    SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS,
  );
  const providerCoverageValid =
    (!record.semanticSucceeded &&
      (providerCoverage === undefined ||
        (providerCoverage !== null &&
          typeof providerCoverage === "object" &&
          !Array.isArray(providerCoverage) &&
          Object.keys(providerCoverage).length === 0))) ||
    (record.semanticSucceeded &&
      providerCoverage !== null &&
      typeof providerCoverage === "object" &&
      !Array.isArray(providerCoverage) &&
      Object.keys(providerCoverage).every(
        (field) =>
          Object.hasOwn(SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS, field) &&
          Number.isInteger(providerCoverage[field]) &&
          providerCoverage[field] >= 0 &&
          providerCoverage[field] <=
            SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS[field],
      ) &&
      providerCoverageFields.every((field) =>
        Object.hasOwn(providerCoverage, field),
      ) &&
      providerCoverage.completedRetrievalArms <=
          providerCoverage.plannedRetrievalArms &&
      providerCoverage.completedRetrievalArms <=
        providerCoverage.retrievalRequests &&
      providerCoverage.detailsRequests <= providerCoverage.cardsAccepted &&
      providerCoverage.totalProviderRequests ===
        providerCoverage.retrievalRequests +
          providerCoverage.detailsRequests +
          providerCoverage.categoryResolutionRequests &&
      record.attainablePoolCandidateCount <= providerCoverage.cardsAccepted &&
      record.categoryResolutionRequests ===
        providerCoverage.categoryResolutionRequests);
  return (
    providerCoverageValid &&
    (record.semanticSucceeded
      ? SEARCH_CANARY_CATEGORY_RESOLUTION_STATUSES.has(
          record.categoryResolutionStatus,
        )
      : record.categoryResolutionStatus === "unreported") &&
    Number.isInteger(record.categoryResolutionRequests) &&
    record.categoryResolutionRequests >= 0 &&
    record.categoryResolutionRequests <=
      SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS.categoryResolutionRequests &&
    (!["disabled", "not_needed"].includes(record.categoryResolutionStatus) ||
      record.categoryResolutionRequests === 0) &&
    (!["resolved", "no_match"].includes(record.categoryResolutionStatus) ||
      record.categoryResolutionRequests === 1) &&
    Number.isInteger(record.attemptCount) &&
    record.attemptCount >= 1 &&
    record.attemptCount <= 2 &&
    typeof record.firstAttemptSucceeded === "boolean" &&
    Array.isArray(record.failedAttemptCodes) &&
    record.failedAttemptCodes.length ===
      (record.semanticSucceeded ? record.attemptCount - 1 : record.attemptCount) &&
    record.failedAttemptCodes.every(
      (code) => typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code),
    ) &&
    Array.isArray(record.attemptTimings) &&
    record.attemptTimings.length === record.attemptCount &&
    record.attemptTimings.every(
      (attempt) =>
        typeof attempt?.succeeded === "boolean" &&
        (attempt.firstProgressMs === null ||
          (Number.isFinite(attempt.firstProgressMs) &&
            attempt.firstProgressMs >= 0 &&
            attempt.firstProgressMs <= 65_000)) &&
        (attempt.succeeded ? attempt.firstProgressMs !== null : true) &&
        (attempt.encoderMs === null ||
          (Number.isFinite(attempt.encoderMs) &&
            attempt.encoderMs >= 0 &&
            attempt.encoderMs <= 65_000)) &&
        (!attempt.succeeded || attempt.encoderMs !== null) &&
        Number.isFinite(attempt.terminalMs) &&
        attempt.terminalMs >= 0 &&
        attempt.terminalMs <= 65_000,
    ) &&
    record.attemptTimings.filter((attempt) => attempt.succeeded).length ===
      (record.semanticSucceeded ? 1 : 0) &&
    Number.isFinite(record.semanticJourneyMs) &&
    record.semanticJourneyMs >= 0 &&
    record.semanticJourneyMs <= 135_000 &&
    record.firstAttemptSucceeded === (record.attemptCount === 1 && record.semanticSucceeded) &&
    Number.isInteger(record.semanticCandidateCount) &&
    record.semanticCandidateCount >= 0 &&
    record.semanticCandidateCount <= 10 &&
    Number.isInteger(record.semanticReviewed) &&
    record.semanticReviewed === record.semanticCandidateCount &&
    Number.isInteger(record.semanticRelevant) &&
    record.semanticRelevant >= 0 &&
    record.semanticRelevant <= record.semanticReviewed &&
    validIdentityGroups(
      record.semanticRelevantIdentityGroups,
      record.semanticRelevant,
    ) &&
    Number.isInteger(record.attainablePoolCandidateCount) &&
    record.attainablePoolCandidateCount >= 0 &&
    record.attainablePoolCandidateCount <=
      SEARCH_CANARY_ATTAINABLE_POLICY.maxPoolCandidatesPerCase &&
    Number.isInteger(record.attainablePoolReviewed) &&
    record.attainablePoolReviewed === record.attainablePoolCandidateCount &&
    Number.isInteger(record.attainablePoolRelevant) &&
    record.attainablePoolRelevant >= 0 &&
    record.attainablePoolRelevant <= record.attainablePoolReviewed &&
    record.semanticCandidateCount ===
      Math.min(
        SEARCH_CANARY_ATTAINABLE_POLICY.topK,
        record.attainablePoolCandidateCount,
      ) &&
    record.semanticRelevant <= record.attainablePoolRelevant &&
    record.attainablePoolRelevant - record.semanticRelevant <=
      record.attainablePoolCandidateCount - record.semanticCandidateCount &&
    Number.isInteger(record.baselineCandidateCount) &&
    record.baselineCandidateCount >= 0 &&
    record.baselineCandidateCount <=
      SEARCH_CANARY_ATTAINABLE_POLICY.literalBaselineLimit &&
    Number.isInteger(record.baselineReviewed) &&
    record.baselineReviewed === record.baselineCandidateCount &&
    Number.isInteger(record.baselineRelevant) &&
    record.baselineRelevant >= 0 &&
    record.baselineRelevant <= record.baselineReviewed &&
    validIdentityGroups(
      record.baselineRelevantIdentityGroups,
      record.baselineRelevant,
    )
  );
}

export function summarizeSearchCanary(records, versions) {
  if (
    !Number.isFinite(versions?.inputUsdPerMillion) ||
    versions.inputUsdPerMillion < 0 ||
    !Number.isFinite(versions?.outputUsdPerMillion) ||
    versions.outputUsdPerMillion < 0
  ) {
    throw new Error("Canary pricing must contain finite non-negative values");
  }
  if (
    !/^[a-f0-9]{64}$/.test(versions?.productionBundleSha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(versions?.canaryHarnessSha256 ?? "")
  ) {
    throw new Error("Canary artifact fingerprints must be SHA-256 values");
  }
  const coverage = validateSearchCanaryCoverage(SEARCH_CANARY_CASES);
  const expectedIds = new Set(SEARCH_CANARY_CASES.map((entry) => entry.id));
  const recordsComplete =
    Array.isArray(records) &&
    records.length === SEARCH_CANARY_CASES.length &&
    new Set(records.map((entry) => entry.id)).size === records.length &&
    records.every((entry) => expectedIds.has(entry.id) && boundedReview(entry));
  if (!recordsComplete) {
    throw new Error("Canary records are incomplete or contain invalid review counts");
  }

  const total = records.length;
  const totalAttempts = records.reduce(
    (sum, entry) => sum + entry.attemptCount,
    0,
  );
  const retriedCases = records.filter((entry) => entry.attemptCount > 1).length;
  const firstAttemptSucceeded = records.filter(
    (entry) => entry.firstAttemptSucceeded,
  ).length;
  const schemaPassCount = records.filter((entry) => entry.schemaPassed).length;
  const executablePlanCount = records.filter((entry) => entry.executablePlan).length;
  const semanticReviewed = records.reduce(
    (sum, entry) => sum + entry.semanticReviewed,
    0,
  );
  const semanticRelevant = records.reduce(
    (sum, entry) => sum + entry.semanticRelevant,
    0,
  );
  const attainablePoolReviewed = records.reduce(
    (sum, entry) => sum + entry.attainablePoolReviewed,
    0,
  );
  const attainablePoolRelevant = records.reduce(
    (sum, entry) => sum + entry.attainablePoolRelevant,
    0,
  );
  const attainableRelevantSlots = records.reduce(
    (sum, entry) =>
      sum +
      Math.min(
        SEARCH_CANARY_ATTAINABLE_POLICY.topK,
        entry.attainablePoolRelevant,
      ),
    0,
  );
  const baselineReviewed = records.reduce(
    (sum, entry) => sum + entry.baselineReviewed,
    0,
  );
  const baselineRelevant = records.reduce(
    (sum, entry) => sum + entry.baselineRelevant,
    0,
  );
  const baselineComparableCases = records.filter(
    (entry) => entry.baselineReviewed > 0,
  ).length;
  const fixedPrecisionSlots = total * SEARCH_CANARY_ATTAINABLE_POLICY.topK;
  const precisionAt10 = ratio(semanticRelevant, fixedPrecisionSlots);
  const attainableAt10 = ratio(attainableRelevantSlots, fixedPrecisionSlots);
  const baselinePrecisionAt10 = ratio(baselineRelevant, fixedPrecisionSlots);
  const precisionAmongRetrieved = ratio(semanticRelevant, semanticReviewed);
  const baselinePrecisionAmongRetrieved = ratio(
    baselineRelevant,
    baselineReviewed,
  );
  const relevantUniqueLeads = countIdentityComponents(
    records.flatMap((entry) => entry.semanticRelevantIdentityGroups),
  );
  const baselineRelevantUniqueLeads = countIdentityComponents(
    records.flatMap((entry) => entry.baselineRelevantIdentityGroups),
  );
  const relevantLeadGain = baselineRelevantUniqueLeads === 0
    ? relevantUniqueLeads > 0 ? 1 : 0
    : (relevantUniqueLeads - baselineRelevantUniqueLeads) /
      baselineRelevantUniqueLeads;
  const precisionDelta =
    precisionAt10 === null || baselinePrecisionAt10 === null
      ? null
      : precisionAt10 - baselinePrecisionAt10;
  const inputTokens = records.reduce((sum, entry) => sum + entry.inputTokens, 0);
  const outputTokens = records.reduce((sum, entry) => sum + entry.outputTokens, 0);
  const estimatedCostUsd =
    (inputTokens / 1_000_000) * versions.inputUsdPerMillion +
    (outputTokens / 1_000_000) * versions.outputUsdPerMillion;
  const unpricedFailedAttempts = records.reduce(
    (sum, entry) => sum + entry.failedAttemptCodes.length,
    0,
  );
  const categoryResolution = Object.fromEntries(
    ["disabled", "not_needed", "resolved", "no_match", "degraded", "unreported"].map(
      (status) => [
        status,
        records.filter((entry) => entry.categoryResolutionStatus === status).length,
      ],
    ),
  );
  const safetyViolations = records.reduce(
    (sum, entry) =>
      sum +
      entry.geographyLeaks +
      entry.secretLeaks +
      entry.inventedFactViolations +
      (entry.rawResponsesStored ? 1 : 0),
    0,
  );
  const allAttempts = records.flatMap((entry) => entry.attemptTimings);
  const firstProgress = allAttempts.flatMap((entry) =>
    entry.firstProgressMs === null ? [] : [entry.firstProgressMs],
  );
  const encoder = allAttempts.flatMap((entry) =>
    entry.encoderMs === null ? [] : [entry.encoderMs],
  );
  const terminal = allAttempts.map((entry) => entry.terminalMs);
  const semanticJourney = records.map((entry) => entry.semanticJourneyMs);
  const providerCoverageReportedCases = records.filter(
    (entry) => Object.keys(entry.providerCoverage ?? {}).length > 0,
  ).length;
  const providerCoverageTotals = Object.fromEntries(
    Object.keys(SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS).map((field) => [
      field,
      records.reduce(
        (sum, entry) => sum + (entry.providerCoverage?.[field] ?? 0),
        0,
      ),
    ]),
  );
  const attainableMeasurementValid = records.every(
    (entry) =>
      entry.semanticSucceeded &&
      entry.kimiUsed &&
      entry.schemaPassed &&
      entry.executablePlan &&
      Object.keys(SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS).every((field) =>
        Object.hasOwn(entry.providerCoverage ?? {}, field),
      ),
  ) &&
    allAttempts.every(
      (entry) =>
        entry.terminalMs <= SEARCH_CANARY_THRESHOLDS.requestDeadlineMs,
    ) &&
    safetyViolations === 0;
  const qualityGapClassification = !attainableMeasurementValid
    ? "invalid_measurement"
    : attainableAt10 < SEARCH_CANARY_ATTAINABLE_POLICY.attainableAt10Threshold
      ? "retrieval_or_source_gap"
      : precisionAt10 < SEARCH_CANARY_THRESHOLDS.precisionAt10
        ? "ranking_or_fusion_gap"
        : "fixed_k_precision_target_met";
  const metrics = {
    schemaPassRate: round(ratio(schemaPassCount, total)),
    executablePlanRate: round(ratio(executablePlanCount, total)),
    firstAttemptSuccessRate: round(ratio(firstAttemptSucceeded, total)),
    retriedCases,
    totalProductionAttempts: totalAttempts,
    precisionAt10: round(precisionAt10),
    baselinePrecisionAt10: round(baselinePrecisionAt10),
    precisionAmongRetrieved: round(precisionAmongRetrieved),
    baselinePrecisionAmongRetrieved: round(baselinePrecisionAmongRetrieved),
    attainableAt10: round(attainableAt10),
    conditionalRankerRecallAt10: round(
      ratio(semanticRelevant, attainableRelevantSlots),
    ),
    baselineComparableCases,
    relevantUniqueLeads,
    baselineRelevantUniqueLeads,
    relevantLeadGain: round(relevantLeadGain),
    precisionDelta: round(precisionDelta),
    firstProgressP95Ms: percentile(firstProgress, 0.95),
    encoderP95Ms: percentile(encoder, 0.95),
    terminalP95Ms: percentile(terminal, 0.95),
    semanticJourneyP95Ms: percentile(semanticJourney, 0.95),
    encoderReportedAttempts: encoder.length,
    firstProgressReportedAttempts: firstProgress.length,
    inputTokens,
    outputTokens,
    estimatedCostUsd: round(estimatedCostUsd, 6),
    estimatedSuccessfulUsageCostUsd: round(estimatedCostUsd, 6),
    estimatedCostUsdIsLowerBound: unpricedFailedAttempts > 0,
    unpricedFailedAttempts,
    categoryResolution,
    categoryResolutionRequests: records.reduce(
      (sum, entry) => sum + (entry.categoryResolutionRequests ?? 0),
      0,
    ),
  };
  const hardGates = {
    completeProductionRuns:
      total === SEARCH_CANARY_THRESHOLDS.cases &&
      records.every((entry) => entry.semanticSucceeded),
    completeLiteralBaselines: records.every((entry) => entry.baselineSucceeded),
    baselineComparable:
      baselineReviewed > 0 &&
      baselineComparableCases >=
        Math.ceil(total * SEARCH_CANARY_THRESHOLDS.baselineComparableFraction),
    allCasesUsedKimi: records.every((entry) => entry.kimiUsed),
    allUsageReported: records.every((entry) => entry.usageReported),
    schemaPass:
      metrics.schemaPassRate >= SEARCH_CANARY_THRESHOLDS.schemaPassRate,
    executablePlans:
      metrics.executablePlanRate >=
      SEARCH_CANARY_THRESHOLDS.executablePlanRate,
    precisionAt10:
      metrics.precisionAt10 >= SEARCH_CANARY_THRESHOLDS.precisionAt10,
    relevantLeadParity: relevantUniqueLeads >= baselineRelevantUniqueLeads,
    relevantLeadGainTarget:
      metrics.relevantLeadGain >= SEARCH_CANARY_THRESHOLDS.relevantLeadGain,
    precisionDelta:
      metrics.precisionDelta !== null &&
      metrics.precisionDelta >= SEARCH_CANARY_THRESHOLDS.precisionDelta,
    deadline: allAttempts.every(
      (entry) =>
        entry.terminalMs <= SEARCH_CANARY_THRESHOLDS.requestDeadlineMs,
    ),
    safetyViolations,
  };
  const sloObservations = {
    firstProgressP95TargetMet:
      metrics.firstProgressP95Ms !== null &&
      metrics.firstProgressP95Ms <=
        SEARCH_CANARY_THRESHOLDS.firstProgressP95Ms,
    encoderP95TargetMet:
      metrics.encoderP95Ms !== null &&
      metrics.encoderP95Ms <= SEARCH_CANARY_THRESHOLDS.encoderP95Ms,
    terminalP95TargetMet:
      metrics.terminalP95Ms <= SEARCH_CANARY_THRESHOLDS.terminalP95Ms,
    globalDeadlineMet: hardGates.deadline,
  };
  const caseMetrics = records.map((entry) => ({
    id: entry.id,
    semanticReviewed: entry.semanticReviewed,
    semanticRelevant: entry.semanticRelevant,
    semanticPrecisionAt10: round(
      ratio(entry.semanticRelevant, SEARCH_CANARY_ATTAINABLE_POLICY.topK),
    ),
    attainablePoolReviewed: entry.attainablePoolReviewed,
    attainablePoolRelevant: entry.attainablePoolRelevant,
    attainableRelevantAt10: Math.min(
      SEARCH_CANARY_ATTAINABLE_POLICY.topK,
      entry.attainablePoolRelevant,
    ),
    conditionalRankerRecallAt10: round(
      ratio(
        entry.semanticRelevant,
        Math.min(
          SEARCH_CANARY_ATTAINABLE_POLICY.topK,
          entry.attainablePoolRelevant,
        ),
      ),
    ),
    providerCoverage: entry.providerCoverage ?? {},
    baselineReviewed: entry.baselineReviewed,
    baselineRelevant: entry.baselineRelevant,
    baselinePrecisionAt10: round(
      ratio(
        entry.baselineRelevant,
        SEARCH_CANARY_ATTAINABLE_POLICY.literalBaselineLimit,
      ),
    ),
  }));
  const decision =
    Object.entries(hardGates).every(([key, value]) =>
      key === "safetyViolations" ? value === 0 : value === true,
    )
      ? "PASS"
      : "FAIL";

  return {
    evaluation: "LeadRadar production search Kimi + Geoapify canary",
    aggregateOnly: true,
    versions: {
      app: versions.appVersion,
      model: versions.modelId,
      modelPolicy: versions.modelPolicyVersion,
      transportSchema: versions.transportSchemaVersion,
      prompt: versions.promptVersion,
      semanticIntentSchema: versions.semanticIntentSchemaVersion,
      searchPlanSchema: versions.searchPlanSchemaVersion,
      decisionPolicy: versions.decisionPolicyVersion,
      compilerPolicy: versions.compilerPolicyVersion,
      providerCatalog: versions.providerCatalogVersion,
      providerCatalogChecksum: versions.providerCatalogChecksum,
      productionBundleSha256: versions.productionBundleSha256,
      canaryHarnessSha256: versions.canaryHarnessSha256,
      evaluationPolicy: SEARCH_CANARY_EVALUATION_POLICY_VERSION,
      attainablePolicy: SEARCH_CANARY_ATTAINABLE_POLICY,
      caseSetChecksum: searchCanaryCaseSetChecksum(),
      rubric: SEARCH_CANARY_RUBRIC_VERSION,
      rubricChecksum: createHash("sha256")
        .update(JSON.stringify(SEARCH_CANARY_RUBRIC))
        .digest("hex"),
      thresholds: SEARCH_CANARY_THRESHOLDS,
      runtimeProfile: versions.runtimeProfile ?? null,
      pricingUsdPerMillion: {
        input: versions.inputUsdPerMillion,
        output: versions.outputUsdPerMillion,
      },
    },
    sampleCounts: {
      cases: total,
      cities: coverage.cities.length,
      countries: coverage.countryCodes.length,
      novelBusinessTypes: coverage.novelBusinessTypes,
      mixedLanguageCases: coverage.mixedLanguageCases,
      semanticReviewed,
      attainablePoolReviewed,
      attainablePoolRelevant,
      baselineReviewed,
    },
    caseMetrics,
    metrics,
    hardGates,
    sloObservations,
    decisionSupport: {
      executedArmPool: {
        scope: SEARCH_CANARY_ATTAINABLE_POLICY.measurementScope,
        maxCandidatesPerCase:
          SEARCH_CANARY_ATTAINABLE_POLICY.maxPoolCandidatesPerCase,
        attainableAt10Threshold:
          SEARCH_CANARY_ATTAINABLE_POLICY.attainableAt10Threshold,
        measurementValid: attainableMeasurementValid,
        qualityGapClassification,
        rankerOnlyTuningEligible:
          attainableMeasurementValid &&
          attainableAt10 >=
          SEARCH_CANARY_ATTAINABLE_POLICY.attainableAt10Threshold,
        addedProviderWork: SEARCH_CANARY_ATTAINABLE_POLICY.addedProviderWork,
        providerCoverageLimits: SEARCH_CANARY_PROVIDER_COVERAGE_LIMITS,
        observedFinalResponseProviderWork: {
          reportedCases: providerCoverageReportedCases,
          totals: {
            completedRetrievalArms:
              providerCoverageTotals.completedRetrievalArms,
            retrievalRequests: providerCoverageTotals.retrievalRequests,
            cardsAccepted: providerCoverageTotals.cardsAccepted,
            detailsRequests: providerCoverageTotals.detailsRequests,
            categoryResolutionRequests:
              providerCoverageTotals.categoryResolutionRequests,
            totalProviderRequests:
              providerCoverageTotals.totalProviderRequests,
          },
        },
        plannedFinalResponseRetrievalArms: {
          reportedCases: providerCoverageReportedCases,
          total: providerCoverageTotals.plannedRetrievalArms,
        },
      },
    },
    decision,
  };
}

export const SEARCH_CANARY_EVALUATION_POLICY_VERSION =
  "search-live-canary-v2/2026-08-21.1";
export const SEARCH_CANARY_RUBRIC_VERSION =
  "search-live-rubric-v1/2026-08-20.2";
export const SEARCH_CANARY_THRESHOLDS = Object.freeze({
  cases: 12,
  schemaPassRate: 0.95,
  executablePlanRate: 0.9,
  precisionAt10: 0.85,
  relevantLeadGain: 0.15,
  precisionDelta: -0.05,
  baselineComparableFraction: 0.75,
  firstProgressP95Ms: 500,
  encoderP95Ms: 20_000,
  terminalP95Ms: 55_000,
  requestDeadlineMs: 60_000,
});
export const SEARCH_CANARY_RUBRIC = Object.freeze([
  "Relevant: the organization itself provides the core business or service described by query and description.",
  "Related queries are supporting synonyms, not permission to include an excluded or merely adjacent business.",
  "A specific provider category may support an opaque name; a generic category alone is insufficient.",
  "When evidence is insufficient or conflicting, do not mark the candidate relevant.",
  "Submit only 1-based ranks shown in the active semantic production pool and literal baseline lists.",
]);
