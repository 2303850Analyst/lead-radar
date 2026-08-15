"use client";

import { Check, Circle, LoaderCircle, Radar } from "lucide-react";

import type {
  SearchProgressEvent,
  SearchProgressStage,
} from "@/lib/types";

import styles from "./SearchProgressPanel.module.css";

const STAGES: Array<{
  id: SearchProgressStage;
  label: string;
  hint: string;
}> = [
  { id: "validation", label: "Проверяем задачу", hint: "Запрос и ограничения" },
  { id: "geocoding", label: "Определяем центр", hint: "Адрес или точка на карте" },
  { id: "places", label: "Ищем компании", hint: "Категории и радиус" },
  { id: "details", label: "Получаем контакты", hint: "Телефоны, email и сайты" },
  { id: "normalizing", label: "Готовим выборку", hint: "Дубли и приоритеты" },
  { id: "complete", label: "Готово", hint: "Результат сформирован" },
];

function latestByStage(events: SearchProgressEvent[]) {
  const result = new Map<SearchProgressStage, SearchProgressEvent>();
  for (const event of events) result.set(event.stage, event);
  return result;
}

function percentFor(events: SearchProgressEvent[]) {
  const latest = events.at(-1);
  if (!latest) return 2;
  const stageIndex = Math.max(
    0,
    STAGES.findIndex((stage) => stage.id === latest.stage),
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
}: {
  events: SearchProgressEvent[];
}) {
  const latest = events.at(-1);
  const byStage = latestByStage(events);
  const activeIndex = latest
    ? STAGES.findIndex((stage) => stage.id === latest.stage)
    : 0;
  const percent = percentFor(events);

  return (
    <section className={styles.panel} aria-labelledby="search-progress-title">
      <div className={styles.header}>
        <span className={styles.radar} aria-hidden="true"><Radar size={19} /></span>
        <div>
          <p>Живой прогресс</p>
          <h2 id="search-progress-title">Формируем базу лидов</h2>
        </div>
        <strong>{Math.round(percent)}%</strong>
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
        {latest?.message ?? "Запускаем поисковый конвейер…"}
      </p>
    </section>
  );
}
