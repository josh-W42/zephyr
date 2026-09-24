export interface BenchResult {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  hiddenFrames: number;
  valid: boolean;
}

export function summarize(deltas: number[], hiddenFrames: number): BenchResult {
  const s = [...deltas].sort((a, b) => a - b);
  const rank = (p: number) => s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
  return {
    frames: s.length,
    p50: rank(50),
    p95: rank(95),
    p99: rank(99),
    max: s[s.length - 1] ?? 0,
    hiddenFrames,
    valid: s.length > 0 && hiddenFrames === 0,
  };
}

/**
 * Records requestAnimationFrame deltas after a warm-up and resolves once.
 * Read the result once at the end; polling the page mid-run adds main-thread
 * work that shows up as false frame drops.
 */
export function runBench(seconds: number, warmupMs = 3000): Promise<BenchResult> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let hidden = 0;
    let last = 0;
    let end = 0;
    const tick = (t: number) => {
      if (last) {
        deltas.push(t - last);
        if (document.visibilityState !== "visible") hidden++;
      }
      last = t;
      if (t < end) requestAnimationFrame(tick);
      else resolve(summarize(deltas, hidden));
    };
    setTimeout(() => {
      end = performance.now() + seconds * 1000;
      requestAnimationFrame(tick);
    }, warmupMs);
  });
}
