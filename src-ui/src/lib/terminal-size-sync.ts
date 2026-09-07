export interface TerminalGridSize {
  cols: number;
  rows: number;
}

export type TerminalMeasurement =
  | { visible: false }
  | { visible: true; size: TerminalGridSize | null };

export interface InitialTerminalGrid {
  size: TerminalGridSize;
  measured: boolean;
}

// Keep the existing wide-start default for a hidden terminal or a renderer
// whose font metrics are not ready yet. A later real measurement always wins.
export const DEFAULT_TERMINAL_GRID: TerminalGridSize = { cols: 120, rows: 24 };

const LAYOUT_SETTLE_MS = 100;
const INITIAL_MEASURE_ATTEMPTS = 20;
const MEASUREMENT_RETRY_MS = 2_000;
const RESIZE_RETRY_INITIAL_MS = 100;
const RESIZE_RETRY_MAX_MS = 2_000;

export function createTerminalSizeSync(
  measure: () => TerminalMeasurement,
  resizePty: (size: TerminalGridSize) => Promise<void>,
) {
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let suspended = false;
  let ptyStarted = false;
  let ptyStopped = false;
  let pendingSize: TerminalGridSize | null = null;
  let appliedSize: TerminalGridSize | null = null;
  let resizeInFlight = false;
  let retryDelay = RESIZE_RETRY_INITIAL_MS;
  let initialMeasureAttempts = 0;
  let initialResolved = false;
  let resolveInitial!: (grid: InitialTerminalGrid) => void;
  const initialSize = new Promise<InitialTerminalGrid>((resolve) => {
    resolveInitial = resolve;
  });

  const sameSize = (a: TerminalGridSize | null, b: TerminalGridSize) =>
    a?.cols === b.cols && a.rows === b.rows;

  const clearSettleTimer = () => {
    if (settleTimer === null) return;
    clearTimeout(settleTimer);
    settleTimer = null;
  };

  const clearRetryTimer = () => {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  const settleInitial = (size: TerminalGridSize, measured: boolean) => {
    if (initialResolved) return;
    initialResolved = true;
    resolveInitial({ size, measured });
  };

  const scheduleResizeRetry = () => {
    if (
      disposed || suspended || !ptyStarted || !pendingSize
      || retryTimer !== null
    ) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RESIZE_RETRY_MAX_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void drainResize();
    }, delay);
  };

  const drainResize = async () => {
    if (disposed || suspended || !ptyStarted || resizeInFlight || settleTimer !== null || !pendingSize) return;
    if (sameSize(appliedSize, pendingSize)) {
      pendingSize = null;
      retryDelay = RESIZE_RETRY_INITIAL_MS;
      return;
    }

    const requested = pendingSize;
    pendingSize = null;
    resizeInFlight = true;
    let applied = false;
    try {
      await resizePty(requested);
      if (!disposed && !suspended && ptyStarted) {
        appliedSize = requested;
        retryDelay = RESIZE_RETRY_INITIAL_MS;
        applied = true;
      }
    } catch {
      if (!disposed && !suspended && ptyStarted && settleTimer === null && !pendingSize) {
        pendingSize = requested;
      }
    } finally {
      resizeInFlight = false;
      const shouldContinue = !disposed && !suspended && pendingSize !== null;
      if (shouldContinue) {
        if (applied) void drainResize();
        else scheduleResizeRetry();
      }
    }
  };

  const applyMeasurement = (size: TerminalGridSize) => {
    if (disposed || size.cols <= 0 || size.rows <= 0) return;
    if (!initialResolved) settleInitial(size, true);
    if (!ptyStarted || suspended) return;
    pendingSize = size;
    void drainResize();
  };

  const scheduleMeasurementRetry = () => {
    clearSettleTimer();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      settle();
    }, MEASUREMENT_RETRY_MS);
  };

  const settle = () => {
    if (disposed) return;
    const measurement = measure();
    if (!measurement.visible) {
      suspend();
      return;
    }
    if (!measurement.size) {
      initialMeasureAttempts += 1;
      if (initialMeasureAttempts >= INITIAL_MEASURE_ATTEMPTS) {
        if (!initialResolved) settleInitial(DEFAULT_TERMINAL_GRID, false);
        scheduleMeasurementRetry();
        return;
      }
      schedule(false);
      return;
    }
    initialMeasureAttempts = 0;
    applyMeasurement(measurement.size);
  };

  const schedule = (resetMeasurementAttempts = true) => {
    if (disposed) return;
    const wasSuspended = suspended;
    suspended = false;
    if (resetMeasurementAttempts) initialMeasureAttempts = 0;
    // A new layout event makes any queued measurement obsolete, including
    // one waiting for an earlier IPC request to finish.
    pendingSize = null;
    clearRetryTimer();
    if (wasSuspended && ptyStarted) {
      // A child can change its own winsize while its tab is hidden. Force one
      // write on reveal even when xterm reports the same grid as before.
      appliedSize = null;
      retryDelay = RESIZE_RETRY_INITIAL_MS;
    }
    clearSettleTimer();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      settle();
    }, LAYOUT_SETTLE_MS);
  };

  const suspend = () => {
    if (disposed) return false;
    suspended = true;
    clearSettleTimer();
    clearRetryTimer();
    pendingSize = null;
    initialMeasureAttempts = 0;
    const selectedFallback = !initialResolved;
    settleInitial(DEFAULT_TERMINAL_GRID, false);
    return selectedFallback;
  };

  const markPtyStarted = () => {
    if (disposed || ptyStopped) return;
    ptyStarted = true;
    // Startup scripts may change native winsize after openpty. Let the backend
    // check its actual size once before frontend deduplication takes over.
    appliedSize = null;
    // Spawn is asynchronous; re-measure after it completes so any layout
    // changes during startup are represented by the final geometry only.
    if (!suspended) schedule();
  };

  const markPtyStopped = () => {
    ptyStopped = true;
    ptyStarted = false;
    pendingSize = null;
    clearRetryTimer();
  };

  const dispose = () => {
    disposed = true;
    ptyStarted = false;
    clearSettleTimer();
    clearRetryTimer();
    pendingSize = null;
    settleInitial(DEFAULT_TERMINAL_GRID, false);
  };

  return { initialSize, schedule, suspend, markPtyStarted, markPtyStopped, dispose };
}
