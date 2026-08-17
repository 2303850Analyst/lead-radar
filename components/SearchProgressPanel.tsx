"use client";

import { Check, Circle, Clock3, LoaderCircle, Radar } from "lucide-react";
import { useEffect, useState } from "react";

import type { SearchProgressEvent } from "@/lib/types";

import styles from "./SearchProgressPanel.module.css";

type QueryIntelligenceStage =
  | SearchProgressEvent["stage"]
  | "intent_resolution"
  | "provider_compilation"
  | "relevance_classification";

type DisplayStage =
  | "intent_resolution"
  | "geocoding"
  | "provider_compilation"
  | "places"
  | "details"
  | "normalizing"
  | "relevance_classification"
  | "complete";

export type SearchProgressPanelEvent = Omit<SearchProgressEvent, "stage"> & {
  stage: QueryIntelligenceStage;
};

const STAGES: Array<{
  id: DisplayStage;
  label: string;
  hint: string;
}> = [
  { id: "intent_resolution", label: "Понимаем запрос", hint: "Категория и ограничения" },
  { id: "geocoding", label: "Определяем центр", hint: "Адрес или точка на карте" },
  { id: "provider_compilation", label: "Готовим поиск", hint: "Безопасные категории карты" },
  { id: "places", label: "Ищем компании", hint: "Категории и радиус" },
  { id: "relevance_classification", label: "Проверяем релевантность", hint: "Факты карточки и задача" },
  { id: "details", label: "Получаем контакты", hint: "Телефоны, email и сайты" },
  { id: "normalizing", label: "Готовим выборку", hint: "Дубли и приоритеты" },
  { id: "complete", label: "Готово", hint: "Результат сформирован" },
];

function displayStage(stage: QueryIntelligenceStage): DisplayStage {
  // The v0.3 API called the first stage `validation`. Treat it as intent
  // resolution so the legacy/demo path remains visually compatible.
  if (stage === "validation") return "intent_resolution";
  return stage as DisplayStage;
}

function latestByStage(events: SearchProgressPanelEvent[]) {
  const result = new Map<DisplayStage, SearchProgressPanelEvent>();
  for (const event of events) result.set(displayStage(event.stage), event);
  return result;
}

function percentFor(events: SearchProgressPanelEvent[]) {
  const latest = events.at(-1);
  if (!latest) return 2;
  const stageIndex = Math.max(
    0,
    STAGES.findIndex((stage) => stage.id === displayStage(latest.stage)),
  );
  let stageShare = latest.status === "completed" ? 1 : 0.2;
  if (
    latest.total &&
    latest.total > 0 &&
    typeof latest.completed === "number"
  ) {
    stageShare = Math.min(1, Math.max(0.08, latest.completed / latest.total));
  }
  return Math.min(100, Math.max(2, ((stageIndex + stageShare) / STAGES.length) * 100));
}

export default function SearchProgressPanel({
  events,
  startedAt,
  deadlineSeconds = 60,
}: {
  events: SearchProgressPanelEvent[];
  startedAt?: number;
  deadlineSeconds?: number;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const latest = events.at(-1);
  const byStage = latestByStage(events);
  const activeIndex = latest
    ? STAGES.findIndex((stage) => stage.id === displayStage(latest.stage))
    : 0;
  const percent = percentFor(events);
  const elapsedSeconds = startedAt
    ? Math.max(0, Math.floor((now - startedAt) / 1_000))
    : 0;
  const elapsedLabel = `${Math.floor(elapsedSeconds / 60)}:${String(
    elapsedSeconds % 60,
  ).padStart(2, "0")}`;
  const deadlineLabel = `${Math.floor(deadlineSeconds / 60)}:${String(
    deadlineSeconds % 60,
  ).padStart(2, "0")}`;

  return (
    <section className={styles.panel} aria-labelledby="search-progress-title">
      <div className={styles.header}>
        <span className={styles.radar} aria-hidden="true"><Radar size={19} /></span>
        <div>
          <p>Живой прогресс</p>
          <h2 id="search-progress-title">Формируем базу лидов</h2>
        </div>
        <span className={styles.metrics}>
          <strong>{Math.round(percent)}%</strong>
          <small className={elapsedSeconds >= deadlineSeconds - 10 ? styles.ending : ""}>
            <Clock3 size={12} aria-hidden="true" />
            {elapsedLabel} / до {deadlineLabel}
          </small>
        </span>
      </div>

      <div
        className={styles.track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-label="Прогресс поиска"
      >
        <span style={{ width: `${percent}%` }} />
      </div>

      <ol className={styles.steps}>
        {STAGES.map((stage, index) => {
          const event = byStage.get(stage.id);
          const completed =
            index < activeIndex ||
            event?.status === "completed" ||
            (stage.id === "complete" && Boolean(event));
          const active = index === activeIndex && !completed;
          return (
            <li
              key={stage.id}
              className={completed ? styles.completed : active ? styles.active : ""}
            >
              <span className={styles.stepIcon} aria-hidden="true">
                {completed ? (
                  <Check size={14} />
                ) : active ? (
                  <LoaderCircle size={15} />
                ) : (
                  <Circle size={12} />
                )}
              </span>
              <span className={styles.stepCopy}>
                <strong>{stage.label}</strong>
                <small>
                  {event?.total && typeof event.completed === "number"
                    ? `${event.completed} из ${event.total}`
                    : stage.hint}
                </small>
              </span>
            </li>
          );
        })}
      </ol>

      <p className={styles.liveMessage} aria-live="polite">
        <span aria-hidden="true" />
        {elapsedSeconds >= deadlineSeconds
          ? "Завершаем запрос контролируемым результатом — бесконечного ожидания не будет."
          : latest?.message ?? "Запускаем поисковый конвейер…"}
      </p>
    </section>
  );
}
