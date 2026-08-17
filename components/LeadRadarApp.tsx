"use client";

import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileText,
  Globe2,
  Layers3,
  Mail,
  Map as MapIcon,
  MapPin,
  Menu,
  Phone,
  Plus,
  Rocket,
  Save,
  Search,
  Send,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Table2,
  Users,
  X,
} from "lucide-react";
import {
  FormEvent,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  Lead,
  LeadStatus,
  SearchPayload,
  SearchResponse,
} from "@/lib/types";
import type {
  SearchPlan,
  SearchPlanAlternative,
} from "@/lib/search-planner/types";

import LeadMap from "./LeadMap";
import LocationSelector from "./LocationSelector";
import { isSearchPlan } from "@/lib/search-planner/guards";

import SearchIntentPanel from "./SearchIntentPanel";
import SearchProgressPanel, {
  type SearchProgressPanelEvent,
} from "./SearchProgressPanel";

type Screen = "search" | "results" | "map" | "detail";

type ProviderMetadata = {
  id: string;
  label: string;
  queriedAt: string;
  policy: {
    persistence: "synthetic" | "allowed_with_attribution" | "contract_required";
    attributionRequired: boolean;
    attribution: string[];
    rawResponsesStored: boolean;
  };
};

type SearchResponseWithProvider = SearchResponse & {
  provider?: ProviderMetadata;
};

type LeadWithSources = Lead & {
  sources?: Array<{
    provider: string;
    externalId: string;
    observedAt: string;
  }>;
};

type SearchStreamMessage =
  | SearchProgressPanelEvent
  | { type: "result"; data: SearchResponse }
  | {
      type: "error";
      error: string;
      details?: string;
      code?: string;
      plan?: SearchPlan;
    };

type SearchApiFailure = {
  error?: string;
  details?: string;
  code?: string;
  plan?: SearchPlan;
};

type SearchPhase = "idle" | "planning" | "searching";

class SearchWorkflowError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly plan?: SearchPlan,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "SearchWorkflowError";
  }
}

const STORAGE_KEY = "leadradar:last-search:v2";
const TEMPLATE_KEY = "leadradar:template";
const DEFAULT_SEARCH_CENTER: [number, number] = [37.6173, 55.7558];
const SEARCH_CLIENT_TIMEOUT_MS = 62_000;

async function readSearchFailure(response: Response): Promise<SearchWorkflowError> {
  const contentType = response.headers.get("content-type") ?? "";
  let failure: SearchApiFailure | null = null;

  try {
    if (contentType.includes("application/x-ndjson")) {
      const records = (await response.text())
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SearchStreamMessage);
      const errorRecord = [...records]
        .reverse()
        .find((record) => record.type === "error");
      if (errorRecord?.type === "error") failure = errorRecord;
    } else {
      const payload = (await response.json()) as SearchApiFailure;
      failure = {
        ...payload,
        plan: isSearchPlan(payload.plan) ? payload.plan : undefined,
      };
    }
  } catch {
    // A provider error body is untrusted and optional. Use the controlled
    // status-based message below when it cannot be parsed.
  }

  const retryAfterValue = Number(response.headers.get("retry-after"));
  const retryAfterSeconds = Number.isFinite(retryAfterValue) && retryAfterValue > 0
    ? Math.ceil(retryAfterValue)
    : undefined;
  const message =
    failure?.details ||
    failure?.error ||
    (response.status === 429
      ? "Сервис занят и пока не может принять новый поиск."
      : `Ошибка поиска (HTTP ${response.status})`);

  return new SearchWorkflowError(
    message,
    response.status,
    failure?.code,
    isSearchPlan(failure?.plan) ? failure.plan : undefined,
    retryAfterSeconds,
  );
}

function providerMetadata(response: SearchResponse): ProviderMetadata {
  const metadata = (response as SearchResponseWithProvider).provider;
  if (metadata) return metadata;

  const mode = String(response.mode);
  if (mode === "yandex") {
    return {
      id: "yandex",
      label: "Яндекс Search API",
      queriedAt: response.generatedAt,
      policy: {
        persistence: "contract_required",
        attributionRequired: false,
        attribution: [],
        rawResponsesStored: false,
      },
    };
  }

  if (mode === "geoapify") {
    return {
      id: "geoapify",
      label: "Geoapify Places API",
      queriedAt: response.generatedAt,
      policy: {
        persistence: "allowed_with_attribution",
        attributionRequired: true,
        attribution: ["Geoapify", "OpenStreetMap contributors"],
        rawResponsesStored: false,
      },
    };
  }

  return {
    id: "demo",
    label: "Демонстрационная выборка",
    queriedAt: response.generatedAt,
    policy: {
      persistence: "synthetic",
      attributionRequired: false,
      attribution: [],
      rawResponsesStored: false,
    },
  };
}

function canPersist(response: SearchResponse) {
  return providerMetadata(response).policy.persistence !== "contract_required";
}

function hasProviderRestrictions(response: SearchResponse) {
  return providerMetadata(response).policy.persistence === "contract_required";
}

function discoverySourceLabel(lead: Lead, response: SearchResponse) {
  const source = String(lead.discovery.source);
  if (source === "geoapify") return "Geoapify Places API";
  if (source === "yandex") return "Яндекс Search API";
  if (source === "demo") return "Демонстрационная запись";
  return providerMetadata(response).label;
}

function attributionLink(attribution: string) {
  const normalized = attribution.toLocaleLowerCase("en");
  if (normalized.includes("geoapify")) {
    return { href: "https://www.geoapify.com/", label: "Powered by Geoapify" };
  }
  if (normalized.includes("openstreetmap")) {
    return {
      href: "https://www.openstreetmap.org/copyright",
      label: "© OpenStreetMap contributors",
    };
  }
  return null;
}

function ProviderAttribution({ response }: { response: SearchResponse }) {
  const provider = providerMetadata(response);
  if (!provider.policy.attributionRequired) return null;

  return (
    <div className="provider-attribution" aria-label="Атрибуция источника данных">
      <Database size={14} />
      <span>Источник: {provider.label}</span>
      {provider.policy.attribution.map((attribution) => {
        const link = attributionLink(attribution);
        return link ? (
          <a key={attribution} href={link.href} target="_blank" rel="noreferrer">
            {link.label}
          </a>
        ) : (
          <span key={attribution}>{attribution}</span>
        );
      })}
    </div>
  );
}

