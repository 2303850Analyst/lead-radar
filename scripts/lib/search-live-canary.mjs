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
  return (
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
    Number.isInteger(record.baselineCandidateCount) &&
    record.baselineCandidateCount >= 0 &&
    record.baselineCandidateCount <= 10 &&
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
  const fixedPrecisionSlots = total * 10;
  const precisionAt10 = ratio(semanticRelevant, fixedPrecisionSlots);
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
    semanticPrecisionAt10: round(ratio(entry.semanticRelevant, 10)),
    baselineReviewed: entry.baselineReviewed,
    baselineRelevant: entry.baselineRelevant,
    baselinePrecisionAt10: round(ratio(entry.baselineRelevant, 10)),
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
      baselineReviewed,
    },
    caseMetrics,
    metrics,
    hardGates,
    sloObservations,
    decision,
  };
}

export const SEARCH_CANARY_EVALUATION_POLICY_VERSION =
  "search-live-canary-v2/2026-08-20.3";
export const SEARCH_CANARY_RUBRIC_VERSION =
  "search-live-rubric-v1/2026-08-20.1";
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
  "Submit only 1-based ranks shown in the active semantic and literal lists.",
]);
