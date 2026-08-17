import assert from "node:assert/strict";
import test from "node:test";

import {
  SearchRuntimeError,
  createProgressHeartbeat,
  createSearchRuntime,
} from "../lib/search-runtime.ts";
import {
  KimiSchedulerError,
  createTier0KimiScheduler,
} from "../lib/search-planner/scheduler.ts";
import {
  createSearchPlan,
  isSearchPlannerInfrastructureFailure,
} from "../lib/search-planner/planner.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();

  const clock = {
    now: () => now,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };

  async function advanceBy(delayMs) {
    const target = now + delayMs;
    while (true) {
      const next = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.callback();
      await Promise.resolve();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
    await Promise.resolve();
  }

  return { clock, advanceBy, pendingTimers: () => timers.size };
}

test("global search runtime caps every stage by the remaining 60 second deadline", async () => {
  const { clock, advanceBy, pendingTimers } = fakeClock();
  const runtime = createSearchRuntime({ deadlineMs: 60_000, clock });

  assert.equal(runtime.remainingMs(), 60_000);
  assert.equal(runtime.stageTimeoutMs(30_000), 30_000);
  const placesStage = runtime.beginStage(7_000, 1_000);
  assert.equal(placesStage.timeoutMs(15_000), 7_000);
  await advanceBy(3_000);
  assert.equal(placesStage.remainingMs(), 4_000);
  assert.equal(placesStage.timeoutMs(15_000), 4_000);
  await advanceBy(42_000);
  assert.equal(runtime.remainingMs(), 15_000);
  assert.equal(runtime.stageTimeoutMs(30_000, 1_000), 14_000);

  await advanceBy(15_000);
  assert.equal(runtime.signal.aborted, true);
  assert.ok(runtime.signal.reason instanceof SearchRuntimeError);
  assert.equal(runtime.signal.reason.code, "SEARCH_DEADLINE_EXCEEDED");
  assert.throws(() => runtime.throwIfAborted(), {
    code: "SEARCH_DEADLINE_EXCEEDED",
  });

  runtime.dispose();
  assert.equal(pendingTimers(), 0);
});

test("progress heartbeat emits at most two seconds apart with controlled clocks", async () => {
  const { clock, advanceBy } = fakeClock();
  const events = [];
  const heartbeat = createProgressHeartbeat({
    clock,
    intervalMs: 2_000,
    onProgress: (event) => events.push(event),
  });

  await heartbeat.report({
    type: "progress",
    stage: "intent_resolution",
    status: "started",
    message: "Начали",
    timestamp: new Date(0).toISOString(),
  });
  await advanceBy(1_999);
  assert.equal(events.length, 1);
  await advanceBy(1);
  assert.equal(events.length, 2);
  assert.equal(events[1].stage, "intent_resolution");
  assert.equal(events[1].status, "running");
  assert.equal(events[1].message, "Поиск продолжается");

  heartbeat.stop();
  await advanceBy(4_000);
  assert.equal(events.length, 2);
});

test("heartbeat SLO holds for at least 99 percent of 100 controlled long runs", async () => {
  let compliant = 0;
  for (let run = 0; run < 100; run += 1) {
    const { clock, advanceBy } = fakeClock();
    const timestamps = [];
    const heartbeat = createProgressHeartbeat({
      clock,
      intervalMs: 2_000,
      onProgress: (event) => timestamps.push(Date.parse(event.timestamp)),
    });
    await heartbeat.report({
      type: "progress",
      stage: "places",
      status: "started",
      message: "Начали",
      timestamp: new Date(0).toISOString(),
    });
    await advanceBy(6_000);
    heartbeat.stop();
    const gaps = timestamps.slice(1).map((value, index) => value - timestamps[index]);
    if (gaps.length >= 3 && Math.max(...gaps) <= 2_000) compliant += 1;
  }
  assert.ok(compliant >= 99, `heartbeat compliant runs: ${compliant}/100`);
});