const DEFAULT_QUERY: SearchPayload = {
  description:
    "Компании, которые хранят, комплектуют и отправляют товары продавцов маркетплейсов",
  primaryQuery: "Фулфилмент",
  relatedQueries: [
    "Ответственное хранение",
    "Складские услуги",
    "Комплектация заказов",
    "Упаковка и маркировка",
    "Логистика для маркетплейсов",
  ],
  excludeQueries: ["Камеры хранения", "Склады индивидуального хранения", "Аренда гаражей"],
  location: "Москва, ул. Лесная, 7",
  locationMode: "radius",
  radiusKm: 15,
  services: ["Создание сайта", "Внедрение CRM", "Автоматизация заявок"],
};

const STATUSES: LeadStatus[] = [
  "Новый",
  "Проверить",
  "В работе",
  "Связались",
  "Не подходит",
];

function websiteLabel(lead: Lead) {
  if (lead.website.verifiedStatus === "found") {
    return lead.website.sourceStatus === "listed"
      ? "Указан источником"
      : "Найден дополнительно";
  }
  if (lead.website.verifiedStatus === "not_found_after_checks") {
    return "Не найден после проверки";
  }
  if (lead.website.verifiedStatus === "unavailable") return "Недоступен";
  if (lead.website.sourceStatus === "not_checked") {
    return "Данные не проверены";
  }
  return lead.website.sourceStatus === "not_listed"
    ? "Не указан источником"
    : "Указан, не проверен";
}

function websiteSourceLabel(lead: Lead) {
  if (lead.website.sourceStatus === "listed") return "Указан";
  if (lead.website.sourceStatus === "not_listed") {
    return "Не указан в полученных данных";
  }
  return "Расширенные данные не запрашивались";
}

function websiteDisplayName(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "Открыть сайт";
  }
}

function scoreTone(score: number) {
  if (score >= 80) return "score-high";
  if (score >= 60) return "score-mid";
  return "score-low";
}

function statusTone(status: LeadStatus) {
  if (status === "Новый") return "status-new";
  if (status === "Проверить") return "status-check";
  if (status === "Связались") return "status-contact";
  if (status === "Не подходит") return "status-muted";
  return "status-work";
}

