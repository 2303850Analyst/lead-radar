import type { SearchProgressEvent } from "./types";

export type RuntimeTimerHandle = unknown;

export type SearchRuntimeClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): RuntimeTimerHandle;
  clearTimeout(handle: RuntimeTimerHandle): void;
};

const SYSTEM_CLOCK: SearchRuntimeClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const DEFAULT_SEARCH_DEADLINE_MS = 60_000;

export function searchDeadlineMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const parsed = Number(env.SEARCH_REQUEST_DEADLINE_MS);
  return Number.isInteger(parsed) && parsed >= 10 && parsed <= 120_000
    ? parsed
    : DEFAULT_SEARCH_DEADLINE_MS;
}

export class SearchRuntimeError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: "SEARCH_DEADLINE_EXCEEDED" | "SEARCH_CANCELLED",
    message: string,
  ) {
    super(message);
    this.name = "SearchRuntimeError";
    this.retryable = code === "SEARCH_DEADLINE_EXCEEDED";
  }
}

export type SearchRuntimeContext = {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  remainingMs(): number;
  stageTimeoutMs(maximumMs: number, reserveMs?: number): number;
  beginStage(maximumMs: number, reserveMs?: number): SearchStageBudget;
  throwIfAborted(): void;
  cancel(): void;
  dispose(): void;
};

export type SearchStageBudget = {
  readonly deadlineAt: number;
  remainingMs(): number;
  timeoutMs(perCallMaximumMs: number): number;
};

export type CreateSearchRuntimeOptions = {
  deadlineMs?: number;
  parentSignal?: AbortSignal;
  clock?: SearchRuntimeClock;
};

function boundedPositiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function createSearchRuntime(
  options: CreateSearchRuntimeOptions = {},
): SearchRuntimeContext {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const deadlineMs = boundedPositiveInteger(
    options.deadlineMs ?? DEFAULT_SEARCH_DEADLINE_MS,
    DEFAULT_SEARCH_DEADLINE_MS,
  );
  const startedAt = clock.now();
  const deadlineAt = startedAt + deadlineMs;
  const controller = new AbortController();
  let disposed = false;

  const abortWith = (reason: SearchRuntimeError) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const abortFromParent = () =>
    abortWith(new SearchRuntimeError("SEARCH_CANCELLED", "Поиск отменён клиентом"));
  if (options.parentSignal?.aborted) abortFromParent();
  else options.parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const deadlineTimer = clock.setTimeout(
    () =>
      abortWith(
        new SearchRuntimeError(
          "SEARCH_DEADLINE_EXCEEDED",
          "Поиск не завершился в пределах общего лимита времени",
        ),
      ),
    deadlineMs,
  );

  const throwIfAborted = () => {
    if (!controller.signal.aborted) return;
    const reason = controller.signal.reason;
    if (reason instanceof SearchRuntimeError) throw reason;
    throw new SearchRuntimeError("SEARCH_CANCELLED", "Поиск отменён");
  };

  return Object.freeze({
    signal: controller.signal,
    deadlineAt,
    remainingMs: () => Math.max(0, deadlineAt - clock.now()),
    stageTimeoutMs(maximumMs: number, reserveMs = 0) {
      const boundedMaximum = Math.max(0, maximumMs);
      const available = Math.max(0, deadlineAt - clock.now() - Math.max(0, reserveMs));
      return Math.min(boundedMaximum, available);
    },
    beginStage(maximumMs: number, reserveMs = 0) {
      const allocatedMs = Math.min(
        Math.max(0, maximumMs),
        Math.max(0, deadlineAt - clock.now() - Math.max(0, reserveMs)),
      );
      const stageDeadlineAt = clock.now() + allocatedMs;
      return Object.freeze({
        deadlineAt: stageDeadlineAt,
        remainingMs: () => Math.max(0, stageDeadlineAt - clock.now()),
        timeoutMs: (perCallMaximumMs: number) =>
          Math.min(
            Math.max(0, perCallMaximumMs),
            Math.max(0, stageDeadlineAt - clock.now()),
          ),
      });
    },
    throwIfAborted,
    cancel: abortFromParent,
    dispose() {
      if (disposed) return;
      disposed = true;
      clock.clearTimeout(deadlineTimer);
      options.parentSignal?.removeEventListener("abort", abortFromParent);
    },
  });
}

export type ProgressHeartbeat = {
  report(event: SearchProgressEvent): Promise<void>;
  stop(): void;
};

export function createProgressHeartbeat(options: {
  onProgress?: (event: SearchProgressEvent) => void | Promise<void>;
  signal?: AbortSignal;
  intervalMs?: number;
  clock?: SearchRuntimeClock;
}): ProgressHeartbeat {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const intervalMs = boundedPositiveInteger(options.intervalMs ?? 1_500, 1_500);
  let timer: RuntimeTimerHandle | null = null;
  let stopped = false;
  let lastEvent: SearchProgressEvent | null = null;

  const clearTimer = () => {
    if (timer === null) return;
    clock.clearTimeout(timer);
    timer = null;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimer();
    options.signal?.removeEventListener("abort", stop);
  };
  const schedule = () => {
    clearTimer();
    if (stopped || !options.onProgress || !lastEvent || options.signal?.aborted) return;
    timer = clock.setTimeout(() => {
      timer = null;
      if (stopped || options.signal?.aborted || !lastEvent) return;
      const heartbeat: SearchProgressEvent = {
        type: "progress",
        stage: lastEvent.stage,
        status: "running",
        message: "Поиск продолжается",
        timestamp: new Date(clock.now()).toISOString(),
        ...(lastEvent.completed === undefined
          ? {}
          : { completed: lastEvent.completed }),
        ...(lastEvent.total === undefined ? {} : { total: lastEvent.total }),
      };
      void Promise.resolve(options.onProgress?.(heartbeat))
        .catch(() => undefined)
        .finally(schedule);
    }, intervalMs);
  };

  options.signal?.addEventListener("abort", stop, { once: true });
  return Object.freeze({
    async report(event: SearchProgressEvent) {
      if (stopped || options.signal?.aborted) return;
      lastEvent = event;
      await options.onProgress?.(event);
      schedule();
    },
    stop,
  });
}
