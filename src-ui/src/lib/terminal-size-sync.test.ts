import {
  createTerminalSizeSync,
  DEFAULT_TERMINAL_GRID,
  type TerminalGridSize,
  type TerminalMeasurement,
} from './terminal-size-sync';

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(
      `assertion failed: ${message}\n  actual: ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
    );
  }
}

function deepEqual<T>(actual: T, expected: T, message: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `assertion failed: ${message}\n  actual: ${actualJson}\n  expected: ${expectedJson}`,
    );
  }
}

function visible(size: TerminalGridSize): TerminalMeasurement {
  return { visible: true, size };
}

function hidden(): TerminalMeasurement {
  return { visible: false };
}

/** A deterministic clock for the helper's fixed 100 ms trailing timer. */
class FakeClock {
  private now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  set(callback: () => void, delay = 0): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Math.max(0, delay), callback });
    return id;
  }

  clear(id: number): void {
    this.timers.delete(id);
  }

  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId === undefined || nextAt > target) break;
      const timer = this.timers.get(nextId);
      this.timers.delete(nextId);
      this.now = nextAt;
      timer?.callback();
    }
    this.now = target;
  }

  get pending(): number {
    return this.timers.size;
  }
}

async function withFakeClock<T>(run: (clock: FakeClock) => Promise<T>): Promise<T> {
  const globals = globalThis as unknown as {
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
  };
  const originalSetTimeout = globals.setTimeout;
  const originalClearTimeout = globals.clearTimeout;
  const clock = new FakeClock();
  globals.setTimeout = ((handler: () => void, delay?: number) => clock.set(handler, delay)) as typeof globalThis.setTimeout;
  globals.clearTimeout = ((id: number) => clock.clear(id)) as typeof globalThis.clearTimeout;
  try {
    return await run(clock);
  } finally {
    globals.setTimeout = originalSetTimeout;
    globals.clearTimeout = originalClearTimeout;
  }
}

async function microtasks(): Promise<void> {
  // drainResize intentionally awaits the resize IPC promise; two turns cover
  // both that await and the follow-up latest-size drain.
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// A resize storm must produce one trailing measurement and one PTY resize for
// the final geometry, never a resize for an intermediate animation frame.
async function testTrailingLatest(): Promise<void> {
  await withFakeClock(async (clock) => {
    let measurementCalls = 0;
    let current: TerminalMeasurement = visible({ cols: 80, rows: 24 });
    const sent: TerminalGridSize[] = [];
    const sync = createTerminalSizeSync(
      () => {
        measurementCalls += 1;
        return current;
      },
      async (size) => { sent.push({ ...size }); },
    );

    sync.markPtyStarted();
    sync.schedule();
    clock.advance(50);
    current = visible({ cols: 100, rows: 30 });
    sync.schedule();
    clock.advance(99);
    current = visible({ cols: 120, rows: 40 });
    sync.schedule();
    clock.advance(99);
    equal(measurementCalls, 0, 'trailing timer does not run during geometry changes');
    deepEqual(sent, [], 'no intermediate PTY resize is sent');

    clock.advance(1);
    await microtasks();
    equal(measurementCalls, 1, 'only the settled geometry is measured');
    deepEqual(sent, [{ cols: 120, rows: 40 }], 'latest geometry wins');
    sync.dispose();
  });
}

// A genuinely narrow terminal is valid. The coordinator must pass its
// measured grid through unchanged; there is deliberately no width threshold.
async function testLegalNarrowGrid(): Promise<void> {
  await withFakeClock(async (clock) => {
    let current: TerminalMeasurement = visible({ cols: 10, rows: 4 });
    const sent: TerminalGridSize[] = [];
    const sync = createTerminalSizeSync(
      () => current,
      async (size) => { sent.push({ ...size }); },
    );

    sync.schedule();
    clock.advance(100);
    const initial = await sync.initialSize;
    deepEqual(
      initial,
      { size: { cols: 10, rows: 4 }, measured: true },
      'initial narrow size is preserved as a real measurement',
    );

    // Check the native size once after startup, then deduplicate repeats.
    sync.markPtyStarted();
    clock.advance(100);
    await microtasks();
    deepEqual(sent, [initial.size], 'startup checks the real narrow size');
    sync.schedule();
    clock.advance(100);
    await microtasks();
    deepEqual(sent, [initial.size], 'equal narrow size is deduplicated after the startup check');

    // A later narrow resize is still sent exactly as measured.
    current = visible({ cols: 11, rows: 4 });
    sync.schedule();
    clock.advance(100);
    await microtasks();
    deepEqual(sent, [initial.size, { cols: 11, rows: 4 }], 'narrow resize is not replaced by the fallback grid');
    sync.dispose();
  });
}

// Hidden tabs must resolve startup with the explicit fallback without trying
// to fit a display:none element. Once visible, a fresh schedule measures and
// synchronizes the real dimensions.
async function testHiddenFallbackAndReveal(): Promise<void> {
  await withFakeClock(async (clock) => {
    let measurementCalls = 0;
    let isVisible = false;
    const current = { cols: 100, rows: 40 };
    const sent: TerminalGridSize[] = [];
    const sync = createTerminalSizeSync(
      () => {
        measurementCalls += 1;
        return isVisible ? visible(current) : hidden();
      },
      async (size) => { sent.push({ ...size }); },
    );

    equal(DEFAULT_TERMINAL_GRID.cols, 120, 'fallback columns are explicit');
    equal(DEFAULT_TERMINAL_GRID.rows, 24, 'fallback rows are explicit');
    equal(sync.suspend(), true, 'hidden startup chooses fallback');
    deepEqual(
      await sync.initialSize,
      { size: { cols: 120, rows: 24 }, measured: false },
      'hidden startup is explicitly marked as a 120x24 fallback',
    );
    equal(measurementCalls, 0, 'hidden startup never calls fit/measure');
    sync.markPtyStarted();
    await microtasks();
    deepEqual(sent, [], 'hidden note cannot send a resize');

    isVisible = true;
    sync.schedule();
    clock.advance(100);
    await microtasks();
    equal(measurementCalls, 1, 'reveal performs one fresh measure');
    deepEqual(sent, [current], 'reveal synchronizes the current size');

    sync.dispose();
  });
}

// A visible host can still be unmeasurable for a frame while fonts/layout are
// settling. That state must retry rather than selecting the fallback forever.
async function testVisibleMeasurementRetry(): Promise<void> {
  await withFakeClock(async (clock) => {
    let measurementCalls = 0;
    let ready = false;
    const sync = createTerminalSizeSync(
      () => {
        measurementCalls += 1;
        return ready ? visible({ cols: 90, rows: 25 }) : { visible: true, size: null };
      },
      async () => {},
    );

    sync.schedule();
    clock.advance(100);
    await microtasks();
    equal(measurementCalls, 1, 'first visible-but-unmeasurable sample is retried');
    ready = true;
    clock.advance(99);
    equal(measurementCalls, 1, 'retry waits for the full settle interval');
    clock.advance(1);
    deepEqual(
      await sync.initialSize,
      { size: { cols: 90, rows: 25 }, measured: true },
      'retry eventually resolves the measured size',
    );
    equal(measurementCalls, 2, 'successful retry measures once');
    sync.dispose();
  });
}

// The same transient measurement failure can happen after startup (for
// example when a font swap briefly invalidates FitAddon metrics). A running
// PTY must retry a visible null measurement and eventually receive the real
// grid, even without another ResizeObserver event.
async function testStartedVisibleMeasurementRetry(): Promise<void> {
  await withFakeClock(async (clock) => {
    let measurement: TerminalMeasurement = visible({ cols: 80, rows: 24 });
    let measurementCalls = 0;
    const sent: TerminalGridSize[] = [];
    const sync = createTerminalSizeSync(
      () => {
        measurementCalls += 1;
        return measurement;
      },
      async (size) => { sent.push({ ...size }); },
    );
    sync.schedule();
    clock.advance(100);
    await sync.initialSize;
    sync.markPtyStarted();

    measurement = { visible: true, size: null };
    sync.schedule();
    clock.advance(100);
    await microtasks();
    equal(measurementCalls, 2, 'started null measurement is observed');
    deepEqual(sent, [], 'started null measurement sends nothing');

    measurement = visible({ cols: 100, rows: 30 });
    clock.advance(99);
    equal(measurementCalls, 2, 'started retry waits for the settle interval');
    clock.advance(1);
    await microtasks();
    equal(measurementCalls, 3, 'started measurement retries without a new geometry event');
    deepEqual(sent, [{ cols: 100, rows: 30 }], 'started retry synchronizes the recovered size');
    sync.dispose();
  });
}

// Sizes observed while tierTerminalStart is still pending are retained, and
// only the final one is sent after markPtyStarted confirms the PTY exists.
async function testPendingStartLatestSize(): Promise<void> {
  await withFakeClock(async (clock) => {
    let current: TerminalMeasurement = visible({ cols: 80, rows: 24 });
    const sent: TerminalGridSize[] = [];
    const sync = createTerminalSizeSync(
      () => current,
      async (size) => { sent.push({ ...size }); },
    );

    sync.schedule();
    clock.advance(100);
    await sync.initialSize;

    current = visible({ cols: 100, rows: 30 });
    sync.schedule();
    clock.advance(100);
    current = visible({ cols: 120, rows: 40 });
    sync.schedule();
    clock.advance(100);
    await microtasks();
    deepEqual(sent, [], 'pending PTY start suppresses resize IPC');

    sync.markPtyStarted();
    // markPtyStarted schedules a fresh trailing measurement; it must not flush
    // the size observed during the asynchronous spawn immediately.
    deepEqual(sent, [], 'start does not flush an intermediate size immediately');
    clock.advance(100);
    await microtasks();
    deepEqual(sent, [{ cols: 120, rows: 40 }], 'latest pending size is sent after start');
    sync.dispose();
  });
}

// Resize IPC is serialized. If geometry changes while the first request is
// in flight, the next request must use only the newest observed size.
async function testInFlightLatestAndRetry(): Promise<void> {
  await withFakeClock(async (clock) => {
    const first = deferred<void>();
    const second = deferred<void>();
    const requests: TerminalGridSize[] = [];
    let call = 0;
    let current: TerminalMeasurement = visible({ cols: 80, rows: 24 });
    const sync = createTerminalSizeSync(
      () => current,
      (size) => {
        requests.push({ ...size });
        call += 1;
        return call === 1 ? first.promise : second.promise;
      },
    );
    sync.markPtyStarted();

    current = visible({ cols: 100, rows: 30 });
    sync.schedule();
    // The first settled sample starts the first (deliberately unresolved) IPC.
    clock.advance(100);
    deepEqual(requests, [{ cols: 100, rows: 30 }], 'only one resize is in flight');

    // The next two geometry samples arrive while request A is in flight. Only
    // the trailing sample must survive in the pending slot.
    current = visible({ cols: 110, rows: 35 });
    sync.schedule();
    clock.advance(50);
    current = visible({ cols: 120, rows: 40 });
    sync.schedule();
    clock.advance(99);
    deepEqual(requests, [{ cols: 100, rows: 30 }], 'only one resize is in flight');
    clock.advance(1);
    await microtasks();

    first.resolve();
    await microtasks();
    deepEqual(
      requests,
      [{ cols: 100, rows: 30 }, { cols: 120, rows: 40 }],
      'in-flight changes collapse to the newest size',
    );
    second.resolve();
    await microtasks();

    // A failed request is not considered applied. Re-notifying the same size
    // must retry it instead of silently deduplicating it forever.
    const failed = deferred<void>();
    const retry = deferred<void>();
    const retryRequests: TerminalGridSize[] = [];
    let retryCall = 0;
    let retryCurrent: TerminalMeasurement = visible({ cols: 90, rows: 25 });
    const retrySync = createTerminalSizeSync(
      () => retryCurrent,
      (size) => {
        retryRequests.push({ ...size });
        retryCall += 1;
        return retryCall === 1 ? failed.promise : retry.promise;
      },
    );
    retrySync.markPtyStarted();
    retrySync.schedule();
    clock.advance(100);
    failed.reject(new Error('transient resize failure'));
    await microtasks();
    deepEqual(retryRequests, [{ cols: 90, rows: 25 }], 'failed resize remains pending');
    // A fresh trailing measurement of the same size must retry it, rather than
    // being swallowed by the failed request's dedupe state.
    retryCurrent = visible({ cols: 90, rows: 25 });
    retrySync.schedule();
    clock.advance(100);
    await microtasks();
    deepEqual(
      retryRequests,
      [{ cols: 90, rows: 25 }, { cols: 90, rows: 25 }],
      'same size can be retried after failure',
    );
    retry.resolve();
    await microtasks();
    sync.dispose();
    retrySync.dispose();
  });
}

// A transient IPC failure schedules a bounded retry even when no later
// geometry event arrives. The failed size remains pending until success.
async function testAutomaticResizeRetry(): Promise<void> {
  await withFakeClock(async (clock) => {
    const failed = deferred<void>();
    const retried = deferred<void>();
    let call = 0;
    const requests: TerminalGridSize[] = [];
    const sync = createTerminalSizeSync(
      () => visible({ cols: 100, rows: 30 }),
      (size) => {
        requests.push({ ...size });
        call += 1;
        return call === 1 ? failed.promise : retried.promise;
      },
    );
    sync.markPtyStarted();
    sync.schedule();
    clock.advance(100);
    failed.reject(new Error('transient resize failure'));
    await microtasks();
    deepEqual(requests, [{ cols: 100, rows: 30 }], 'initial resize attempted once');

    clock.advance(99);
    await microtasks();
    deepEqual(requests, [{ cols: 100, rows: 30 }], 'retry is delayed, not a tight loop');
    clock.advance(1);
    await microtasks();
    deepEqual(requests, [{ cols: 100, rows: 30 }, { cols: 100, rows: 30 }], 'failed resize is retried automatically');
    retried.resolve();
    await microtasks();
    sync.dispose();
  });
}

// Equal sizes are deduplicated, and disposal cancels queued work and makes all
// later notifications inert.
async function testDedupeAndCleanup(): Promise<void> {
  await withFakeClock(async (clock) => {
    let measurementCalls = 0;
    const current: TerminalMeasurement = visible({ cols: 80, rows: 24 });
    const sent: TerminalGridSize[] = [];
    const sync = createTerminalSizeSync(
      () => {
        measurementCalls += 1;
        return current;
      },
      async (size) => { sent.push({ ...size }); },
    );
    sync.markPtyStarted();

    sync.schedule();
    sync.schedule();
    equal(clock.pending, 1, 'scheduling coalesces to one timer');
    sync.dispose();
    clock.advance(100);
    await microtasks();
    equal(measurementCalls, 0, 'dispose cancels the trailing measure');
    deepEqual(sent, [], 'dispose prevents queued IPC');
    sync.markPtyStarted();
    deepEqual(
      await sync.initialSize,
      { size: DEFAULT_TERMINAL_GRID, measured: false },
      'dispose resolves pending startup with an explicit fallback',
    );
    deepEqual(sent, [], 'notifications after dispose remain inert');

    // Disposal also fences an already-running async IPC call: its late
    // resolution must not publish applied state or trigger a follow-up send.
    const inFlight = deferred<void>();
    const lateRequests: TerminalGridSize[] = [];
    const lateSync = createTerminalSizeSync(
      () => visible({ cols: 100, rows: 30 }),
      (size) => { lateRequests.push({ ...size }); return inFlight.promise; },
    );
    lateSync.markPtyStarted();
    lateSync.schedule();
    clock.advance(100);
    lateSync.dispose();
    inFlight.resolve();
    await microtasks();
    lateSync.schedule();
    deepEqual(lateRequests, [{ cols: 100, rows: 30 }], 'late IPC completion is fenced after dispose');
  });
}

async function testNewGeometryInvalidatesQueuedSize(): Promise<void> {
  await withFakeClock(async (clock) => {
    const first = deferred<void>();
    const requests: TerminalGridSize[] = [];
    let current = { cols: 100, rows: 30 };
    const sync = createTerminalSizeSync(
      () => visible(current),
      (size) => { requests.push({ ...size }); return first.promise; },
    );
    sync.markPtyStarted();
    clock.advance(100);
    current = { cols: 110, rows: 35 };
    sync.schedule();
    clock.advance(100);
    current = { cols: 120, rows: 40 };
    sync.schedule();
    first.resolve();
    await microtasks();
    deepEqual(requests, [{ cols: 100, rows: 30 }], 'new geometry invalidates the older queued measurement');
    clock.advance(100);
    await microtasks();
    deepEqual(requests, [{ cols: 100, rows: 30 }, current], 'next resize waits for a fresh measurement');
    sync.dispose();
  });
}

async function testExitStopsResizeButAllowsMeasurement(): Promise<void> {
  await withFakeClock(async (clock) => {
    const inFlight = deferred<void>();
    let measurements = 0;
    let requests = 0;
    const sync = createTerminalSizeSync(
      () => { measurements += 1; return visible({ cols: 100, rows: 30 }); },
      () => { requests += 1; return inFlight.promise; },
    );
    sync.markPtyStarted();
    clock.advance(100);
    sync.markPtyStopped();
    inFlight.reject(new Error('process exited'));
    await microtasks();
    clock.advance(10_000);
    equal(requests, 1, 'exit prevents retries of an in-flight resize');
    // The exit event can precede the response to the asynchronous start call.
    sync.markPtyStarted();
    sync.schedule();
    clock.advance(100);
    await microtasks();
    equal(requests, 1, 'a late start response cannot reactivate an exited PTY');
    equal(measurements, 2, 'the exited terminal buffer can still fit its container');
    sync.dispose();
  });
}

async function testUnavailableMetricsRecoverAfterFallback(): Promise<void> {
  await withFakeClock(async (clock) => {
    let current: TerminalMeasurement = { visible: true, size: null };
    let measurements = 0;
    const requests: TerminalGridSize[] = [];
    const sync = createTerminalSizeSync(
      () => { measurements += 1; return current; },
      async (size) => { requests.push({ ...size }); },
    );
    sync.schedule();
    clock.advance(2_000);
    const initial = await sync.initialSize;
    deepEqual(initial, { size: DEFAULT_TERMINAL_GRID, measured: false }, 'unavailable metrics do not block startup forever');
    equal(measurements, 20, 'initial measurement attempts are bounded');
    clock.advance(2_000);
    equal(measurements, 21, 'persistent measurement failure uses slower retries');
    clock.advance(1_999);
    equal(measurements, 21, 'slow retry does not resume a rapid measurement loop');
    sync.markPtyStarted();
    current = visible({ cols: 10, rows: 4 });
    clock.advance(100);
    await microtasks();
    deepEqual(requests, [{ cols: 10, rows: 4 }], 'a real small grid replaces fallback after metrics recover');
    sync.dispose();
  });
}

async function testStartupChecksActualPtySize(): Promise<void> {
  await withFakeClock(async (clock) => {
    const measured = { cols: 100, rows: 30 };
    let nativeSize = { cols: 80, rows: 24 }; // Changed by the startup script.
    let requests = 0;
    const sync = createTerminalSizeSync(
      () => visible(measured),
      async (size) => { requests += 1; nativeSize = size; },
    );
    sync.markPtyStarted();
    clock.advance(100);
    await microtasks();
    deepEqual(nativeSize, measured, 'startup checks the backend even when the frontend grid is unchanged');
    equal(requests, 1, 'startup sends one backend check');
    sync.schedule();
    clock.advance(100);
    await microtasks();
    equal(requests, 1, 'successful check enables normal deduplication');
    sync.dispose();
  });
}

export async function main(): Promise<void> {
  await testStartupChecksActualPtySize();
  await testNewGeometryInvalidatesQueuedSize();
  await testExitStopsResizeButAllowsMeasurement();
  await testUnavailableMetricsRecoverAfterFallback();
  await testTrailingLatest();
  await testLegalNarrowGrid();
  await testHiddenFallbackAndReveal();
  await testVisibleMeasurementRetry();
  await testStartedVisibleMeasurementRetry();
  await testPendingStartLatestSize();
  await testInFlightLatestAndRetry();
  await testAutomaticResizeRetry();
  await testDedupeAndCleanup();
  console.log('OK: terminal size settling, narrow grids, hidden reveal, measurement retry, pending start, serialized resize, retry, dedupe, and cleanup');
}
