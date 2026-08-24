import type {
  Lead,
  LeadRelevance,
  RequirementMatchStatus,
  SearchPayload,
  SearchProgressEvent,
  SearchResponse,
} from "../types";
import type { SemanticIntentV2 } from "../search-planner/types";
import {
  SearchProviderError,
  type SearchProvider,
  type SearchProviderOptions,
} from "./types";

const DGIS_ENDPOINT = "https://catalog.api.2gis.com/3.0/items";
const MAX_ARMS = 3;
const DEMO_PAGE_SIZE = 10;
const DEMO_MAX_PAGES = 5;
const PRODUCTION_PAGE_SIZE = 50;
const DEFAULT_PRODUCTION_MAX_PAGES = 20;
const ABSOLUTE_PRODUCTION_MAX_PAGES = 100;
const MAX_RADIUS_METERS = 50_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 2;
const PROVIDER_ID = "2gis" as SearchProvider["id"];

const BASE_REQUEST_FIELDS = [
  "items.point",
  "items.full_address_name",
  "items.rubrics",
  "items.org",
  "items.brand",
  "items.schedule",
  "items.description",
  "items.flags",
  "items.reviews",
];

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type TwoGisProviderOptions = {
  fetch?: FetchLike;
  endpoint?: string;
  requestTimeoutMs?: number;
  contactsEnabled?: boolean;
  demoMode?: boolean;
  maxPages?: number;
  exportEnabled?: boolean;
};

export type TwoGisPaginationLimits = {
  pageSize: number;
  maxPages: number;
  maxResultsPerArm: number;
};

type TwoGisPoint = {
  lon?: unknown;
  lat?: unknown;
};

type TwoGisRubric = {
  id?: unknown;
  name?: unknown;
  alias?: unknown;
};

type TwoGisContact = {
  type?: unknown;
  text?: unknown;
  value?: unknown;
  url?: unknown;
};

type TwoGisItem = {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  address_name?: unknown;
  full_address_name?: unknown;
  address_comment?: unknown;
  building_name?: unknown;
  full_name?: unknown;
  purpose_name?: unknown;
  description?: unknown;
  point?: TwoGisPoint;
  rubrics?: TwoGisRubric[];
  contact_groups?: Array<{ contacts?: TwoGisContact[] }>;
  floor_name?: unknown;
};

type TwoGisResponse = {
  meta?: {
    code?: unknown;
  };
  result?: {
    items?: unknown;
    total?: unknown;
  };
};

export type TwoGisTextArm = {
  id: string;
  type: "precision" | "recall" | "adjacent" | "fallback";
  role: "primary" | "adjacent" | "fallback";
  priority: number;
  query: string;
  origin:
    | "coreBusinessTypes"
    | "retrievalTerms.precision"
    | "retrievalTerms.recall"
    | "productsAndServices"
    | "adjacentBusinessTypes"
    | "source.primaryQuery"
    | "source.relatedQueries";
};

type ObservedItem = {
  item: TwoGisItem;
  externalIds: Set<string>;
  arms: TwoGisTextArm[];
};

type RequestResult = {
  items: TwoGisItem[];
  requests: number;
  total: number | null;
};

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  return Number.isInteger(value) && value !== undefined && value > 0
    ? Math.min(value, maximum)
    : fallback;
}

export function twoGisPaginationLimits(
  options: Pick<TwoGisProviderOptions, "demoMode" | "maxPages"> = {},
): TwoGisPaginationLimits {
  const demoMode = options.demoMode !== false;
  const pageSize = demoMode ? DEMO_PAGE_SIZE : PRODUCTION_PAGE_SIZE;
  const maxPages = demoMode
    ? boundedPositiveInteger(options.maxPages, DEMO_MAX_PAGES, DEMO_MAX_PAGES)
    : boundedPositiveInteger(
        options.maxPages,
        DEFAULT_PRODUCTION_MAX_PAGES,
        ABSOLUTE_PRODUCTION_MAX_PAGES,
      );
  return { pageSize, maxPages, maxResultsPerArm: pageSize * maxPages };
}

const LOCALES: Record<string, string> = {
  "ru-RU": "ru_RU",
  "ru-BY": "ru_BY",
  "be-BY": "ru_BY",
  "ru-KZ": "ru_KZ",
  "kk-KZ": "kk_KZ",
};

function stringValue(value: unknown, maximum = 500): string | null {
  if (typeof value !== "string") return null;
  const normalized = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length >= 2);
}

function tokenMatches(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length < 6 || right.length < 6) return false;
  const prefixLength = Math.min(6, left.length - 2, right.length - 2);
  return prefixLength >= 4 && left.slice(0, prefixLength) === right.slice(0, prefixLength);
}

