import type { SearchRuntimeClock, RuntimeTimerHandle } from "../search-runtime";

const SYSTEM_CLOCK: SearchRuntimeClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class KimiSchedulerError extends Error {
  readonly retryable = true;

  constructor(
    readonly code:
      | "KIMI_ADMISSION_TIMEOUT"
      | "KIMI_CIRCUIT_OPEN"
      | "KIMI_ABORTED",
    message: string,
  ) {
    super(message);
    this.name = "KimiSchedulerError";
  }
}

export type KimiSchedulerMetrics = {
  active: 0 | 1;
  queued: number;
  accepted: number;
  started: number;
  completed: number;
  admissionRejected: number;
  admissionTimedOut: number;
  circuitOpened: number;
  circuitState: "closed" | "open" | "half_open";
};

export type Tier0KimiScheduler = {
  run<T>(task: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
  metrics(): KimiSchedulerMetrics;
};

type ScheduledJob<T = unknown> = {
  task: () => Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  admissionTimer: RuntimeTimerHandle | null;
  abortListener: (() => void) | null;
};

export function createTier0KimiScheduler(options: {
  clock?: SearchRuntimeClock;
  minStartIntervalMs?: number;
  admissionTimeoutMs?: number;
  maxQueued?: number;
  circuitFailureThreshold?: number;
  circuitWindowMs?: number;
  circuitOpenMs?: number;
} = {}): Tier0KimiScheduler {
  const clock = options.clock ?? SYSTEM_CLOCK;
  const minStartIntervalMs = Math.max(0, options.minStartIntervalMs ?? 20_000);
  const admissionTimeoutMs = Math.max(1, options.admissionTimeoutMs ?? 20_000);
  const maxQueued = Math.max(0, options.maxQueued ?? 1);
  const failureThreshold = Math.max(1, options.circuitFailureThreshold ?? 3);
  const circuitWindowMs = Math.max(1, options.circuitWindowMs ?? 60_000);
  const circuitOpenMs = Math.max(1, options.circuitOpenMs ?? 60_000);
  const queue: ScheduledJob[] = [];
  const transientFailures: number[] = [];
  let active = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let startTimer: RuntimeTimerHandle | null = null;
  let openUntil = 0;
  let halfOpenProbe = false;
  const counters = {
    accepted: 0,
    started: 0,
    completed: 0,
    admissionRejected: 0,
    admissionTimedOut: 0,
    circuitOpened: 0,
  };

  const circuitState = (): KimiSchedulerMetrics["circuitState"] => {
    if (openUntil > clock.now()) return "open";
    if (openUntil > 0) return "half_open";
    return "closed";
  };

  const clearIdleStartTimer = () => {
    if (queue.length || startTimer === null) return;
    clock.clearTimeout(startTimer);
    startTimer = null;
  };

  const schedulerError = (
    code: KimiSchedulerError["code"],
  ) => new KimiSchedulerError(
    code,
    code === "KIMI_CIRCUIT_OPEN"
      ? "Kimi circuit breaker is open"
      : code === "KIMI_ABORTED"
        ? "Kimi admission was cancelled"
        : "Kimi admission queue is full or expired",
  );

  const cleanupJob = (job: ScheduledJob) => {
    if (job.admissionTimer !== null) clock.clearTimeout(job.admissionTimer);
    job.admissionTimer = null;
    if (job.abortListener) job.signal?.removeEventListener("abort", job.abortListener);
    job.abortListener = null;
  };

  const rejectQueuedForOpenCircuit = () => {
    while (queue.length) {
      const job = queue.shift()!;
      cleanupJob(job);
      job.reject(schedulerError("KIMI_CIRCUIT_OPEN"));
    }
    clearIdleStartTimer();
  };

  const recordFailure = (error: unknown) => {
    if (!(error && typeof error === "object" && "retryable" in error && error.retryable === true)) {
      return;
    }
    const now = clock.now();
    transientFailures.push(now);
    while (transientFailures[0] < now - circuitWindowMs) transientFailures.shift();
    if (transientFailures.length >= failureThreshold) {
      openUntil = now + circuitOpenMs;
      halfOpenProbe = false;
      counters.circuitOpened += 1;
      rejectQueuedForOpenCircuit();
    }
  };

  const finishJob = (error?: unknown) => {
    const finishingHalfOpenProbe = halfOpenProbe;
    active = false;
    halfOpenProbe = false;
    counters.completed += 1;
    if (error === undefined) {
      if (finishingHalfOpenProbe) {
        transientFailures.length = 0;
        openUntil = 0;
      } else {
        const cutoff = clock.now() - circuitWindowMs;
        while (transientFailures[0] < cutoff) transientFailures.shift();
      }
    } else {
      const retryable = Boolean(
        error &&
          typeof error === "object" &&
          "retryable" in error &&
          error.retryable === true,
      );
      if (finishingHalfOpenProbe) {
        if (retryable) {
          transientFailures.push(clock.now());
          openUntil = clock.now() + circuitOpenMs;
          counters.circuitOpened += 1;
          rejectQueuedForOpenCircuit();
        } else {
          transientFailures.length = 0;
          openUntil = 0;
        }
      } else {
        recordFailure(error);
      }
    }
    pump();
  };

  const startJob = (job: ScheduledJob) => {
    cleanupJob(job);
    active = true;
    lastStartedAt = clock.now();
    if (openUntil > 0 && openUntil <= clock.now()) halfOpenProbe = true;
    counters.started += 1;
    void Promise.resolve()
      .then(job.task)
      .then(
        (value) => {
          finishJob();
          job.resolve(value);
        },
        (error) => {
          finishJob(error);
          job.reject(error);
        },
      );
  };

  function pump() {
    if (active || startTimer !== null || !queue.length) return;
    if (openUntil > clock.now()) {
      rejectQueuedForOpenCircuit();
      return;
    }
    const waitMs = Math.max(0, lastStartedAt + minStartIntervalMs - clock.now());
    if (waitMs > 0) {
      startTimer = clock.setTimeout(() => {
        startTimer = null;
        pump();
      }, waitMs);
      return;
    }
    startJob(queue.shift()!);
  }

  return Object.freeze({
    run<T>(task: () => Promise<T>, runOptions: { signal?: AbortSignal } = {}) {
      if (runOptions.signal?.aborted) {
        return Promise.reject(schedulerError("KIMI_ABORTED"));
      }
      if (openUntil > clock.now() || (openUntil > 0 && halfOpenProbe)) {
        counters.admissionRejected += 1;
        return Promise.reject(schedulerError("KIMI_CIRCUIT_OPEN"));
      }
      if ((active || startTimer !== null) && queue.length >= maxQueued) {
        counters.admissionRejected += 1;
        return Promise.reject(schedulerError("KIMI_ADMISSION_TIMEOUT"));
      }
      counters.accepted += 1;
      return new Promise<T>((resolve, reject) => {
        const job: ScheduledJob<T> = {
          task,
          resolve,
          reject,
          signal: runOptions.signal,
          admissionTimer: null,
          abortListener: null,
        };
        job.abortListener = () => {
          const index = queue.indexOf(job as ScheduledJob);
          if (index < 0) return;
          queue.splice(index, 1);
          cleanupJob(job);
          clearIdleStartTimer();
          reject(schedulerError("KIMI_ABORTED"));
        };
        runOptions.signal?.addEventListener("abort", job.abortListener, { once: true });
        queue.push(job as ScheduledJob);
        pump();
        // The pacing timer is registered before the equally-bounded admission
        // timer. A slot becoming available exactly at the 20s boundary wins;
        // otherwise the queued job expires deterministically.
        if (queue.includes(job as ScheduledJob)) {
          job.admissionTimer = clock.setTimeout(() => {
            const index = queue.indexOf(job as ScheduledJob);
            if (index < 0) return;
            const pacingSatisfied =
              !active &&
              index === 0 &&
              lastStartedAt + minStartIntervalMs <= clock.now() &&
              openUntil <= clock.now();
            if (pacingSatisfied) {
              if (startTimer !== null) clock.clearTimeout(startTimer);
              startTimer = null;
              queue.shift();
              startJob(job);
              return;
            }
            queue.splice(index, 1);
            cleanupJob(job);
            clearIdleStartTimer();
            counters.admissionTimedOut += 1;
            reject(schedulerError("KIMI_ADMISSION_TIMEOUT"));
          }, admissionTimeoutMs);
        }
      });
    },
    metrics() {
      return {
        active: active ? 1 : 0,
        queued: queue.length,
        ...counters,
        circuitState: circuitState(),
      };
    },
  });
}
