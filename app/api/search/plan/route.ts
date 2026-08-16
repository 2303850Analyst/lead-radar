import {
  createSearchPlanFromEnv,
  isSearchPlannerInfrastructureFailure,
} from "@/lib/search-planner/planner";
import { PlannerInputValidationError } from "@/lib/search-planner/resolver";
import type { PlannerInput } from "@/lib/search-planner/types";

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

  try {
    const plan = await createSearchPlanFromEnv(body as PlannerInput, {
      signal: request.signal,
    });
    if (isSearchPlannerInfrastructureFailure(plan)) {
      return Response.json(
        {
          error: "Сервис интерпретации запроса временно недоступен. Повторите попытку позже.",
          code: "SEARCH_PLANNER_UNAVAILABLE",
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
      },
      { status: 503 },
    );
  }
}