function termCoverage(text: string, term: string): number {
  const haystack = tokens(text);
  const needles = tokens(term);
  if (!needles.length || !haystack.length) return 0;
  const matched = needles.filter((needle) =>
    haystack.some((candidate) => tokenMatches(candidate, needle)),
  ).length;
  return matched / needles.length;
}

function boundedQuery(value: unknown): string | null {
  const query = stringValue(value, 500);
  if (!query) return null;
  const normalized = normalizeText(query);
  return normalized.length >= 2 ? query : null;
}

/**
 * Builds a bounded free-text portfolio. It deliberately consumes only the
 * accepted semantic intent and never invents provider rubric IDs or aliases.
 */
export function compileTwoGisTextArms(
  payload: SearchPayload,
  semanticIntent?: SemanticIntentV2,
): TwoGisTextArm[] {
  const candidates: Array<Omit<TwoGisTextArm, "id" | "priority">> = [];
  const append = (
    values: readonly string[] | undefined,
    type: TwoGisTextArm["type"],
    role: TwoGisTextArm["role"],
    origin: TwoGisTextArm["origin"],
  ) => {
    for (const value of values ?? []) {
      const query = boundedQuery(value);
      if (query) candidates.push({ query, type, role, origin });
    }
  };

  append(
    [payload.primaryQuery],
    semanticIntent ? "precision" : "fallback",
    "primary",
    "source.primaryQuery",
  );
  if (semanticIntent) {
    append(
      semanticIntent.coreBusinessTypes,
      "precision",
      "primary",
      "coreBusinessTypes",
    );
    append(
      semanticIntent.retrievalTerms.precision,
      "precision",
      "primary",
      "retrievalTerms.precision",
    );
    append(
      semanticIntent.retrievalTerms.recall,
      "recall",
      "fallback",
      "retrievalTerms.recall",
    );
    append(
      semanticIntent.productsAndServices,
      "recall",
      "fallback",
      "productsAndServices",
    );
    append(
      semanticIntent.adjacentBusinessTypes,
      "adjacent",
      "adjacent",
      "adjacentBusinessTypes",
    );
  } else {
    append(
      payload.relatedQueries,
      "fallback",
      "fallback",
      "source.relatedQueries",
    );
  }

  const seen = new Set<string>();
  const unique = candidates.filter((candidate) => {
    const key = normalizeText(candidate.query);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.slice(0, MAX_ARMS).map((candidate, index) => ({
    ...candidate,
    id: `2gis-text-${index + 1}`,
    priority: index + 1,
  }));
}

function validCoordinates(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    value[0] >= -180 &&
    value[0] <= 180 &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1]) &&
    value[1] >= -90 &&
    value[1] <= 90
  );
}

function itemCoordinates(item: TwoGisItem): [number, number] | null {
  const candidate: unknown = [item.point?.lon, item.point?.lat];
  return validCoordinates(candidate) ? candidate : null;
}

function externalId(item: TwoGisItem): string | null {
  return stringValue(item.id, 160);
}

function itemName(item: TwoGisItem): string | null {
  return stringValue(item.name, 240);
}

function itemAddress(item: TwoGisItem): string {
  return (
    stringValue(item.full_address_name, 500) ??
    stringValue(item.address_name, 500) ??
    "Адрес не указан"
  );
}