test("Tier-0 Kimi scheduler runs one job, queues one and rejects overflow", async () => {
  const { clock } = fakeClock();
  const scheduler = createTier0KimiScheduler({
    clock,
    minStartIntervalMs: 0,
    admissionTimeoutMs: 20_000,
  });
  const first = deferred();
  const second = deferred();
  const firstRun = scheduler.run(() => first.promise);
  const secondRun = scheduler.run(() => second.promise);

  await assert.rejects(
    scheduler.run(async () => "never"),
    (error) =>
      error instanceof KimiSchedulerError &&
      error.code === "KIMI_ADMISSION_TIMEOUT" &&
      error.retryable === true,
  );

  first.resolve("first");
  assert.equal(await firstRun, "first");
  second.resolve("second");
  assert.equal(await secondRun, "second");
  assert.deepEqual(scheduler.metrics(), {
    active: 0,
    queued: 0,
    accepted: 2,
    started: 2,
    completed: 2,
    admissionRejected: 1,
    admissionTimedOut: 0,
    circuitOpened: 0,
    circuitState: "closed",
  });
});

test("Tier-0 Kimi admission timeout uses controlled clocks and never starts the expired job", async () => {
  const { clock, advanceBy } = fakeClock();
  const scheduler = createTier0KimiScheduler({
    clock,
    minStartIntervalMs: 0,
    admissionTimeoutMs: 20_000,
  });
  const first = deferred();
  const firstRun = scheduler.run(() => first.promise);
  let queuedStarted = false;
  const queuedRun = scheduler.run(async () => {
    queuedStarted = true;
    return "queued";
  });

  await advanceBy(20_000);
  await assert.rejects(queuedRun, {
    code: "KIMI_ADMISSION_TIMEOUT",
  });
  assert.equal(queuedStarted, false);
  first.resolve("first");
  await firstRun;
  assert.equal(scheduler.metrics().admissionTimedOut, 1);
});

test("Tier-0 pacing slot still permits only one queued Kimi job", async () => {
  const { clock, advanceBy } = fakeClock();
  const scheduler = createTier0KimiScheduler({
    clock,
    minStartIntervalMs: 20_000,
    admissionTimeoutMs: 20_000,
  });
  assert.equal(await scheduler.run(async () => "first"), "first");
  const queued = scheduler.run(async () => "second");
  await assert.rejects(scheduler.run(async () => "overflow"), {
    code: "KIMI_ADMISSION_TIMEOUT",
  });
  await advanceBy(20_000);
  assert.equal(await queued, "second");
});

test("cancelling the only queued Kimi job clears its pacing and admission waits", async () => {
  const { clock, pendingTimers } = fakeClock();
  const scheduler = createTier0KimiScheduler({
    clock,
    minStartIntervalMs: 20_000,
    admissionTimeoutMs: 20_000,
  });
  assert.equal(await scheduler.run(async () => "first"), "first");
  const controller = new AbortController();
  const queued = scheduler.run(async () => "never", {
    signal: controller.signal,
  });
  assert.equal(pendingTimers(), 2);
  controller.abort();
  await assert.rejects(queued, { code: "KIMI_ABORTED" });
  assert.equal(pendingTimers(), 0);
});

test("a queued Kimi job starts when pacing and admission become due together", async () => {
  const { clock, advanceBy } = fakeClock();
  const scheduler = createTier0KimiScheduler({
    clock,
    minStartIntervalMs: 20_000,
    admissionTimeoutMs: 20_000,
  });
  const firstGate = deferred();
  const first = scheduler.run(() => firstGate.promise);
  const second = scheduler.run(async () => "second");
  await advanceBy(10_000);
  firstGate.resolve("first");
  assert.equal(await first, "first");
  await advanceBy(10_000);
  assert.equal(await second, "second");
  assert.equal(scheduler.metrics().admissionTimedOut, 0);
});

test("Kimi circuit breaker opens after bounded transient failures without retaining payloads", async () => {
  const { clock } = fakeClock();
  const scheduler = createTier0KimiScheduler({
    clock,
    minStartIntervalMs: 0,
    circuitFailureThreshold: 2,
    circuitWindowMs: 60_000,
    circuitOpenMs: 60_000,
  });
  const transient = Object.assign(new Error("secret raw payload"), {
    retryable: true,
  });

  await assert.rejects(scheduler.run(async () => { throw transient; }));
  await assert.rejects(scheduler.run(async () => { throw transient; }));
  await assert.rejects(
    scheduler.run(async () => "never"),
    (error) =>
      error instanceof KimiSchedulerError &&
      error.code === "KIMI_CIRCUIT_OPEN",
  );

  const serialized = JSON.stringify(scheduler.metrics());
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("payload"), false);
  assert.equal(scheduler.metrics().circuitState, "open");
  assert.equal(scheduler.metrics().circuitOpened, 1);
});

