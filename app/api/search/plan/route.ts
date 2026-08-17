import {
  createSearchPlanFromEnv,
  isSearchPlannerInfrastructureFailure,
} from "@/lib/search-planner/planner";
import { PlannerInputValidationError } from "@/lib/search-planner/resolver";
import type { PlannerInput } from "@/lib/search-planner/types";
import {
  SearchRuntimeError,
  createSearchRuntime,
  searchDeadlineMsFromEnv,
} from "@/lib/search-runtime";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Некорректный JSON", code: "INVALID_JSON" },
      { status: 400 },
    );
  }

  if (!isRecord(body)) {
    return Response.json(
      {
        error: "Тело запроса должно быть объектом",
        code: "INVALID_SEARCH_PAYLOAD",
      },
      { status: 400 },
    );
  }

  const runtime = createSearchRuntime({
    deadlineMs: searchDeadlineMsFromEnv(),
    parentSignal: request.signal,
  });
  try {
    const plan = await createSearchPlanFromEnv(body as PlannerInput, {
      signal: runtime.signal,
    });
    runtime.throwIfAborted();
    if (isSearchPlannerInfrastructureFailure(plan)) {
      return Response.json(
        {
          error: "Сервис интерпретации запроса временно недоступен. Повторите попытку позже.",
          code: "SEARCH_PLANNER_UNAVAILABLE",
          retryable: true,
          plan,
        },
        { status: 503 },
      );
    }
    return Response.json(plan, {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const runtimeReason = runtime.signal.reason;
    if (runtimeReason instanceof SearchRuntimeError) {
      return Response.json(
        {
          error: runtimeReason.message,
          code: runtimeReason.code,
          retryable: runtimeReason.retryable,
        },
        {
          status:
            runtimeReason.code === "SEARCH_DEADLINE_EXCEEDED" ? 504 : 408,
        },
      );
    }
    if (error instanceof PlannerInputValidationError) {
      return Response.json(
        {
          error: "Параметры поискового намерения некорректны",
          code: error.code,
          details: error.issues.join("; "),
        },
        { status: 400 },
      );
    }
    return Response.json(
      {
        error: "Не удалось безопасно интерпретировать поисковый запрос",
        code: "SEARCH_PLANNER_ERROR",
        retryable: true,
      },
      { status: 503 },
    );
  } finally {
    runtime.dispose();
  }
}
