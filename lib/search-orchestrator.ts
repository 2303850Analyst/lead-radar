import type { SearchProgressCallback } from "./providers/types";
import type { SearchRuntimeContext } from "./search-runtime";
import type { SearchPlan } from "./search-planner/types";
import type {
  SearchPayload,
  SearchProgressEvent,
  SearchResponse,
} from "./types";

export type SearchExecutionProvider = "demo" | "geoapify" | "yandex";

export type SearchExecutionOptions = {
  onProgress?: SearchProgressCallback;
  signal?: AbortSignal;
  runtime?: SearchRuntimeContext;
};

export type PreparedProviderSearch = {
  completedMessage: string;
  execute(
    payload: SearchPayload,
    options: SearchExecutionOptions,
  ): Promise<SearchResponse>;
};

export type SearchExecutionAdapter = {
  preparationMessage: string;
  prepare(plan: SearchPlan): Promise<PreparedProviderSearch>;
};

export type SearchOrchestratorDependencies = {
  verifyGeography(
    payload: SearchPayload,
    signal?: AbortSignal,
  ): Promise<SearchPayload>;
  createPlan(payload: SearchPayload, signal?: AbortSignal): Promise<SearchPlan>;
  confirmPlan(payload: SearchPayload): Promise<SearchPlan>;
  isPlannerInfrastructureFailure(plan: SearchPlan): boolean;
  selectProvider(): SearchExecutionProvider;
  providers: Record<SearchExecutionProvider, SearchExecutionAdapter>;
};

export type SearchOrchestrator = {
  search(
    payload: SearchPayload,
    options?: SearchExecutionOptions,
  ): Promise<SearchResponse>;
};

export class SearchPlanOutcomeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "SEARCH_PLAN_CONFIRMATION_REQUIRED"
      | "SEARCH_PLAN_UNSUPPORTED"
      | "SEARCH_PLANNER_UNAVAILABLE",
    readonly status: 409 | 422 | 503,
    readonly plan?: SearchPlan,
  ) {
    super(message);
    this.name = "SearchPlanOutcomeError";
  }
}

async function emitProgress(
  onProgress: SearchProgressCallback | undefined,
  event: Omit<SearchProgressEvent, "type" | "timestamp">,
) {
  await onProgress?.({
    type: "progress",
    ...event,
    timestamp: new Date().toISOString(),
  });
}

function ensureExecutablePlan(
  plan: SearchPlan,
  isPlannerInfrastructureFailure: (plan: SearchPlan) => boolean,
) {
  if (isPlannerInfrastructureFailure(plan)) {
    throw new SearchPlanOutcomeError(
      "Сервис интерпретации запроса временно недоступен. Повторите поиск позже.",
      "SEARCH_PLANNER_UNAVAILABLE",
      503,
      plan,
    );
  }
  if (plan.status === "needs_confirmation") {
    throw new SearchPlanOutcomeError(
      "Нужно подтвердить категорию до обращения к карте",
      "SEARCH_PLAN_CONFIRMATION_REQUIRED",
      409,
      plan,
    );
  }
  if (plan.status === "unsupported") {
    throw new SearchPlanOutcomeError(
      "Смысл запроса понятен, но исполняемая стратегия источника пока не готова",
      "SEARCH_PLAN_UNSUPPORTED",
      422,
      plan,
    );
  }
  if (!plan.executionPreview || plan.executionPreview.batches < 1) {
    throw new SearchPlanOutcomeError(
      "Не удалось безопасно подготовить стратегию поиска",
      "SEARCH_PLAN_UNSUPPORTED",
      422,
      plan,
    );
  }
}

export function createSearchOrchestrator(
  dependencies: SearchOrchestratorDependencies,
): SearchOrchestrator {
  return Object.freeze({
    async search(
      initialPayload: SearchPayload,
      options: SearchExecutionOptions = {},
    ): Promise<SearchResponse> {
      const { onProgress, runtime } = options;
      const signal = runtime?.signal ?? options.signal;
      runtime?.throwIfAborted();

      await emitProgress(onProgress, {
        stage: "intent_resolution",
        status: "started",
        message:
          initialPayload.confirmedAlternative ||
          initialPayload.confirmedConceptIds?.length
          ? "Проверяем выбранную трактовку"
          : "Систематизируем бизнес-намерение пользователя",
      });

      const hasConfirmation = Boolean(
        initialPayload.confirmationToken &&
          (initialPayload.confirmedAlternative ||
            initialPayload.confirmedConceptIds?.length),
      );
      const plan = hasConfirmation
        ? await dependencies.confirmPlan(initialPayload)
        : await dependencies.createPlan(initialPayload, signal);

      runtime?.throwIfAborted();

      await emitProgress(onProgress, {
        stage: "intent_resolution",
        status: "completed",
        message:
          plan.status === "ready"
            ? "Смысл запроса и стратегия поиска определены"
            : plan.status === "degraded"
              ? "Используем безопасную локальную трактовку"
              : plan.status === "needs_confirmation"
                ? "Требуется выбор трактовки"
                : "Смысл понятен, но исполняемая стратегия пока не готова",
      });

      ensureExecutablePlan(plan, dependencies.isPlannerInfrastructureFailure);

      // Semantic acceptance is deliberately completed before any provider-backed
      // geography lookup. Ambiguous or tampered requests must not consume map
      // quota before the user selects a signed interpretation.
      const payload = await dependencies.verifyGeography(initialPayload, signal);
      runtime?.throwIfAborted();

      const providerId = dependencies.selectProvider();
      const provider = dependencies.providers[providerId];
      await emitProgress(onProgress, {
        stage: "provider_compilation",
        status: "started",
        message: provider.preparationMessage,
      });

      const prepared = await provider.prepare(plan);
      runtime?.throwIfAborted();

      await emitProgress(onProgress, {
        stage: "provider_compilation",
        status: "completed",
        message: prepared.completedMessage,
      });

      const response = await prepared.execute(payload, {
        onProgress,
        signal,
        runtime,
      });
      runtime?.throwIfAborted();
      return { ...response, plan };
    },
  });
}