test("Kimi circuit breaker counts transient failures across successful jobs inside its window", async () => {
  const { clock } = fakeClock();
  const scheduler = createTier0KimiScheduler({
    clock,
    minStartIntervalMs: 0,
    circuitFailureThreshold: 2,
    circuitWindowMs: 60_000,
    circuitOpenMs: 60_000,
  });
  const transient = Object.assign(new Error("transient"), { retryable: true });
  await assert.rejects(scheduler.run(async () => { throw transient; }));
  assert.equal(await scheduler.run(async () => "healthy"), "healthy");
  await assert.rejects(scheduler.run(async () => { throw transient; }));
  assert.equal(scheduler.metrics().circuitState, "open");
});

test("default Tier-0 circuit opens within its 20-second pacing and 60-second window", async () => {
  const { clock, advanceBy } = fakeClock();
  const scheduler = createTier0KimiScheduler({ clock });
  const transient = Object.assign(new Error("transient"), { retryable: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await advanceBy(20_000);
    await assert.rejects(scheduler.run(async () => { throw transient; }));
  }
  assert.equal(scheduler.metrics().circuitOpened, 1);
  assert.equal(scheduler.metrics().circuitState, "open");
});

test("a failed half-open Kimi probe immediately reopens the circuit", async () => {
  const { clock, advanceBy } = fakeClock();
  const scheduler = createTier0KimiScheduler({
    clock,
    minStartIntervalMs: 0,
    circuitFailureThreshold: 1,
    circuitWindowMs: 10,
    circuitOpenMs: 20,
  });
  const transient = Object.assign(new Error("transient"), { retryable: true });
  await assert.rejects(scheduler.run(async () => { throw transient; }));
  await advanceBy(20);
  assert.equal(scheduler.metrics().circuitState, "half_open");
  await assert.rejects(scheduler.run(async () => { throw transient; }));
  assert.equal(scheduler.metrics().circuitState, "open");
  await assert.rejects(scheduler.run(async () => "must not start"), {
    code: "KIMI_CIRCUIT_OPEN",
  });
});

test("scheduler overflow becomes a stable retryable planner outcome, not semantic unsupported", async () => {
  const { clock } = fakeClock();
  const scheduler = createTier0KimiScheduler({
    clock,
    minStartIntervalMs: 0,
    admissionTimeoutMs: 20_000,
  });
  const controllers = [new AbortController(), new AbortController()];
  let invocation = 0;
  const client = {
    modelId: "kimi-test",
    encode({ signal }) {
      return scheduler.run(
        async () => await new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new KimiSchedulerError("KIMI_ABORTED", "cancelled")),
            { once: true },
          );
        }),
        { signal },
      );
    },
  };
  const input = {
    description: "неизвестная новая ниша",
    primaryQuery: "неизвестная новая ниша",
    relatedQueries: [],
    excludeQueries: [],
    location: "Москва",
    radiusKm: 5,
    services: [],
    locale: "ru-RU",
    countryCodes: ["RU"],
  };
  const start = (controller) => {
    invocation += 1;
    return createSearchPlan(input, {
      mode: "kimi",
      kimiClient: client,
      signal: controller.signal,
    });
  };
  const first = start(controllers[0]);
  const second = start(controllers[1]);
  for (let tick = 0; scheduler.metrics().accepted < 2 && tick < 50; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(scheduler.metrics().accepted, 2);
  const overflow = await createSearchPlan(input, {
    mode: "kimi",
    kimiClient: client,
  });

  assert.equal(invocation, 2);
  assert.equal(overflow.status, "unsupported");
  assert.ok(overflow.resolution.reasonCodes.includes("KIMI_ADMISSION_TIMEOUT"));
  assert.equal(isSearchPlannerInfrastructureFailure(overflow), true);

  controllers.forEach((controller) => controller.abort());
  await Promise.allSettled([first, second]);
});
