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
import { useState } from "react";

import type {
  PlanStatus,
  SearchPlan,
  SearchPlanAlternative,
} from "@/lib/search-planner/types";

import styles from "./SearchIntentPanel.module.css";

const STATUS_COPY: Record<
  PlanStatus,
  { label: string; title: string; description: string }
> = {
  ready: {
    label: "Трактовка готова",
    title: "Запрос понятен",
    description: "Смысл запроса проверен — можно переходить к поиску на карте.",
  },
  needs_confirmation: {
    label: "Нужно уточнение",
    title: "Какой бизнес вы имеете в виду?",
    description: "Выберите трактовку. До подтверждения запрос к карте не отправляется.",
  },
  unsupported: {
    label: "Пока нельзя запустить",
    title: "Трактовка готова, стратегия источника — нет",
    description:
      "Мы поняли ваш запрос, но ещё не собрали для него исполняемые параметры карты. Это ограничение текущего компилятора, а не вашей формулировки.",
  },
  degraded: {
    label: "Без AI-проверки",
    title: "Используем известную категорию",
    description:
      "Интеллектуальная проверка временно недоступна, но категория однозначно найдена локальными правилами.",
  },
};

function statusCopyForPlan(plan: SearchPlan) {
  if (
    plan.status === "unsupported" &&
    plan.resolution.reasonCodes.includes("PHYSICAL_PLACE_UNCLEAR")
  ) {
    return {
      label: "Не подходит для поиска мест",
      title: "Запрос не описывает физические организации",
      description:
        "LeadRadar ищет компании и точки на карте. Уточните, какой тип физического бизнеса нужно найти.",
    };
  }
  if (plan.status === "needs_confirmation" && plan.semanticIntent.ambiguity.reason) {
    return {
      ...STATUS_COPY.needs_confirmation,
      title: "Запрос допускает несколько трактовок",
      description: plan.semanticIntent.ambiguity.reason,
    };
  }
  return STATUS_COPY[plan.status];
}

function confidenceLabel(confidence: SearchPlan["resolution"]["confidenceBand"]) {
  if (confidence === "high") return "Высокая уверенность";
  if (confidence === "medium") return "Средняя уверенность";
  if (confidence === "low") return "Низкая уверенность";
  return "Уверенность ещё не определена";
}

function methodLabel(plan: SearchPlan) {
  if (plan.resolution.method === "exact") return "Точное совпадение со словарём";
  if (plan.resolution.method === "semantic") return "Семантическое сопоставление";
  if (
    plan.resolution.method === "kimi" &&
    plan.ai.used &&
    plan.ai.validation === "passed"
  ) {
    return "Проверено Kimi";
  }
  if (plan.resolution.method === "user_confirmed") return "Подтверждено вами";
  return "Безопасный локальный fallback";
}

function retrievalArmLabel(
  type: NonNullable<SearchPlan["executionPreview"]>["retrievalArms"][number]["type"],
) {
  if (type === "precision") return "точный";
  if (type === "recall") return "расширенный";
  if (type === "adjacent") return "смежный";
  if (type === "fallback") return "по названию";
  return "совместимый";
}