function csvCell(value: string | number | null) {
  const normalized = value === null ? "" : String(value);
  // Provider data is untrusted. Neutralize spreadsheet formulas before the
  // CSV is opened in Excel or another desktop spreadsheet application.
  const safeValue = /^[=+\-@]/.test(normalized.trimStart())
    ? `'${normalized}`
    : normalized;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

function StatCard({
  label,
  value,
  delta,
}: {
  label: string;
  value: number;
  delta?: string;
}) {
  return (
    <article className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      {delta && <small>{delta}</small>}
    </article>
  );
}

function Score({ value, compact = false }: { value: number; compact?: boolean }) {
  return (
    <div className={`score ${scoreTone(value)} ${compact ? "score-compact" : ""}`}>
      {!compact && <span className="score-track"><i style={{ width: `${value}%` }} /></span>}
      <strong>{value}</strong>
      {!compact && <small>/ 100</small>}
    </div>
  );
}

function TagEditor({
  title,
  values,
  onChange,
}: {
  title: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim();
    if (!value || values.includes(value)) return;
    onChange([...values, value]);
    setDraft("");
  };

  return (
    <div className="field-group">
      <label>{title}</label>
      <div className="chip-list">
        {values.map((value) => (
          <span className="chip" key={value}>
            {value}
            <button
              type="button"
              aria-label={`Удалить ${value}`}
              onClick={() => onChange(values.filter((item) => item !== value))}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="tag-add-row">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
          placeholder="Добавить вариант"
          aria-label={`Новое значение: ${title}`}
        />
        <button type="button" className="button button-quiet button-small" onClick={add}>
          <Plus size={14} /> Добавить
        </button>
      </div>
    </div>
  );
}

function Sidebar({
  screen,
  hasResults,
  onNavigate,
  collapsed,
  onToggle,
}: {
  screen: Screen;
  hasResults: boolean;
  onNavigate: (screen: Screen) => void;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const items: Array<{ id: Screen; label: string; icon: typeof Search; disabled?: boolean }> = [
    { id: "search", label: "Поиск", icon: Search },
    { id: "results", label: "Лиды", icon: Users, disabled: !hasResults },
    { id: "map", label: "Карта", icon: MapIcon, disabled: !hasResults },
  ];

  return (
    <aside className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`}>
      <div className="brand">
        <span className="brand-mark"><BarChart3 size={15} /></span>
        <strong>LeadRadar</strong>
      </div>
      <button className="mobile-menu" onClick={onToggle} aria-label="Открыть меню">
        <Menu size={20} />
      </button>
      <nav aria-label="Главная навигация">
        {items.map((item) => {
          const Icon = item.icon;
          const active =
            screen === item.id || (screen === "detail" && item.id === "results");
          return (
            <button
              type="button"
              key={item.id}
              disabled={item.disabled}
              className={active ? "active" : ""}
              onClick={() => onNavigate(item.id)}
            >
              <Icon size={17} /> <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      <div className="sidebar-secondary">
        <span><Database size={16} /> <em>Источники</em></span>
        <span><Settings size={16} /> <em>Настройки</em></span>
        <span><CircleHelp size={16} /> <em>Справка</em></span>
      </div>
      <div className="profile">
        <span className="avatar">В</span>
        <span><strong>Владимир</strong><small>Локальный MVP</small></span>
      </div>
    </aside>
  );
}

export default function LeadRadarApp() {
  const [screen, setScreen] = useState<Screen>("search");
  const [query, setQuery] = useState<SearchPayload>(DEFAULT_QUERY);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchProgress, setSearchProgress] = useState<SearchProgressPanelEvent[]>([]);
  const [searchPlan, setSearchPlan] = useState<SearchPlan | null>(null);
  const [searchPhase, setSearchPhase] = useState<SearchPhase>("idle");
  const [searchStartedAt, setSearchStartedAt] = useState<number>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState("opportunity");
  const [page, setPage] = useState(1);
  const [minOpportunity, setMinOpportunity] = useState(0);
  const [minHiddenness, setMinHiddenness] = useState(0);
  const [minConfidence, setMinConfidence] = useState(0);
  const [websiteFilter, setWebsiteFilter] = useState("any");
  const [statusFilter, setStatusFilter] = useState("any");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState("");
  const activeSearchController = useRef<AbortController | null>(null);

  useEffect(() => {
    const restoreLocalState = () => {
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY);
        const savedTemplate = window.localStorage.getItem(TEMPLATE_KEY);
        if (saved) {
          const savedResponse = JSON.parse(saved) as SearchResponse;
          if (canPersist(savedResponse)) {
            setResponse(savedResponse);
          } else {
            window.localStorage.removeItem(STORAGE_KEY);
          }
        }
        if (savedTemplate) setQuery(JSON.parse(savedTemplate) as SearchPayload);
        const savedNotes = window.localStorage.getItem("leadradar:notes");
        if (savedNotes) setNotes(JSON.parse(savedNotes) as Record<string, string>);
      } catch {
        // Local storage is optional for the MVP.
      }
    };
    const frame = window.requestAnimationFrame(restoreLocalState);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!response) return;
    if (canPersist(response)) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(response));
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, [response]);

  useEffect(
    () => () => {
      activeSearchController.current?.abort();
    },
    [],
  );

  const selectedLead = useMemo(
    () => response?.leads.find((lead) => lead.id === selectedLeadId) ?? null,
    [response, selectedLeadId],
  );

  const filteredLeads = useMemo(() => {
    const leads = (response?.leads ?? []).filter((lead) => {
      if (lead.scores.opportunity < minOpportunity) return false;
      if (lead.scores.hiddenness < minHiddenness) return false;
      if (lead.scores.confidence < minConfidence) return false;
      if (statusFilter !== "any" && lead.status !== statusFilter) return false;
      if (websiteFilter === "missing" && lead.website.sourceStatus !== "not_listed") return false;
      if (websiteFilter === "listed" && lead.website.sourceStatus !== "listed") return false;
      if (websiteFilter === "unchecked" && lead.website.sourceStatus !== "not_checked") return false;
      return true;
    });
    return [...leads].sort((left, right) => {
      if (sort === "hiddenness") return right.scores.hiddenness - left.scores.hiddenness;
      if (sort === "confidence") return right.scores.confidence - left.scores.confidence;
      if (sort === "name") return left.name.localeCompare(right.name, "ru");
      return right.scores.opportunity - left.scores.opportunity;
    });
  }, [response, minOpportunity, minHiddenness, minConfidence, statusFilter, websiteFilter, sort]);

  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(filteredLeads.length / pageSize));
  const effectivePage = Math.min(page, pageCount);
  const visibleLeads = filteredLeads.slice(
    (effectivePage - 1) * pageSize,
    effectivePage * pageSize,
  );

  const presentSearchFailure = (failure: unknown) => {
    if (failure instanceof SearchWorkflowError) {
      if (failure.code === "SEARCH_PLANNER_UNAVAILABLE") {
        setSearchPlan(null);
        setError(
          "Сервис интерпретации запроса временно недоступен. Подождите немного и повторите поиск.",
        );
        return;
      }

      if (failure.plan) setSearchPlan(failure.plan);

      if (
        failure.code === "SEARCH_PLAN_CONFIRMATION_REQUIRED" ||
        failure.status === 409
      ) {
        setError(failure.plan ? "" : failure.message);
        return;
      }

      if (failure.code === "SEARCH_PLAN_UNSUPPORTED" || failure.status === 422) {
        setError(failure.plan ? "" : failure.message);
        return;
      }

      if (failure.code === "SEARCH_ADMISSION_LIMIT" || failure.status === 429) {
        setError(
          failure.retryAfterSeconds
            ? `Сервис занят. Повторите поиск примерно через ${failure.retryAfterSeconds} сек.`
            : "Сервис занят. Подождите немного и повторите поиск.",
        );
        return;
      }

      setError(failure.message);
      return;
    }

    if (failure instanceof DOMException && failure.name === "AbortError") {
      setError(
        "Поиск занял больше минуты и был аккуратно остановлен. Уменьшите радиус или повторите попытку.",
      );
      return;
    }

    setError(failure instanceof Error ? failure.message : "Не удалось выполнить поиск");
  };

  const readSearchResponse = async (result: Response): Promise<SearchResponse> => {
    if (!result.ok) throw await readSearchFailure(result);

    let data: SearchResponse | null = null;
    const contentType = result.headers.get("content-type") ?? "";
    if (contentType.includes("application/x-ndjson") && result.body) {
      const reader = result.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        const message = JSON.parse(line) as SearchStreamMessage;
        if (message.type === "progress") {
          setSearchProgress((current) => [...current, message].slice(-160));
          return;
        }
        if (message.type === "result") {
          data = message.data;
          return;
        }
        throw new SearchWorkflowError(
          message.details || message.error || "Ошибка поискового провайдера",
          result.status,
          message.code,
          isSearchPlan(message.plan) ? message.plan : undefined,
        );
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
        if (done) break;
      }
      if (buffer.trim()) consumeLine(buffer);
    } else {
      const payload = (await result.json()) as SearchResponse & SearchApiFailure & {
        plan?: SearchPlan;
      };
      if (payload.error) {
        throw new SearchWorkflowError(
          payload.details || payload.error,
          result.status,
          payload.code,
          isSearchPlan(payload.plan) ? payload.plan : undefined,
        );
      }
      data = payload;
      setSearchProgress((current) => [
        ...current,
        {
          type: "progress",
          stage: "complete",
          status: "completed",
          message: "Выборка готова",
          timestamp: new Date().toISOString(),
        },
      ]);
    }

    if (!data) throw new Error("Поиск завершился без результата");
    return data;
  };

  const acceptSearchResponse = (data: SearchResponse) => {
    const responsePlan = (data as SearchResponse & { plan?: unknown }).plan;
    if (isSearchPlan(responsePlan)) setSearchPlan(responsePlan);
    setResponse(data);
    setSelectedLeadId(data.leads[0]?.id ?? null);
    setScreen("results");
    const provider = providerMetadata(data);
    setNotice(
      String(data.mode) === "demo"
        ? "Демо-режим: интерфейс работает без ключа провайдера."
        : `Данные получены через ${provider.label}.`,
    );
  };

  const requestSearch = async (
    payload: SearchPayload,
    signal: AbortSignal,
  ) => {
    const result = await fetch("/api/search?stream=1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    acceptSearchResponse(await readSearchResponse(result));
  };

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault();
    if (
      query.locationMode === "metro" &&
      (!query.metro?.stationId || !query.metro.stationName || !query.center)
    ) {
      setError("Выберите конкретную станцию метро перед запуском поиска.");
      return;
    }
    if (!query.primaryQuery.trim() || (!query.location.trim() && !query.center)) {
      setError("Укажите основной запрос и географию поиска.");
      return;
    }

    activeSearchController.current?.abort();
    const controller = new AbortController();
    activeSearchController.current = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      SEARCH_CLIENT_TIMEOUT_MS,
    );

    setLoading(true);
    setSearchPhase("planning");
    setSearchStartedAt(Date.now());
    setSearchPlan(null);
    setError("");
    setNotice("");
    setSearchProgress([
      {
        type: "progress",
        stage: "intent_resolution",
        status: "started",
        message: "Систематизируем бизнес-намерение",
        timestamp: new Date().toISOString(),
      },
    ]);

    const queryWithLocale: SearchPayload = {
      ...query,
      locale: "ru-RU",
      countryCodes: ["RU"],
    };

    try {
      const planResult = await fetch("/api/search/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(queryWithLocale),
        signal: controller.signal,
      });

      // v0.3 compatibility: until the planner route is deployed, known/demo
      // searches keep using the existing endpoint without losing functionality.
      if (planResult.status === 404 || planResult.status === 405) {
        setSearchProgress((current) => [
          ...current,
          {
            type: "progress",
            stage: "intent_resolution",
            status: "completed",
            message: "Используем совместимый поиск по известному словарю",
            timestamp: new Date().toISOString(),
          },
        ]);
        setSearchPhase("searching");
        await requestSearch(query, controller.signal);
        return;
      }

      if (!planResult.ok) throw await readSearchFailure(planResult);
      const planPayload = (await planResult.json()) as unknown;
      if (!isSearchPlan(planPayload)) {
        throw new Error("Сервис трактовки вернул неподдерживаемый формат ответа");
      }

      setSearchPlan(planPayload);
      setSearchProgress((current) => [
        ...current,
        {
          type: "progress",
          stage: "intent_resolution",
          status: "completed",
          message:
            planPayload.status === "needs_confirmation"
              ? "Найдены несколько возможных трактовок"
              : planPayload.status === "unsupported"
                ? "Смысл понятен, но стратегия источника пока не готова"
                : "Трактовка запроса готова",
          timestamp: new Date().toISOString(),
        },
      ]);

      if (
        planPayload.status === "needs_confirmation" ||
        planPayload.status === "unsupported"
      ) {
        return;
      }

      setSearchPhase("searching");
      await requestSearch(queryWithLocale, controller.signal);
    } catch (searchError) {
      presentSearchFailure(searchError);
    } finally {
      window.clearTimeout(timeout);
      if (activeSearchController.current === controller) {
        activeSearchController.current = null;
      }
      setLoading(false);
      setSearchPhase("idle");
    }
  };

  const confirmSearchPlan = async (
    selectedAlternative: SearchPlanAlternative,
    confirmationToken: string,
  ) => {
    activeSearchController.current?.abort();
    const controller = new AbortController();
    activeSearchController.current = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      SEARCH_CLIENT_TIMEOUT_MS,
    );

    setLoading(true);
    setSearchPhase("searching");
    setSearchStartedAt(Date.now());
    setError("");
    setSearchProgress([
      {
        type: "progress",
        stage: "intent_resolution",
        status: "completed",
        message: "Трактовка подтверждена — запускаем поиск",
        timestamp: new Date().toISOString(),
      },
    ]);

    try {
      await requestSearch(
        {
          ...query,
          locale: "ru-RU",
          countryCodes: ["RU"],
          confirmationToken,
          confirmedAlternative: {
            alternativeId: selectedAlternative.alternativeId,
            alternativeHash: selectedAlternative.alternativeHash,
            semanticIntent: selectedAlternative.semanticIntent,
          },
        },
        controller.signal,
      );
    } catch (searchError) {
      presentSearchFailure(searchError);
    } finally {
      window.clearTimeout(timeout);
      if (activeSearchController.current === controller) {
        activeSearchController.current = null;
      }
      setLoading(false);
      setSearchPhase("idle");
    }
  };

  const updateQuery = (nextQuery: SetStateAction<SearchPayload>) => {
    setQuery(nextQuery);
    if (!loading) {
      setSearchPlan(null);
      setSearchProgress([]);
      setError("");
    }
  };

  const saveTemplate = () => {
    window.localStorage.setItem(TEMPLATE_KEY, JSON.stringify(query));
    setNotice("Шаблон поиска сохранён в этом браузере.");
    window.setTimeout(() => setNotice(""), 2600);
  };

  const updateStatus = (leadId: string, status: LeadStatus) => {
    setResponse((current) =>
      current
        ? { ...current, leads: current.leads.map((lead) => lead.id === leadId ? { ...lead, status } : lead) }
        : current,
    );
  };

  const openLead = (lead: Lead) => {
    setSelectedLeadId(lead.id);
    setScreen("detail");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const copyText = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(""), 1800);
  };

  const exportCsv = () => {
    if (!response || !canPersist(response)) {
      setNotice("Экспорт отключён: для этого источника сначала нужны договорные права на хранение данных.");
      return;
    }
    const provider = providerMetadata(response);
    const attribution = provider.policy.attribution
      .map((item) => {
        const link = attributionLink(item);
        return link ? `${link.label} — ${link.href}` : item;
      })
      .join("; ");
    const header = ["Компания", "Категория", "Адрес", "Телефон", "Email", "Сайт", "Статус сайта", "Проблемы", "Потенциал", "Скрытость", "Достоверность", "Статус", "Источник", "ID источника", "Атрибуция данных"];
    const rows = filteredLeads.map((lead) => {
      const source = (lead as LeadWithSources).sources?.[0];
      return [
        lead.name,
        lead.category,
        lead.location.address,
        lead.phone,
        lead.email ?? null,
        lead.website.url,
        websiteLabel(lead),
        lead.digitalProblems.join("; "),
        lead.scores.opportunity,
        lead.scores.hiddenness,
        lead.scores.confidence,
        lead.status,
        provider.label,
        source?.externalId ?? lead.id,
        attribution,
      ];
    });
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(";")).join("\n");
    const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `leadradar-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const navigate = (next: Screen) => {
    if ((next === "results" || next === "map") && !response) return;
    if (next === "map" && response && hasProviderRestrictions(response)) {
      setNotice("Сторонняя карта для live-данных отключена до подтверждения условий источника.");
      return;
    }
    setScreen(next);
    if (window.innerWidth < 760) setSidebarCollapsed(true);
  };

  return (
    <div className="app-shell">
      <Sidebar
        screen={screen}
        hasResults={Boolean(response)}
        onNavigate={navigate}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((current) => !current)}
      />
      <main className="workspace">
        {notice && <div className="toast" role="status"><Check size={16} /> {notice}</div>}
        {screen === "search" && (
          <SearchScreen
            query={query}
            setQuery={updateQuery}
            loading={loading}
            searchPhase={searchPhase}
            searchPlan={searchPlan}
            searchStartedAt={searchStartedAt}
            progress={searchProgress}
            error={error}
            onSubmit={runSearch}
            onConfirm={confirmSearchPlan}
            onSave={saveTemplate}
          />
        )}
        {screen === "results" && response && (
          <ResultsScreen
            response={response}
            filteredLeads={filteredLeads}
            visibleLeads={visibleLeads}
            page={effectivePage}
            pageCount={pageCount}
            sort={sort}
            showFilters={showFilters}
            minOpportunity={minOpportunity}
            websiteFilter={websiteFilter}
            statusFilter={statusFilter}
            onSort={(value) => { setSort(value); setPage(1); }}
            onToggleFilters={() => setShowFilters((current) => !current)}
            onOpportunity={(value) => { setMinOpportunity(value); setPage(1); }}
            onWebsite={(value) => { setWebsiteFilter(value); setPage(1); }}
            onStatusFilter={(value) => { setStatusFilter(value); setPage(1); }}
            onStatus={updateStatus}
            onPage={setPage}
            onOpenLead={openLead}
            onMap={() => {
              if (hasProviderRestrictions(response)) {
                setNotice("Сторонняя карта для live-данных отключена до подтверждения условий источника.");
                return;
              }
              setScreen("map");
            }}
            onExport={exportCsv}
          />
        )}
        {screen === "map" && response && (
          <MapScreen
            response={response}
            leads={filteredLeads}
            selectedLeadId={selectedLeadId}
            sort={sort}
            minOpportunity={minOpportunity}
            minHiddenness={minHiddenness}
            minConfidence={minConfidence}
            websiteFilter={websiteFilter}
            statusFilter={statusFilter}
            onSort={(value) => { setSort(value); setPage(1); }}
            onOpportunity={(value) => { setMinOpportunity(value); setPage(1); }}
            onHiddenness={(value) => { setMinHiddenness(value); setPage(1); }}
            onConfidence={(value) => { setMinConfidence(value); setPage(1); }}
            onWebsite={(value) => { setWebsiteFilter(value); setPage(1); }}
            onStatusFilter={(value) => { setStatusFilter(value); setPage(1); }}
            onSelect={setSelectedLeadId}
            onOpenLead={openLead}
            onResults={() => setScreen("results")}
          />
        )}
        {screen === "detail" && selectedLead && response && (
          <DetailScreen
            response={response}
            lead={selectedLead}
            note={notes[selectedLead.id] ?? ""}
            copied={copied}
            onBack={() => setScreen("results")}
            onStatus={(status) => updateStatus(selectedLead.id, status)}
            onNote={(value) => {
              const next = { ...notes, [selectedLead.id]: value };
              setNotes(next);
              if (response && canPersist(response)) {
                window.localStorage.setItem("leadradar:notes", JSON.stringify(next));
              }
            }}
            onCopy={copyText}
          />
        )}
      </main>
    </div>
  );
}

function SearchScreen({
  query,
  setQuery,
  loading,
  searchPhase,
  searchPlan,
  searchStartedAt,
  progress,
  error,
  onSubmit,
  onConfirm,
  onSave,
}: {
  query: SearchPayload;
  setQuery: (query: SetStateAction<SearchPayload>) => void;
  loading: boolean;
  searchPhase: SearchPhase;
  searchPlan: SearchPlan | null;
  searchStartedAt?: number;
  progress: SearchProgressPanelEvent[];
  error: string;
  onSubmit: (event: FormEvent) => void;
  onConfirm: (
    alternative: SearchPlanAlternative,
    confirmationToken: string,
  ) => void;
  onSave: () => void;
}) {
  const services = ["Создание сайта", "Внедрение CRM", "Автоматизация заявок", "Онлайн-калькулятор"];

  return (
    <section className="screen search-screen">
      <header className="screen-header">
        <div><p className="eyebrow">Поисковое задание</p><h1>Новый поиск компаний</h1><p>Заполните параметры — сервис объединит основной и смежные запросы.</p></div>
        <div className="header-actions">
          <button type="button" className="button" onClick={onSave}><Save size={16} /> Сохранить шаблон</button>
          <button type="submit" form="search-form" className="button button-primary" disabled={loading || (query.locationMode === "metro" && !query.metro?.stationId)}><Rocket size={16} /> {searchPhase === "planning" ? "Разбираем запрос…" : searchPhase === "searching" ? "Ищем компании…" : "Запустить поиск"}</button>
        </div>
      </header>
      <ol className="stepper" aria-label="Этапы настройки">
        {["Кого ищем", "Где ищем", "Что предлагаем", "Сигналы", "Формат результата"].map((step, index) => (
          <li className={index === 0 ? "active" : ""} key={step}><span>{index + 1}</span>{step}</li>
        ))}
      </ol>
      {error && <div className="error-banner" role="alert"><AlertTriangle size={18} /> {error}</div>}
      {searchPlan && (
        <SearchIntentPanel
          key={searchPlan.planHash}
          plan={searchPlan}
          busy={loading}
          onConfirm={onConfirm}
          onRevise={() => {
            document.getElementById("primary-query")?.focus();
            document.getElementById("primary-query")?.scrollIntoView({
              behavior: "smooth",
              block: "center",
            });
          }}
        />
      )}
      {loading && (
        <SearchProgressPanel
          events={progress}
          startedAt={searchStartedAt}
          deadlineSeconds={60}
        />
      )}
      <form id="search-form" className="search-grid" onSubmit={onSubmit}>
        <section className="panel form-panel">
          <div className="section-title"><span className="icon-box"><Building2 size={18} /></span><div><h2>Кого ищем</h2><p>Опишите бизнес и расширьте словарь поиска</p></div></div>
          <div className="field-group">
            <label htmlFor="description">Описание целевого бизнеса</label>
            <textarea id="description" rows={4} value={query.description} onChange={(event) => setQuery({ ...query, description: event.target.value })} />
          </div>
          <div className="field-group">
            <label htmlFor="primary-query">Основной запрос</label>
            <input id="primary-query" value={query.primaryQuery} onChange={(event) => setQuery({ ...query, primaryQuery: event.target.value })} required />
          </div>
          <TagEditor title="Смежные запросы" values={query.relatedQueries} onChange={(relatedQueries) => setQuery({ ...query, relatedQueries })} />
          <TagEditor title="Исключить" values={query.excludeQueries} onChange={(excludeQueries) => setQuery({ ...query, excludeQueries })} />
        </section>
        <section className="panel location-panel">
          <LocationSelector
            key={`${query.locationMode ?? "radius"}:${query.metro?.systemId ?? "none"}`}
            query={query}
            setQuery={setQuery}
            loading={loading}
          />
          <div className="service-section">
            <h3>Что предлагаем</h3><p>Это влияет на рекомендуемый заход, но не на поиск и скоринг лидов.</p>
            <div className="service-grid">{services.map((service) => <label className="check-card" key={service}><input type="checkbox" checked={query.services.includes(service)} onChange={() => setQuery({ ...query, services: query.services.includes(service) ? query.services.filter((item) => item !== service) : [...query.services, service] })} /><span><Check size={13} /></span>{service}</label>)}</div>
          </div>
          <div className="source-note"><ShieldCheck size={18} /><span><strong>Источник организаций</strong>Geoapify Places API при наличии серверного ключа; иначе детерминированная демо-выборка.</span></div>
        </section>
      </form>
    </section>
  );
}

function ResultsScreen({
  response,
  filteredLeads,
  visibleLeads,
  page,
  pageCount,
  sort,
  showFilters,
  minOpportunity,
  websiteFilter,
  statusFilter,
  onSort,
  onToggleFilters,
  onOpportunity,
  onWebsite,
  onStatusFilter,
  onStatus,
  onPage,
  onOpenLead,
  onMap,
  onExport,
}: {
  response: SearchResponse;
  filteredLeads: Lead[];
  visibleLeads: Lead[];
  page: number;
  pageCount: number;
  sort: string;
  showFilters: boolean;
  minOpportunity: number;
  websiteFilter: string;
  statusFilter: string;
  onSort: (sort: string) => void;
  onToggleFilters: () => void;
  onOpportunity: (value: number) => void;
  onWebsite: (value: string) => void;
  onStatusFilter: (value: string) => void;
  onStatus: (id: string, status: LeadStatus) => void;
  onPage: (page: number) => void;
  onOpenLead: (lead: Lead) => void;
  onMap: () => void;
  onExport: () => void;
}) {
  const s = response.summary;
  const persistenceAllowed = canPersist(response);
  const sampleSize = Math.max(1, s.assumedBusinesses);
  const share = (value: number) =>
    `${((value / sampleSize) * 100).toLocaleString("ru-RU", {
      maximumFractionDigits: 1,
    })}% выборки`;
  return (
    <section className="screen results-screen">
      <header className="screen-header">
        <div><p className="eyebrow">Готовая выборка</p><h1>Результаты поиска</h1><p>«{response.query.primaryQuery}» · {response.query.radiusKm} км от {response.query.location} · {new Date(response.generatedAt).toLocaleString("ru-RU")}</p></div>
        <div className="header-actions"><button className="button" onClick={onExport} disabled={!persistenceAllowed}><Download size={16} /> Экспорт CSV</button><button className="button" disabled={!persistenceAllowed} title={persistenceAllowed ? "Выборка сохранена в этом браузере" : "Хранение отключено условиями источника"}><Save size={16} /> {persistenceAllowed ? "Сохранено локально" : "Хранение отключено"}</button></div>
      </header>
      <ProviderAttribution response={response} />
      <div className="stats-grid">
        <StatCard label="Получено карточек" value={s.cardsFound} />
        <StatCard label="Уникальных локаций" value={s.uniqueLocations} />
        <StatCard label="Предполагаемых бизнесов" value={s.assumedBusinesses} />
        <StatCard label="Соответствует основному запросу" value={s.foundByPrimary} delta={share(s.foundByPrimary)} />
        <StatCard label="Только расширенным поиском" value={s.foundOnlyExpanded} delta={share(s.foundOnlyExpanded)} />
        <StatCard label="Кандидатов с цифровыми разрывами" value={s.digitalGapCandidates} delta="для приоритизации" />
        <StatCard label="Нужна ручная проверка" value={s.manualReviewCandidates} delta="низкая достоверность" />
        <div className="sample-warning"><AlertTriangle size={20} /><span><strong>Discovery, а не реестр</strong>{response.notice}</span></div>
      </div>
      <div className="toolbar">
        <button className={`button ${showFilters ? "button-primary" : ""}`} onClick={onToggleFilters}><SlidersHorizontal size={16} /> Фильтры <span className="count-badge">{filteredLeads.length}</span></button>
        <label className="select-label">Сортировка:<select value={sort} onChange={(event) => onSort(event.target.value)}><option value="opportunity">по потенциалу</option><option value="hiddenness">по скрытости</option><option value="confidence">по достоверности</option><option value="name">по названию</option></select></label>
        <div className="view-switch"><button className="active"><Table2 size={15} /> Таблица</button><button onClick={onMap}><MapIcon size={15} /> Карта</button></div>
        <span className="result-count">Показано {visibleLeads.length} из {filteredLeads.length}</span>
      </div>
      {showFilters && <div className="inline-filters"><label>Потенциал от <input type="number" min={0} max={100} value={minOpportunity} onChange={(event) => onOpportunity(Number(event.target.value))} /></label><label>URL сайта <select value={websiteFilter} onChange={(event) => onWebsite(event.target.value)}><option value="any">любой</option><option value="missing">не указан в полученных данных</option><option value="listed">указан источником</option><option value="unchecked">расширенные данные не запрашивались</option></select></label><label>Статус <select value={statusFilter} onChange={(event) => onStatusFilter(event.target.value)}><option value="any">любой</option>{STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label></div>}
      <div className="table-wrap panel">
        <table>
          <thead><tr><th>№</th><th>Компания</th><th>Категория</th><th>Адрес</th><th>Телефон</th><th>Сайт</th><th>Цифровая проблема</th><th>Потенциал</th><th>Скрытость</th><th>Достоверность</th><th>Статус</th></tr></thead>
          <tbody>{visibleLeads.map((lead, index) => <tr key={lead.id} onDoubleClick={() => onOpenLead(lead)}><td className="priority-cell">{(page - 1) * 5 + index + 1}</td><td className="company-cell"><button onClick={() => onOpenLead(lead)}>{lead.name}</button><small>{lead.tags[0]}</small></td><td>{lead.category}</td><td>{lead.location.address}</td><td>{lead.phone ?? "—"}</td><td><div className="website-cell">{lead.website.url && <a className="website-link" href={lead.website.url} target="_blank" rel="noreferrer" title={lead.website.url}>{websiteDisplayName(lead.website.url)} <ExternalLink size={11} /></a>}<span className={`site-state ${lead.website.url ? "positive" : ""}`}>{websiteLabel(lead)}</span></div></td><td>{lead.digitalProblems[0] ?? "Не выявлено"}</td><td><Score value={lead.scores.opportunity} compact /></td><td><Score value={lead.scores.hiddenness} compact /></td><td><Score value={lead.scores.confidence} compact /></td><td><select className={`status-select ${statusTone(lead.status)}`} value={lead.status} onChange={(event) => onStatus(lead.id, event.target.value as LeadStatus)}>{STATUSES.map((status) => <option key={status}>{status}</option>)}</select></td></tr>)}</tbody>
        </table>
        {!visibleLeads.length && <div className="empty-state"><Search size={24} />Нет лидов с такими фильтрами</div>}
      </div>
      <div className="pagination"><button className="button button-icon" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Предыдущая страница"><ChevronLeft size={17} /></button><span>Страница {page} из {pageCount}</span><button className="button button-icon" disabled={page >= pageCount} onClick={() => onPage(page + 1)} aria-label="Следующая страница"><ChevronRight size={17} /></button></div>
    </section>
  );
}

function RangeFilter({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return <label className="range-filter"><span>{label}<strong>{value}</strong></span><input type="range" min={0} max={100} value={value} onChange={(event) => onChange(Number(event.target.value))} /><small>0 <i /> 100</small></label>;
}

function MapScreen({
  response,
  leads,
  selectedLeadId,
  sort,
  minOpportunity,
  minHiddenness,
  minConfidence,
  websiteFilter,
  statusFilter,
  onSort,
  onOpportunity,
  onHiddenness,
  onConfidence,
  onWebsite,
  onStatusFilter,
  onSelect,
  onOpenLead,
  onResults,
}: {
  response: SearchResponse;
  leads: Lead[];
  selectedLeadId: string | null;
  sort: string;
  minOpportunity: number;
  minHiddenness: number;
  minConfidence: number;
  websiteFilter: string;
  statusFilter: string;
  onSort: (value: string) => void;
  onOpportunity: (value: number) => void;
  onHiddenness: (value: number) => void;
  onConfidence: (value: number) => void;
  onWebsite: (value: string) => void;
  onStatusFilter: (value: string) => void;
  onSelect: (id: string) => void;
  onOpenLead: (lead: Lead) => void;
  onResults: () => void;
}) {
  return (
    <section className="screen map-screen">
      <header className="screen-header compact-header"><div><p className="eyebrow">География лидов</p><h1>Результаты на карте</h1><p>«{response.query.primaryQuery}» · радиус {response.query.radiusKm} км · найдено {leads.length} компаний</p></div><button className="button" onClick={onResults}><Table2 size={16} /> К таблице</button></header>
      <ProviderAttribution response={response} />
      <div className="map-layout panel">
        <aside className="map-filters"><div className="filter-heading"><SlidersHorizontal size={17} /><strong>Фильтры</strong><button onClick={() => { onOpportunity(0); onHiddenness(0); onConfidence(0); onWebsite("any"); onStatusFilter("any"); }}>Сбросить</button></div><label>URL сайта<select value={websiteFilter} onChange={(event) => onWebsite(event.target.value)}><option value="any">Любой</option><option value="missing">Не указан в полученных данных</option><option value="listed">Указан источником</option><option value="unchecked">Расширенные данные не запрашивались</option></select></label><label>Статус<select value={statusFilter} onChange={(event) => onStatusFilter(event.target.value)}><option value="any">Любой</option>{STATUSES.map((status) => <option key={status}>{status}</option>)}</select></label><RangeFilter label="Потенциал от" value={minOpportunity} onChange={onOpportunity} /><RangeFilter label="Скрытость от" value={minHiddenness} onChange={onHiddenness} /><RangeFilter label="Достоверность от" value={minConfidence} onChange={onConfidence} /><div className="map-key"><span><i className="key-green" />80–100</span><span><i className="key-orange" />60–79</span><span><i className="key-red" />до 59</span></div></aside>
        <div className="map-canvas"><LeadMap leads={leads} selectedLeadId={selectedLeadId} onSelect={(lead) => onSelect(lead.id)} focusCenter={response.query.center ?? DEFAULT_SEARCH_CENTER} focusRadiusKm={response.query.radiusKm} /></div>
        <aside className="map-list"><div className="map-list-head"><div><strong>Компании в области</strong><span>{leads.length} результатов</span></div><select value={sort} onChange={(event) => onSort(event.target.value)}><option value="opportunity">По потенциалу</option><option value="hiddenness">По скрытости</option><option value="confidence">По достоверности</option></select></div><div className="lead-stack">{leads.map((lead, index) => <button key={lead.id} className={lead.id === selectedLeadId ? "selected" : ""} onClick={() => onSelect(lead.id)} onDoubleClick={() => onOpenLead(lead)}><span className="list-index">{index + 1}</span><span className="list-copy"><strong>{lead.name}</strong><small>{lead.location.address}</small><em>{lead.digitalProblems[0]}</em></span><Score value={lead.scores.opportunity} compact /></button>)}</div>{selectedLeadId && <button className="button button-primary map-open" onClick={() => { const lead = leads.find((item) => item.id === selectedLeadId); if (lead) onOpenLead(lead); }}>Открыть карточку <ChevronRight size={16} /></button>}</aside>
      </div>
    </section>
  );
}

function DetailScreen({
  response,
  lead,
  note,
  copied,
  onBack,
  onStatus,
  onNote,
  onCopy,
}: {
  response: SearchResponse;
  lead: Lead;
  note: string;
  copied: string;
  onBack: () => void;
  onStatus: (status: LeadStatus) => void;
  onNote: (value: string) => void;
  onCopy: (value: string, label: string) => void;
}) {
  const provider = providerMetadata(response);
  const [longitude, latitude] = lead.location.coordinates;
  const isYandex = String(lead.discovery.source) === "yandex" || provider.id === "yandex";
  const externalMapUrl = isYandex
    ? `https://yandex.ru/maps/?pt=${longitude},${latitude}&z=16&l=map`
    : `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
  const externalMapLabel = isYandex ? "Открыть в Яндекс Картах" : "Открыть в OpenStreetMap";
  return (
    <section className="screen detail-screen">
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Назад к результатам</button>
      <header className="detail-header"><div><div className="title-row"><h1>{lead.name}</h1><span className={`status-pill ${statusTone(lead.status)}`}>{lead.status}</span></div><div className="tag-row"><span>{lead.category}</span>{lead.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><p><MapPin size={15} /> {lead.location.address}{lead.possibleBranches.length > 0 && <button>{lead.possibleBranches.length} возможных филиала</button>}</p></div><div className="header-actions"><select className={`status-select detail-status ${statusTone(lead.status)}`} value={lead.status} onChange={(event) => onStatus(event.target.value as LeadStatus)}>{STATUSES.map((status) => <option key={status}>{status}</option>)}</select>{lead.phone && <a className="button button-primary" href={`tel:${lead.phone.replace(/[^+\d]/g, "")}`}><Phone size={16} /> Связаться</a>}<a className="button" href={externalMapUrl} target="_blank" rel="noreferrer"><MapPin size={16} /> {externalMapLabel}</a></div></header>
      <ProviderAttribution response={response} />
      <div className="detail-tabs"><button className="active">Обзор</button><button>Источники</button><button>Проблемы</button><button>Оценки</button><button>История</button></div>
      <div className="detail-grid">
        <section className="panel detail-card contacts-card"><div className="card-title"><Phone size={17} /><h2>Контакты и ресурсы</h2></div><dl>{lead.phone && <><dt><Phone size={15} />Телефон</dt><dd>{lead.phone}<button onClick={() => onCopy(lead.phone!, "phone")} aria-label="Копировать телефон">{copied === "phone" ? <Check size={14} /> : <Copy size={14} />}</button></dd></>}{lead.email && <><dt><Mail size={15} />Email</dt><dd><a href={`mailto:${lead.email}`}>{lead.email}</a><button onClick={() => onCopy(lead.email!, "email")} aria-label="Копировать email">{copied === "email" ? <Check size={14} /> : <Copy size={14} />}</button></dd></>}<dt><Globe2 size={15} />Сайт в {provider.label}</dt><dd>{websiteSourceLabel(lead)}</dd><dt><ShieldCheck size={15} />Сайт после проверки</dt><dd className={lead.website.verifiedStatus === "found" ? "positive-text" : "warning-text"}>{websiteLabel(lead)}{lead.website.url && <a href={lead.website.url} target="_blank" rel="noreferrer">{lead.website.url.replace(/^https?:\/\//, "")} <ExternalLink size={12} /></a>}</dd><dt><Send size={15} />Telegram</dt><dd>{lead.socials.telegram ? <a href={lead.socials.telegram} target="_blank" rel="noreferrer">Открыть канал <ExternalLink size={12} /></a> : "Не найден"}</dd><dt><Users size={15} />VK</dt><dd>{lead.socials.vk ? <a href={lead.socials.vk} target="_blank" rel="noreferrer">Открыть страницу <ExternalLink size={12} /></a> : "Не найден"}</dd></dl></section>
        <section className="panel detail-card problems-card"><div className="card-title"><AlertTriangle size={17} /><h2>Цифровые разрывы</h2></div><div className="problem-list">{lead.digitalProblems.map((problem) => <div key={problem}><AlertTriangle size={15} />{problem}</div>)}</div><p className="fact-note"><ShieldCheck size={14} />Факты основаны на карточке и указанном уровне проверки.</p></section>
        <section className="panel detail-card summary-card"><div className="card-title"><FileText size={17} /><h2>Краткая сводка</h2></div><p>{lead.summary}</p><div className="hypothesis"><Sparkles size={15} /><span><strong>Рабочая гипотеза</strong>{lead.recommendedOffer}</span></div></section>
        <section className="panel detail-card mini-map-card"><div className="card-title"><MapIcon size={17} /><h2>Карта и филиалы</h2></div><div className="detail-map"><LeadMap leads={[lead]} selectedLeadId={lead.id} onSelect={() => undefined} /></div>{lead.possibleBranches.length > 0 ? <ul>{lead.possibleBranches.map((branch) => <li key={branch}><MapPin size={13} />{branch}</li>)}</ul> : <p className="muted-copy">Другие филиалы не обнаружены</p>}</section>
        <section className="panel detail-card discovery-card"><div className="card-title"><Layers3 size={17} /><h2>Как обнаружен</h2></div><p className="source-stamp"><Database size={14} />{discoverySourceLabel(lead, response)} · {lead.discovery.observedAt}</p><dl><dt>Основной запрос</dt><dd>{lead.discovery.primaryFound ? "Найден" : "Не найден"}</dd><dt>Смежные запросы</dt><dd>{lead.discovery.matchedQueries.join(", ")}</dd><dt>Причина скрытости</dt><dd>{lead.discovery.hiddenReason}</dd></dl></section>
        <section className="panel detail-card offer-card"><div className="card-title"><Sparkles size={17} /><h2>Рекомендуемый заход</h2></div><p>{lead.recommendedOffer}</p><button className="button" onClick={() => onCopy(`Здравствуйте! Изучили цифровое присутствие компании «${lead.name}». ${lead.recommendedOffer}`, "offer")}>{copied === "offer" ? <Check size={15} /> : <Copy size={15} />}{copied === "offer" ? "Скопировано" : "Скопировать черновик"}</button></section>
        <section className="panel detail-card scores-card"><div className="card-title"><BarChart3 size={17} /><h2>Оценки</h2></div><div className="score-block"><span>Коммерческий потенциал</span><Score value={lead.scores.opportunity} /></div><div className="score-block"><span>Скрытость</span><Score value={lead.scores.hiddenness} /></div><div className="score-block"><span>Достоверность данных</span><Score value={lead.scores.confidence} /></div></section>
        <section className="panel detail-card note-card"><div className="card-title"><Clock3 size={17} /><h2>Рабочая заметка</h2></div><textarea rows={4} value={note} onChange={(event) => onNote(event.target.value)} placeholder="Результат звонка, контекст, следующий шаг…" /><small>Сохраняется локально в браузере</small></section>
      </div>
    </section>
  );
}