function itemRubrics(item: TwoGisItem): Array<{ id: string; name: string }> {
  if (!Array.isArray(item.rubrics)) return [];
  const seen = new Set<string>();
  const result: Array<{ id: string; name: string }> = [];
  for (const rubric of item.rubrics) {
    if (!rubric || typeof rubric !== "object") continue;
    const name = stringValue(rubric.name, 160) ?? stringValue(rubric.alias, 160);
    if (!name) continue;
    const id = stringValue(rubric.id, 80) ?? name;
    const key = `${id}:${normalizeText(name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ id, name });
  }
  return result;
}

function identityKey(item: TwoGisItem): string | null {
  const id = externalId(item);
  if (id) return `id:${id}`;
  const name = itemName(item);
  const coordinates = itemCoordinates(item);
  if (!name || !coordinates) return null;
  return `fallback:${normalizeText(name)}:${coordinates[0].toFixed(5)}:${coordinates[1].toFixed(5)}`;
}

function mergeObservedItem(
  observations: Map<string, ObservedItem>,
  item: TwoGisItem,
  arm: TwoGisTextArm,
): void {
  if (stringValue(item.type, 80) && item.type !== "branch") return;
  if (!itemName(item) || !itemCoordinates(item)) return;
  const key = identityKey(item);
  if (!key) return;
  const id = externalId(item);
  const existing = observations.get(key);
  if (!existing) {
    observations.set(key, {
      item,
      externalIds: new Set(id ? [id] : []),
      arms: [arm],
    });
    return;
  }
  if (id) existing.externalIds.add(id);
  if (!existing.arms.some((candidate) => candidate.id === arm.id)) {
    existing.arms.push(arm);
  }
  if (itemRubrics(item).length > itemRubrics(existing.item).length) {
    existing.item = item;
  }
}

function allContacts(item: TwoGisItem): TwoGisContact[] {
  if (!Array.isArray(item.contact_groups)) return [];
  return item.contact_groups.flatMap((group) =>
    Array.isArray(group?.contacts) ? group.contacts : [],
  );
}

function contactValue(contact: TwoGisContact): string | null {
  return (
    stringValue(contact.value, 500) ??
    stringValue(contact.text, 500) ??
    stringValue(contact.url, 500)
  );
}

function firstContact(item: TwoGisItem, acceptedTypes: readonly string[]): string | null {
  const accepted = new Set(acceptedTypes);
  for (const contact of allContacts(item)) {
    const type = normalizeText(stringValue(contact.type, 80) ?? "");
    if (!accepted.has(type)) continue;
    const value = contactValue(contact);
    if (value) return value;
  }
  return null;
}

function safeHttpUrl(value: string | null): string | null {
  if (!value) return null;
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function socialUrl(item: TwoGisItem, service: "telegram" | "vk"): string | null {
  const typeNames =
    service === "telegram" ? ["telegram"] : ["vk", "vkontakte", "вконтакте"];
  const explicit = safeHttpUrl(firstContact(item, typeNames));
  if (explicit) return explicit;
  for (const contact of allContacts(item)) {
    const url = safeHttpUrl(contactValue(contact));
    if (!url) continue;
    const host = new URL(url).hostname.toLowerCase();
    if (service === "telegram" && (host === "t.me" || host.endsWith(".t.me"))) {
      return url;
    }
    if (service === "vk" && (host === "vk.com" || host.endsWith(".vk.com"))) {
      return url;
    }
  }
  return null;
}

function semanticBusinessTerms(
  payload: SearchPayload,
  semanticIntent: SemanticIntentV2 | undefined,
): { strong: string[]; all: string[]; excluded: string[] } {
  const unique = (values: Array<string | null | undefined>) => {
    const seen = new Set<string>();
    return values.filter((value): value is string => {
      if (!value) return false;
      const key = normalizeText(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const strong = unique([
    payload.primaryQuery,
    ...(semanticIntent?.coreBusinessTypes ?? []),
    ...(semanticIntent?.retrievalTerms.precision ?? []),
  ]);
  const all = unique([
    ...strong,
    ...(semanticIntent?.retrievalTerms.recall ?? []),
    ...(semanticIntent?.productsAndServices ?? []),
    ...(semanticIntent?.adjacentBusinessTypes ?? []),
  ]);
  const excluded = unique([
    ...payload.excludeQueries,
    ...(semanticIntent?.excludedBusinessTypes ?? []),
    ...(semanticIntent?.retrievalTerms.exclude ?? []),
  ]);

  // A broad term such as "bar" is not independent confirmation when a more
  // specific accepted term such as "hookah bar" exists.
  const specificStrong = strong.filter((candidate) => {
    const candidateTokens = tokens(candidate);
    return !strong.some((other) => {
      if (other === candidate) return false;
      const otherTokens = tokens(other);
      return (
        otherTokens.length > candidateTokens.length &&
        candidateTokens.every((token) =>
          otherTokens.some((otherToken) => tokenMatches(token, otherToken)),
        )
      );
    });
  });
  return { strong: specificStrong.length ? specificStrong : strong, all, excluded };
}

function relevanceForItem(
  candidateId: string,
  item: TwoGisItem,
  payload: SearchPayload,
  semanticIntent: SemanticIntentV2 | undefined,
): LeadRelevance {
  const rubrics = itemRubrics(item);
  const name = itemName(item) ?? "";
  const categoryText = [
    ...rubrics.map((rubric) => rubric.name),
    stringValue(item.purpose_name, 160),
  ]
    .filter(Boolean)
    .join(" ");
  const description = stringValue(item.description, 800) ?? "";
  const sourceText = [name, categoryText, description].join(" ");
  const terms = semanticBusinessTerms(payload, semanticIntent);
  const excluded = terms.excluded.find((term) => termCoverage(sourceText, term) === 1);
  const exact = terms.strong.find((term) => termCoverage(sourceText, term) === 1);
  const partial = Math.max(0, ...terms.all.map((term) => termCoverage(sourceText, term)));
  const evidence: LeadRelevance["evidence"] = [];

  if (exact) {
    if (termCoverage(name, exact) === 1) {
      evidence.push({ field: "name", value: name });
    }
    for (const rubric of rubrics) {
      if (termCoverage(rubric.name, exact) > 0) {
        evidence.push({ field: "providerCategoryIds", value: rubric.id });
      }
    }
    if (description && termCoverage(description, exact) > 0) {
      evidence.push({ field: "sourceDescription", value: description.slice(0, 240) });
    }
  }

  if (excluded && !exact) {
    return {
      candidateId,
      status: "rejected",
      confidence: 0.9,
      evidence,
      reasonCodes: ["DGIS_EXCLUSION_EVIDENCE"],
      source: "deterministic",
    };
  }
  if (exact) {
    return {
      candidateId,
      status: "matched",
      confidence: 0.9,
      evidence,
      reasonCodes: ["DGIS_EXACT_TEXT_EVIDENCE"],
      source: "deterministic",
    };
  }
  return {
    candidateId,
    status: "maybe",
    confidence: partial > 0 ? Math.min(0.65, 0.25 + partial * 0.4) : 0.25,
    evidence: [],
    reasonCodes: [partial > 0 ? "DGIS_WEAK_TEXT_EVIDENCE" : "DGIS_CANDIDATE_ONLY"],
    source: "deterministic",
  };
}

function requestedFloorKinds(requirement: string): Set<string> {
  const normalized = normalizeText(requirement);
  const result = new Set<string>();
  if (/(^|\s)(перв[\p{L}]*|1|first|ground)(\s|$)/u.test(normalized)) result.add("1");
  if (/(^|\s)(цокол[\p{L}]*|подвал[\p{L}]*|минус\s*перв[\p{L}]*|-1|basement)(\s|$)/u.test(normalized)) {
    result.add("-1");
  }
  return result;
}

function observedFloorKinds(item: TwoGisItem): Set<string> {
  const explicit = normalizeText(
    [stringValue(item.address_comment, 240), stringValue(item.floor_name, 80)]
      .filter(Boolean)
      .join(" "),
  );
  const result = new Set<string>();
  if (/(^|\s)(1|перв[\p{L}]*|first|ground)(?:\s*(?:этаж|floor))?(\s|$)/u.test(explicit)) result.add("1");
  if (/(^|\s)(-1|цокол[\p{L}]*|подвал[\p{L}]*|basement|минус\s*перв[\p{L}]*)(\s|$)/u.test(explicit)) {
    result.add("-1");
  }
  for (const match of explicit.matchAll(/(?:^|\s)(\d{1,2})\s*(?:этаж|floor)(?=\s|$)/gu)) {
    result.add(match[1]);
  }
  return result;
}

function evaluateFloorRequirement(
  requirement: string,
  item: TwoGisItem,
): RequirementMatchStatus {
  const requested = requestedFloorKinds(requirement);
  const observed = observedFloorKinds(item);
  if (!observed.size) return "unknown";
  const matches = [...observed].some((value) => requested.has(value));
  const conflicts = [...observed].some((value) => !requested.has(value));
  if (matches && conflicts) return "conflicting";
  return matches ? "confirmed_match" : "confirmed_mismatch";
}

function evaluateResidentialRequirement(
  item: TwoGisItem,
): RequirementMatchStatus {
  const buildingText = normalizeText(
    [stringValue(item.building_name, 240), stringValue(item.full_name, 500)]
      .filter(Boolean)
      .join(" "),
  );
  if (!buildingText) return "unknown";
  const positive = /(жил[\p{L}]*\s+(дом|здан[\p{L}]*|комплекс)|(^|\s)жк(\s|$)|residential)/u.test(
    buildingText,
  );
  const negative = /(бизнес\s*центр|(^|\s)бц(\s|$)|торгов[\p{L}]*\s+центр|(^|\s)тц(\s|$)|офисн[\p{L}]*\s+центр|административн[\p{L}]*\s+здан[\p{L}]*)/u.test(
    buildingText,
  );
  if (positive && negative) return "conflicting";
  if (positive) return "confirmed_match";
  if (negative) return "confirmed_mismatch";
  return "unknown";
}

function requirementsForItem(
  item: TwoGisItem,
  payload: SearchPayload,
  semanticIntent: SemanticIntentV2 | undefined,
): Lead["requirements"] {
  if (!semanticIntent) return [];
  const businessTerms = new Set(
    semanticBusinessTerms(payload, semanticIntent).all.map(normalizeText),
  );
  const factText = normalizeText(
    [
      stringValue(item.address_comment, 240),
      stringValue(item.floor_name, 80),
      stringValue(item.building_name, 240),
      stringValue(item.full_name, 500),
      stringValue(item.description, 800),
    ]
      .filter(Boolean)
      .join(" "),
  );
  return [...new Set(semanticIntent.includeSignals)]
    .filter((requirement) => !businessTerms.has(normalizeText(requirement)))
    .map((requirement) => {
      const normalized = normalizeText(requirement);
      let status: RequirementMatchStatus;
      if (/(этаж|цокол|подвал|floor|basement)/u.test(normalized)) {
        status = evaluateFloorRequirement(requirement, item);
      } else if (/(жил[\p{L}]*\s+(дом|здан[\p{L}]*)|(^|\s)жк(\s|$)|residential)/u.test(normalized)) {
        status = evaluateResidentialRequirement(item);
      } else {
        status = termCoverage(factText, requirement) === 1 ? "confirmed_match" : "unknown";
      }
      return { requirement, status };
    });
}

function scoreLead(
  relevance: LeadRelevance,
  hasPhone: boolean,
  hasWebsite: boolean,
  primaryFound: boolean,
): Lead["scores"] {
  const confidence =
    relevance.status === "matched" ? 85 : relevance.status === "maybe" ? 50 : 20;
  return {
    opportunity: Math.min(100, 40 + (!hasWebsite ? 25 : 0) + (!hasPhone ? 15 : 0)),
    hiddenness: primaryFound ? 30 : 65,
    confidence: Math.min(100, confidence + (hasPhone ? 5 : 0) + (hasWebsite ? 5 : 0)),
  };
}

function normalizeLead(
  observation: ObservedItem,
  payload: SearchPayload,
  semanticIntent: SemanticIntentV2 | undefined,
  observedAt: string,
  contactsEnabled: boolean,
): Lead {
  const item = observation.item;
  const rubrics = itemRubrics(item);
  const ids = [...observation.externalIds].sort();
  const fallbackId = identityKey(item)?.replace(/[^a-z\d]+/gi, "-") ?? "candidate";
  const candidateId = `2gis-${ids[0] ?? fallbackId}`;
  const relevance = relevanceForItem(candidateId, item, payload, semanticIntent);
  const phone = firstContact(item, ["phone"]);
  const email = firstContact(item, ["email"]);
  const website = safeHttpUrl(firstContact(item, ["website", "url"]));
  const telegram = socialUrl(item, "telegram");
  const vk = socialUrl(item, "vk");
  const primaryFound = observation.arms.some((arm) => arm.role === "primary");
  const matchedQueries = observation.arms.map((arm) => arm.query);
  const scores = scoreLead(relevance, Boolean(phone), Boolean(website), primaryFound);
  const digitalProblems: string[] = [];
  if (contactsEnabled && !website) {
    digitalProblems.push("Сайт не указан в доступных полях 2ГИС");
  }
  if (contactsEnabled && !phone) {
    digitalProblems.push("Телефон не указан в доступных полях 2ГИС");
  }

  return {
    id: candidateId,
    name: itemName(item) ?? "Организация",
    category:
      rubrics[0]?.name ?? stringValue(item.purpose_name, 160) ?? "Организация",
    tags: rubrics.map((rubric) => rubric.name),
    location: {
      address: itemAddress(item),
      coordinates: itemCoordinates(item)!,
    },
    phone,
    email,
    website: {
      // A missing optional/permissioned field is not proof that no site exists.
      sourceStatus: website ? "listed" : "not_checked",
      verifiedStatus: "not_checked",
      url: website,
    },
    socials: {
      ...(telegram ? { telegram } : {}),
      ...(vk ? { vk } : {}),
    },
    digitalProblems,
    discovery: {
      matchedQueries,
      hiddenReason:
        relevance.status === "matched"
          ? "Тип бизнеса подтверждён текстом карточки 2ГИС"
          : "Карточка найдена текстовым поиском 2ГИС, но требует проверки релевантности",
      observedAt,
      source: PROVIDER_ID,
      primaryFound,
    },
    sources: (ids.length ? ids : [fallbackId]).map((id) => ({
      provider: PROVIDER_ID,
      externalId: id,
      observedAt,
    })),
    scores,
    status: relevance.status === "matched" && (phone || website) ? "Новый" : "Проверить",
    summary: `Карточка обнаружена через текстовый поиск 2ГИС. ${
      relevance.status === "matched"
        ? "Тип бизнеса подтверждён доступными полями карточки."
        : "Совпадение с исходным типом бизнеса пока не подтверждено."
    } Контакты отражают только поля, доступные текущему ключу.`,
    recommendedOffer:
      payload.offer ||
      (payload.services.length
        ? `После ручной проверки предложить: ${payload.services.join(", ")}.`
        : "Сначала вручную подтвердить деятельность и актуальность контактов."),
    possibleBranches: [],
    relevance,
    requirements: requirementsForItem(item, payload, semanticIntent),
  };
}

function responseCode(data: TwoGisResponse): number | null {
  const code = data.meta?.code;
  return typeof code === "number" && Number.isInteger(code) ? code : null;
}

function errorForStatus(status: number): SearchProviderError {
  if (status === 400 || status === 422) {
    return new SearchProviderError(
      "2ГИС отклонил параметры поискового запроса",
      "DGIS_INVALID_REQUEST",
    );
  }
  if (status === 401 || status === 403) {
    return new SearchProviderError(
      "Ключ 2ГИС недействителен или не имеет доступа к Places API",
      "DGIS_AUTH_FAILED",
    );
  }
  if (status === 429) {
    return new SearchProviderError("Превышен лимит запросов 2ГИС", "DGIS_RATE_LIMIT");
  }
  return new SearchProviderError(
    "2ГИС временно недоступен",
    "DGIS_UPSTREAM_UNAVAILABLE",
  );
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function throwIfAborted(options: SearchProviderOptions): void {
  options.runtime?.throwIfAborted();
  const signal = options.signal ?? options.runtime?.signal;
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === "SearchRuntimeError") throw reason;
  throw new SearchProviderError("Поиск отменён", "SEARCH_CANCELLED");
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: URL,
  timeoutMs: number,
  options: SearchProviderOptions,
): Promise<Response> {
  throwIfAborted(options);
  if (timeoutMs < 1) {
    options.runtime?.throwIfAborted();
    throw new SearchProviderError(
      "Общий лимит времени поиска исчерпан",
      "SEARCH_DEADLINE_EXCEEDED",
    );
  }
  const controller = new AbortController();
  const externalSignals = [options.signal, options.runtime?.signal].filter(
    (signal): signal is AbortSignal => Boolean(signal),
  );
  const forwardAbort = (signal: AbortSignal) => () => controller.abort(signal.reason);
  const listeners = externalSignals.map((signal) => {
    const listener = forwardAbort(signal);
    signal.addEventListener("abort", listener, { once: true });
    return { signal, listener };
  });
  const timer = setTimeout(
    () => controller.abort(new DOMException("2GIS request timed out", "TimeoutError")),
    timeoutMs,
  );
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    for (const { signal, listener } of listeners) {
      signal.removeEventListener("abort", listener);
    }
  }
}

export class TwoGisProvider implements SearchProvider {
  readonly id = PROVIDER_ID;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;
  private readonly requestTimeoutMs: number;
  private readonly contactsEnabled: boolean;
  private readonly exportEnabled: boolean;
  private readonly pageSize: number;
  private readonly maxPages: number;

  constructor(apiKey: string, options: TwoGisProviderOptions = {}) {
    this.apiKey = apiKey.trim();
    if (!this.apiKey) {
      throw new SearchProviderError(
        "Серверный ключ 2ГИС не настроен",
        "DGIS_NOT_CONFIGURED",
      );
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.endpoint = options.endpoint ?? DGIS_ENDPOINT;
    this.contactsEnabled = options.contactsEnabled ?? false;
    this.exportEnabled = options.exportEnabled ?? false;
    const pagination = twoGisPaginationLimits(options);
    this.pageSize = pagination.pageSize;
    this.maxPages = pagination.maxPages;
    this.requestTimeoutMs = Math.max(
      1,
      Math.min(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, 60_000),
    );
  }

  private requestUrl(
    query: string,
    center: [number, number],
    radiusKm: number,
    locale: string | undefined,
    page: number,
  ): URL {
    if (!Number.isFinite(radiusKm) || radiusKm < 0) {
      throw new SearchProviderError(
        "Радиус поиска 2ГИС должен быть неотрицательным числом",
        "DGIS_INVALID_REQUEST",
      );
    }
    if (radiusKm > MAX_RADIUS_METERS / 1_000) {
      throw new SearchProviderError(
        "2ГИС поддерживает радиус не более 50 км",
        "DGIS_RADIUS_TOO_LARGE",
      );
    }
    const url = new URL(this.endpoint);
    const point = `${center[0]},${center[1]}`;
    const radius = Math.max(0, Math.round(radiusKm * 1_000));
    url.searchParams.set("q", query);
    url.searchParams.set("type", "branch");
    url.searchParams.set("point", point);
    url.searchParams.set("location", point);
    url.searchParams.set("radius", String(radius));
    url.searchParams.set("sort", "relevance");
    url.searchParams.set("locale", LOCALES[locale ?? "ru-RU"] ?? "ru_RU");
    url.searchParams.set("page_size", String(this.pageSize));
    url.searchParams.set("page", String(page));
    url.searchParams.set("search_is_query_text_complete", "true");
    url.searchParams.set("search_input_method", "software_generated");
    url.searchParams.set(
      "fields",
      [...BASE_REQUEST_FIELDS, ...(this.contactsEnabled ? ["items.contact_groups"] : [])].join(","),
    );
    url.searchParams.set("key", this.apiKey);
    return url;
  }

  private async request(
    url: URL,
    options: SearchProviderOptions,
  ): Promise<RequestResult> {
    let requests = 0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      throwIfAborted(options);
      const timeoutMs = Math.min(
        this.requestTimeoutMs,
        options.runtime?.stageTimeoutMs(this.requestTimeoutMs) ?? this.requestTimeoutMs,
      );
      let response: Response;
      try {
        requests += 1;
        response = await fetchWithTimeout(this.fetchImpl, url, timeoutMs, options);
      } catch (error) {
        throwIfAborted(options);
        if (error instanceof SearchProviderError) throw error;
        const isTimeout = error instanceof Error && error.name === "TimeoutError";
        if (attempt + 1 < MAX_ATTEMPTS) continue;
        throw new SearchProviderError(
          isTimeout ? "2ГИС не ответил вовремя" : "Не удалось подключиться к 2ГИС",
          isTimeout ? "DGIS_TIMEOUT" : "DGIS_NETWORK_ERROR",
        );
      }

      if (response.status === 404) return { items: [], requests, total: 0 };
      if (!response.ok) {
        if (retryableStatus(response.status) && attempt + 1 < MAX_ATTEMPTS) continue;
        throw errorForStatus(response.status);
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new SearchProviderError(
          "Не удалось прочитать ответ 2ГИС",
          "DGIS_INVALID_RESPONSE",
        );
      }
      if (text.length > MAX_RESPONSE_BYTES) {
        throw new SearchProviderError(
          "2ГИС вернул слишком большой ответ",
          "DGIS_RESPONSE_TOO_LARGE",
        );
      }
      let data: TwoGisResponse;
      try {
        data = JSON.parse(text) as TwoGisResponse;
      } catch {
        throw new SearchProviderError(
          "2ГИС вернул ответ неизвестного формата",
          "DGIS_INVALID_RESPONSE",
        );
      }
      const metaCode = responseCode(data);
      if (metaCode === 404) return { items: [], requests, total: 0 };
      if (metaCode !== null && metaCode !== 200) {
        if (retryableStatus(metaCode) && attempt + 1 < MAX_ATTEMPTS) continue;
        throw errorForStatus(metaCode);
      }
      const rawItems = data.result?.items;
      if (!Array.isArray(rawItems)) {
        if (data.result?.total === 0) return { items: [], requests, total: 0 };
        throw new SearchProviderError(
          "2ГИС вернул ответ неизвестного формата",
          "DGIS_INVALID_RESPONSE",
        );
      }
      return {
        items: rawItems.filter(
          (item): item is TwoGisItem => Boolean(item) && typeof item === "object",
        ),
        requests,
        total:
          typeof data.result?.total === "number" &&
          Number.isInteger(data.result.total) &&
          data.result.total >= 0
            ? data.result.total
            : null,
      };
    }
    throw new SearchProviderError("2ГИС временно недоступен", "DGIS_UPSTREAM_UNAVAILABLE");
  }

  async search(
    payload: SearchPayload,
    options: SearchProviderOptions = {},
  ): Promise<SearchResponse> {
    if (!validCoordinates(payload.center)) {
      throw new SearchProviderError(
        "Для поиска 2ГИС требуется проверенный центр области",
        "DGIS_CENTER_REQUIRED",
      );
    }
    const arms = compileTwoGisTextArms(payload, options.semanticIntent);
    if (!arms.length) {
      throw new SearchProviderError(
        "Не удалось подготовить текстовый запрос для 2ГИС",
        "DGIS_QUERY_REQUIRED",
      );
    }

    const observedAt = new Date().toISOString();
    const observations = new Map<string, ObservedItem>();
    const executedArms: NonNullable<
      NonNullable<SearchResponse["provider"]["coverage"]>["executedRetrievalArms"]
    > = [];
    let completedRetrievalArms = 0;
    let upstreamRequests = 0;
    let cardsFound = 0;
    let degraded = false;
    const reportProgress = async (
      event: Omit<SearchProgressEvent, "type" | "timestamp">,
    ) => {
      throwIfAborted(options);
      await options.onProgress?.({
        type: "progress",
        ...event,
        timestamp: new Date().toISOString(),
      });
    };

    await reportProgress({
      stage: "places",
      status: "started",
      message: "Ищем организации в 2ГИС",
      completed: 0,
      total: arms.length,
    });

    armLoop: for (const arm of arms) {
      let armStarted = false;
      try {
        for (let page = 1; page <= this.maxPages; page += 1) {
          const result = await this.request(
            this.requestUrl(
              arm.query,
              payload.center,
              payload.radiusKm,
              payload.locale,
              page,
            ),
            options,
          );
          upstreamRequests += result.requests;
          cardsFound += result.items.length;
          if (!armStarted) {
            armStarted = true;
            executedArms.push({
              id: arm.id,
              planArmId: arm.id,
              type: arm.type,
              role: arm.role,
            });
          }
          for (const item of result.items) mergeObservedItem(observations, item, arm);
          await reportProgress({
            stage: "places",
            status: "running",
            message: `2ГИС: «${arm.query}», страница ${page}, кандидатов ${observations.size}`,
            completed: completedRetrievalArms,
            total: arms.length,
          });

          const reportedTotalReached =
            result.total !== null && page * this.pageSize >= result.total;
          const lastAvailablePage = result.items.length < this.pageSize;
          if (reportedTotalReached || lastAvailablePage) break;
        }
        completedRetrievalArms += 1;
        await reportProgress({
          stage: "places",
          status: "running",
          message: `2ГИС: выполнено формулировок ${completedRetrievalArms} из ${arms.length}`,
          completed: completedRetrievalArms,
          total: arms.length,
        });
      } catch (error) {
        if (error instanceof SearchProviderError && observations.size > 0) {
          degraded = true;
          break armLoop;
        }
        throw error;
      }
    }

    await reportProgress({
      stage: "places",
      status: "completed",
      message: `2ГИС вернул кандидатов: ${observations.size}`,
      completed: completedRetrievalArms,
      total: arms.length,
    });
    await reportProgress({
      stage: "normalizing",
      status: "started",
      message: "Проверяем и объединяем карточки 2ГИС",
    });

    const leads = [...observations.values()].map((observation) =>
      normalizeLead(
        observation,
        payload,
        options.semanticIntent,
        observedAt,
        this.contactsEnabled,
      ),
    );
    const relevancePriority = { matched: 0, maybe: 1, not_checked: 2, rejected: 3 };
    leads.sort(
      (left, right) =>
        relevancePriority[left.relevance?.status ?? "not_checked"] -
          relevancePriority[right.relevance?.status ?? "not_checked"] ||
        (right.relevance?.confidence ?? -1) - (left.relevance?.confidence ?? -1) ||
        right.scores.confidence - left.scores.confidence,
    );
    const relevance = {
      matched: leads.filter((lead) => lead.relevance?.status === "matched").length,
      maybe: leads.filter((lead) => lead.relevance?.status === "maybe").length,
      rejected: leads.filter((lead) => lead.relevance?.status === "rejected").length,
      notChecked: leads.filter((lead) => lead.relevance?.status === "not_checked").length,
    };
    const categories = [
      ...new Set(leads.flatMap((lead) => lead.tags).filter(Boolean)),
    ].slice(0, 100);
    const foundByPrimary = leads.filter((lead) => lead.discovery.primaryFound).length;
    const generatedAt = new Date().toISOString();

    await reportProgress({
      stage: "normalizing",
      status: "completed",
      message: `Подготовлено лидов: ${leads.length}`,
    });

    const response: SearchResponse = {
      outcome: leads.length ? "success_with_results" : "success_empty",
      mode: PROVIDER_ID,
      provider: {
        id: PROVIDER_ID,
        label: "2GIS Places API",
        queriedAt: observedAt,
        policy: {
          persistence: "contract_required",
          capabilities: {
            mapDisplay: true,
            csvExport: this.exportEnabled,
            localPersistence: false,
          },
          attributionRequired: true,
          attribution: ["2GIS"],
          rawResponsesStored: false,
        },
        coverage: {
          categories,
          retrievalArms: arms.length,
          completedRetrievalArms,
          executedRetrievalArms: executedArms,
          upstreamRequests,
          cardsAccepted: leads.length,
          detailsRequested: 0,
          detailsSucceeded: 0,
          categoryResolution: { status: "disabled", requests: 0 },
          ...(degraded
            ? {
                degradedStages: [
                  { stage: "places" as const, reason: "OPTIONAL_STAGE_UNAVAILABLE" as const },
                ],
              }
            : {}),
          relevance: { classifier: "completed", ...relevance },
        },
      },
      query: payload,
      summary: {
        cardsFound,
        uniqueLocations: leads.length,
        assumedBusinesses: leads.length,
        foundByPrimary,
        foundOnlyExpanded: leads.length - foundByPrimary,
        digitalGapCandidates: 0,
        manualReviewCandidates: leads.filter(
          (lead) => lead.relevance?.status !== "matched",
        ).length,
        relevance,
      },
      leads,
      notice:
        degraded
          ? "Часть поисковых формулировок 2ГИС завершилась технической ошибкой; показаны кандидаты из успешно выполненных запросов. Выборка не является полным реестром рынка, а использование и сохранение данных регулируются вашим договором с 2ГИС."
          : "Обнаруженная выборка 2ГИС, а не полный реестр рынка. Контакты и дополнительные поля зависят от прав API-ключа; использование и сохранение данных регулируются вашим договором с 2ГИС.",
      generatedAt,
    };
    await reportProgress({
      stage: "complete",
      status: "completed",
      message: `Поиск завершён: ${leads.length} лидов`,
    });
    return response;
  }
}