export default function SearchIntentPanel({
  plan,
  busy,
  onConfirm,
  onRevise,
}: {
  plan: SearchPlan;
  busy: boolean;
  onConfirm: (
    alternative: SearchPlanAlternative,
    confirmationToken: string,
  ) => void;
  onRevise: () => void;
}) {
  const [selectedAlternativeId, setSelectedAlternativeId] = useState("");
  const statusCopy = statusCopyForPlan(plan);

  const alternatives = plan.resolution.alternatives.slice(0, 3);
  const selectedAlternative = alternatives.find(
    (alternative) => alternative.alternativeId === selectedAlternativeId,
  );
  const confirmationToken = plan.confirmation?.token ?? null;
  const canConfirm = Boolean(selectedAlternative && confirmationToken && !busy);

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
          {confidenceLabel(plan.confidence.intent)}
        </span>
      </div>

      <p className={styles.description}>{statusCopy.description}</p>

      <div className={styles.interpretation}>
        <span>Как сервис понял задачу</span>
        <strong>{plan.semanticIntent.normalizedGoal}</strong>
        <div className={styles.semanticGroups}>
          <SemanticTerms
            label="Основные типы"
            terms={plan.semanticIntent.coreBusinessTypes}
          />
          <SemanticTerms
            label="Смежные типы"
            terms={plan.semanticIntent.adjacentBusinessTypes}
          />
          <SemanticTerms
            label="Исключаем"
            terms={plan.semanticIntent.excludedBusinessTypes}
          />
        </div>
      </div>

      {plan.status === "needs_confirmation" && alternatives.length > 0 && (
        <fieldset className={styles.alternatives}>
          <legend>
            {plan.resolution.clarificationQuestion ?? "Выберите наиболее точный вариант"}
          </legend>
          {alternatives.map((alternative) => (
            <label
              key={alternative.alternativeId}
              className={
                selectedAlternativeId === alternative.alternativeId
                  ? styles.selected
                  : ""
              }
            >
              <input
                type="radio"
                name="semantic-interpretation"
                value={alternative.alternativeId}
                checked={selectedAlternativeId === alternative.alternativeId}
                onChange={() => setSelectedAlternativeId(alternative.alternativeId)}
              />
              <span className={styles.radio} aria-hidden="true" />
              <span className={styles.alternativeCopy}>
                <strong>{alternative.label}</strong>
                <small>{alternative.explanation}</small>
                <small>
                  {alternative.executionPreview.retrievalArms
                    .map(
                      (arm) =>
                        `${retrievalArmLabel(arm.type)} · до ${arm.resultBudget}`,
                    )
                    .join("; ")}
                </small>
              </span>
              <ChevronRight size={17} aria-hidden="true" />
            </label>
          ))}
        </fieldset>
      )}

      {plan.status === "needs_confirmation" && alternatives.length === 0 && (
        <p className={styles.clarificationNote}>
          {plan.semanticIntent.ambiguity.clarificationQuestion ??
            "Уточните формулировку запроса, чтобы выбрать одну трактовку."}
        </p>
      )}

      {plan.executionPreview && (
        <div className={styles.preview}>
          <Sparkles size={15} aria-hidden="true" />
          <span>
            <strong>Что будет искать карта</strong>
            {plan.executionPreview.categoryLabels.length > 0
              ? plan.executionPreview.categoryLabels.join(", ")
              : `${plan.executionPreview.batches} поисковых пакетов`}
            <small>
              Стратегии: {plan.executionPreview.retrievalArms
                .map(
                  (arm) =>
                    `${retrievalArmLabel(arm.type)} · до ${arm.resultBudget}`,
                )
                .join("; ")}
            </small>
          </span>
        </div>
      )}

      <div className={styles.footer}>
        <span className={styles.method}>
          <ShieldCheck size={14} aria-hidden="true" />
          {methodLabel(plan)}
          {plan.ai.cacheHit ? " · из кэша" : ""}
        </span>

        {plan.status === "needs_confirmation" && alternatives.length > 0 ? (
          <div className={styles.actions}>
            <button type="button" className="button" onClick={onRevise} disabled={busy}>
              Изменить запрос
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={!canConfirm}
              onClick={() => {
                if (confirmationToken && selectedAlternative) {
                  onConfirm(selectedAlternative, confirmationToken);
                }
              }}
            >
              <Check size={15} /> Подтвердить и искать
            </button>
          </div>
        ) : plan.status === "needs_confirmation" ? (
          <button type="button" className="button" onClick={onRevise} disabled={busy}>
            Уточнить запрос
          </button>
        ) : plan.status === "unsupported" ? (
          <button type="button" className="button" onClick={onRevise} disabled={busy}>
            Изменить запрос
          </button>
        ) : (
          <span className={styles.safeNote}>
            <Info size={13} aria-hidden="true" />
            Карта получает только параметры, проверенные сервером
          </span>
        )}
      </div>

      {plan.status === "needs_confirmation" && alternatives.length > 0 && !confirmationToken && (
        <p className={styles.tokenWarning} role="alert">
          Сервер не выдал безопасный токен подтверждения. Измените запрос и повторите
          планирование.
        </p>
      )}
    </section>
  );
}

function SemanticTerms({ label, terms }: { label: string; terms: string[] }) {
  if (terms.length === 0) return null;
  return (
    <div className={styles.semanticGroup}>
      <small>{label}</small>
      <div>
        {terms.map((term) => (
          <span key={`${label}:${term}`}>{term}</span>
        ))}
      </div>
    </div>
  );
}
