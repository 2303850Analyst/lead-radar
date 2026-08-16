"use client";

import {
  AlertTriangle,
  BrainCircuit,
  Check,
  ChevronRight,
  Info,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { PlanStatus, SearchPlan } from "@/lib/search-planner/types";

import styles from "./SearchIntentPanel.module.css";

const STATUS_COPY: Record<
  PlanStatus,
  { label: string; title: string; description: string }
> = {
  ready: {
    label: "Трактовка готова",
    title: "Запрос понятен",
    description: "Категория проверена — можно переходить к поиску на карте.",
  },
  needs_confirmation: {
    label: "Нужно уточнение",
    title: "Какой бизнес вы имеете в виду?",
    description: "Выберите трактовку. До подтверждения запрос к карте не отправляется.",
  },
  unsupported: {
    label: "Нужно переформулировать",
    title: "Для этой ниши пока нет безопасной категории",
    description:
      "Уточните вид бизнеса или добавьте более конкретное название услуги — поиск наугад не запускается.",
  },
  degraded: {
    label: "Без AI-проверки",
    title: "Используем известную категорию",
    description:
      "Интеллектуальная проверка временно недоступна, но категория однозначно найдена локальными правилами.",
  },
};

function confidenceLabel(confidence: SearchPlan["resolution"]["confidenceBand"]) {
  if (confidence === "high") return "Высокая уверенность";
  if (confidence === "medium") return "Средняя уверенность";
  if (confidence === "low") return "Низкая уверенность";
  return "Уверенность ещё не определена";
}

function methodLabel(method: SearchPlan["resolution"]["method"]) {
  if (method === "exact") return "Точное совпадение со словарём";
  if (method === "semantic") return "Семантическое сопоставление";
  if (method === "kimi") return "Проверено Kimi";
  if (method === "user_confirmed") return "Подтверждено вами";
  return "Безопасный локальный fallback";
}

function readableConceptId(conceptId: string) {
  return conceptId
    .split(".")
    .at(-1)
    ?.replaceAll("_", " ")
    .replace(/(^|\s)\S/g, (letter) => letter.toLocaleUpperCase("ru-RU")) ?? conceptId;
}

function selectedLabels(plan: SearchPlan) {
  const alternativeLabels = new Map(
    plan.resolution.alternatives.map((item) => [item.conceptId, item.label]),
  );

  return plan.resolution.selectedConceptIds.map(
    (conceptId, index) =>
      alternativeLabels.get(conceptId) ??
      plan.executionPreview?.categoryLabels[index] ??
      readableConceptId(conceptId),
  );
}

export function isSearchPlan(value: unknown): value is SearchPlan {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SearchPlan>;
  return (
    typeof candidate.status === "string" &&
    ["ready", "needs_confirmation", "unsupported", "degraded"].includes(
      candidate.status,
    ) &&
    Boolean(candidate.resolution) &&
    Array.isArray(candidate.resolution?.selectedConceptIds) &&
    Array.isArray(candidate.resolution?.alternatives)
  );
}

export default function SearchIntentPanel({
  plan,
  busy,
  onConfirm,
  onRevise,
}: {
  plan: SearchPlan;
  busy: boolean;
  onConfirm: (conceptIds: string[], confirmationToken: string) => void;
  onRevise: () => void;
}) {
  const [selectedConceptId, setSelectedConceptId] = useState("");
  const statusCopy = STATUS_COPY[plan.status];
  const canonicalLabels = useMemo(() => selectedLabels(plan), [plan]);

  const alternatives = plan.resolution.alternatives.slice(0, 3);
  const confirmationToken = plan.confirmation?.token ?? null;
  const canConfirm = Boolean(selectedConceptId && confirmationToken && !busy);

  return (
    <section
      className={`${styles.panel} ${styles[plan.status]}`}
      aria-labelledby="intent-panel-title"
    >
      <div className={styles.heading}>
        <span className={styles.icon} aria-hidden="true">
          {plan.status === "unsupported" ? (
            <AlertTriangle size={19} />
          ) : plan.status === "ready" ? (
            <Check size={19} />
          ) : (
            <BrainCircuit size={19} />
          )}
        </span>
        <div>
          <p>{statusCopy.label}</p>
          <h2 id="intent-panel-title">{statusCopy.title}</h2>
        </div>
        <span className={styles.confidence}>
          {confidenceLabel(plan.resolution.confidenceBand)}
        </span>
      </div>

      <p className={styles.description}>{statusCopy.description}</p>

      {canonicalLabels.length > 0 && (
        <div className={styles.interpretation}>
          <span>Каноническая категория</span>
          <strong>{canonicalLabels.join(", ")}</strong>
          <small>{plan.resolution.selectedConceptIds.join(" · ")}</small>
        </div>
      )}

      {plan.status === "needs_confirmation" && alternatives.length > 0 && (
        <fieldset className={styles.alternatives}>
          <legend>
            {plan.resolution.clarificationQuestion ?? "Выберите наиболее точный вариант"}
          </legend>
          {alternatives.map((alternative) => (
            <label
              key={alternative.conceptId}
              className={
                selectedConceptId === alternative.conceptId ? styles.selected : ""
              }
            >
              <input
                type="radio"
                name="canonical-concept"
                value={alternative.conceptId}
                checked={selectedConceptId === alternative.conceptId}
                onChange={() => setSelectedConceptId(alternative.conceptId)}
              />
              <span className={styles.radio} aria-hidden="true" />
              <span className={styles.alternativeCopy}>
                <strong>{alternative.label}</strong>
                <small>{readableConceptId(alternative.conceptId)}</small>
              </span>
              <ChevronRight size={17} aria-hidden="true" />
            </label>
          ))}
        </fieldset>
      )}

      {plan.executionPreview && (
        <div className={styles.preview}>
          <Sparkles size={15} aria-hidden="true" />
          <span>
            <strong>Что будет искать карта</strong>
            {plan.executionPreview.categoryLabels.length > 0
              ? plan.executionPreview.categoryLabels.join(", ")
              : `${plan.executionPreview.batches} поисковых пакетов`}
          </span>
        </div>
      )}

      <div className={styles.footer}>
        <span className={styles.method}>
          <ShieldCheck size={14} aria-hidden="true" />
          {methodLabel(plan.resolution.method)}
          {plan.ai.cacheHit ? " · из кэша" : ""}
        </span>

        {plan.status === "needs_confirmation" ? (
          <div className={styles.actions}>
            <button type="button" className="button" onClick={onRevise} disabled={busy}>
              Изменить запрос
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!canConfirm}
              onClick={() => {
                if (confirmationToken && selectedConceptId) {
                  onConfirm([selectedConceptId], confirmationToken);
                }
              }}
            >
              <Check size={15} /> Подтвердить и искать
            </button>
          </div>
        ) : plan.status === "unsupported" ? (
          <button type="button" className="button" onClick={onRevise} disabled={busy}>
            Уточнить формулировку
          </button>
        ) : (
          <span className={styles.safeNote}>
            <Info size={13} aria-hidden="true" />
            В карту передаются только разрешённые категории
          </span>
        )}
      </div>

      {plan.status === "needs_confirmation" && !confirmationToken && (
        <p className={styles.tokenWarning} role="alert">
          Сервер не выдал безопасный токен подтверждения. Измените запрос и повторите
          планирование.
        </p>
      )}
    </section>
  );
}
